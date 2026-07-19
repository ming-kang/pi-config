import * as fs from "node:fs";
import * as path from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	type AgentToolResult,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { describeToolCall, summarizeToolResult } from "./activity.ts";
import { discoverAgents } from "./agents.ts";
import {
	getSubagentUserConfigPath,
	loadSubagentUserConfig,
	saveSubagentUserConfig,
} from "./config.ts";
import {
	ACTIVITY_MAX_CHARS,
	ACTIVITY_MAX_ITEMS,
	COMPLETION_OUTPUT_CHARS,
	DEFAULT_MAX_AGENTS,
	DEFAULT_MAX_CONCURRENCY,
	HARD_MAX_AGENTS,
	HARD_MAX_CONCURRENCY,
	PANEL_RENDER_THROTTLE_MS,
	READ_OUTPUT_CHARS,
	SUBAGENT_CONFIG_ENTRY_TYPE,
	SUBAGENT_NOTIFICATION_TYPE,
	SUBAGENT_PREVIEW_KEY,
	SUBAGENT_STATUS_KEY,
	SUBAGENT_USER_CONFIG_VERSION,
	TIMELINE_MAX_CHARS,
	TIMELINE_MAX_ITEMS,
} from "./constants.ts";
import {
	createWorkerId,
	formatDuration,
	formatStatuslineSummary,
	statuslineTone,
	formatTokens,
	isTerminalStatus,
	oneLine,
	truncateText,
} from "./format.ts";
import { panelOverlayOptions, SubagentPanel } from "./panel.ts";
import type {
	AgentScope,
	SubagentParams,
	SubagentTaskParams,
	ThinkingLevelName,
} from "./schema.ts";
import type {
	AgentDefinition,
	AgentDiscoveryResult,
	PendingRun,
	ProfilePreference,
	SubagentConfig,
	SubagentDetails,
	SubagentLaunchSpec,
	SubagentPanelHost,
	SubagentRecord,
	SubagentSnapshot,
	SubagentStatus,
	SubagentUsage,
	SubagentUserConfig,
	TimelineItem,
	ToolActivity,
	TimelineKind,
} from "./types.ts";

const BUILTIN_TOOLS = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
]);

/** True when candidate is parentCwd or a path under it (Windows-safe). */
function isPathInsideParent(parentCwd: string, candidate: string): boolean {
	const parent = path.resolve(parentCwd);
	const resolved = path.resolve(candidate);
	const rel = path.relative(parent, resolved);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function emptyUsage(): SubagentUsage {
	return {
		turns: 0,
		toolUses: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
}

function assistantText(message: AgentMessage | undefined): string {
	if (!message || message.role !== "assistant") return "";
	return message.content
		.filter(
			(
				part,
			): part is Extract<(typeof message.content)[number], { type: "text" }> =>
				part.type === "text",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function latestAssistantMessage(
	messages: AgentMessage[],
): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant") return message as AssistantMessage;
	}
	return undefined;
}

/**
 * Slim custom system prompt for workers. Via Pi's resource loader this becomes
 * buildSystemPrompt({ customPrompt }), so the heavy default pi assistant
 * template (docs paths, etc.) is not included — only this text plus optional
 * project_context / skills from the loader.
 */
function makeWorkerSystemPrompt(agent: AgentDefinition): string {
	const role = agent.systemPrompt.trim();
	return [
		`You are Pi background subagent "${agent.name}", a focused worker for one concrete task.`,
		"Stay inside the assigned working directory and the task scope. Report a clear result for the parent agent.",
		"Do not ask the end user questions. If blocked, state the exact blocker and the decision the parent must make.",
		"Do not spawn additional subagents; you are already the delegated execution context.",
		role,
	]
		.filter(Boolean)
		.join("\n\n");
}

function cloneConfig(config: SubagentConfig): SubagentConfig {
	return { maxConcurrency: config.maxConcurrency, maxAgents: config.maxAgents };
}

interface CompletionNotice {
	id: string;
	label: string;
	agentName: string;
	status: SubagentStatus;
	task: string;
	lastOutput: string;
	error?: string;
	usage: SubagentUsage;
	startedAt?: number;
	endedAt?: number;
}

interface CompletionGroup {
	id: string;
	memberIds: string[];
	settled: Map<string, CompletionNotice>;
}

export class SubagentController implements SubagentPanelHost {
	private readonly pi: ExtensionAPI;
	private readonly records = new Map<string, SubagentRecord>();
	private readonly queue: string[] = [];
	private config: SubagentConfig = {
		maxConcurrency: DEFAULT_MAX_CONCURRENCY,
		maxAgents: DEFAULT_MAX_AGENTS,
	};
	private ctx: ExtensionContext | undefined;
	private nextCompletionGroupId = 1;
	private readonly completionGroups = new Map<string, CompletionGroup>();
	private activeRuns = 0;
	private pumping = false;
	private disposed = false;
	private panelOpen = false;
	private panel: SubagentPanel | undefined;
	private panelRenderTimer: ReturnType<typeof setTimeout> | undefined;
	private lastPanelRenderAt = 0;
	private preferencesLoaded = false;
	private userConfig: SubagentUserConfig = {
		version: SUBAGENT_USER_CONFIG_VERSION,
		profiles: {},
	};
	/** Shared across all workers so runtime provider registrations resolve once. */
	private modelRuntimePromise: Promise<ModelRuntime> | undefined;
	/** Ids replayed into the shared runtime, for mirrored unregistration. */
	private readonly replayedProviderIds = new Set<string>();
	/** SettingsManager per cwd, shared by a worker's loader and its session. */
	private readonly settingsManagers = new Map<string, SettingsManager>();
	/** ResourceLoader per (cwd, agent identity, systemPrompt); reload is expensive. */
	private readonly loaders = new Map<string, Promise<DefaultResourceLoader>>();
	/** Lazily rebuilt snapshot list; invalidated on any record mutation. */
	private snapshotsCache: SubagentSnapshot[] | undefined;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	bindContext(
		ctx: ExtensionContext,
		persistedConfig?: Partial<SubagentConfig>,
	): void {
		this.ctx = ctx;
		this.disposed = false;
		this.invalidateSnapshots();
		if (persistedConfig) this.applyConfig(persistedConfig, false);
		// Clear legacy always-on preview widgets from earlier builds.
		if (ctx.hasUI && ctx.mode === "tui") {
			ctx.ui.setWidget(SUBAGENT_STATUS_KEY, undefined);
			ctx.ui.setWidget(SUBAGENT_PREVIEW_KEY, undefined);
		}
		this.syncStatusline();
	}

	/** Worker the user most likely wants to inspect first. */
	mostRelevantId(): string | undefined {
		const records = [...this.records.values()];
		const score = (record: SubagentRecord): number =>
			(record.unread ? 2 : 0) +
			(record.status === "running" || record.status === "starting" ? 1 : 0);
		records.sort(
			(first, second) =>
				score(second) - score(first) || second.updatedAt - first.updatedAt,
		);
		return records[0]?.id;
	}

	getConfig(): SubagentConfig {
		return cloneConfig(this.config);
	}

	getSnapshots(): SubagentSnapshot[] {
		// Cached and returned by reference: callers treat the array and its
		// snapshots as immutable. snapshot() deep-copies each record, and every
		// record mutation path invalidates this cache (see invalidateSnapshots
		// call sites), so pure animation frames reuse one stable array.
		if (!this.snapshotsCache) {
			this.snapshotsCache = [...this.records.values()].map((record) =>
				this.snapshot(record),
			);
		}
		return this.snapshotsCache;
	}

	private invalidateSnapshots(): void {
		this.snapshotsCache = undefined;
	}

	/** Lightweight worker facts for /agents argument completion (no snapshot build). */
	getCompletionWorkers(): Array<{
		id: string;
		label: string;
		status: SubagentStatus;
		agentName: string;
	}> {
		return [...this.records.values()].map((record) => ({
			id: record.id,
			label: record.label,
			status: record.status,
			agentName: record.agentName,
		}));
	}

	/** Cwd of the currently bound session context, for completion-time discovery. */
	getBoundCwd(): string | undefined {
		return this.ctx?.cwd;
	}

	async loadPreferences(ctx?: ExtensionContext): Promise<void> {
		if (this.preferencesLoaded) return;
		this.preferencesLoaded = true;
		try {
			this.userConfig = await loadSubagentUserConfig();
		} catch (error) {
			this.userConfig = { version: SUBAGENT_USER_CONFIG_VERSION, profiles: {} };
			if (ctx?.hasUI) {
				ctx.ui.notify(
					`Could not load subagent settings: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		}
	}

	/** Root `/agents` menu: profiles, limits, clear, stop-all. */
	async openSettingsRoot(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("/agents requires an interactive UI.", "warning");
			return;
		}
		this.bindContext(ctx);
		await this.loadPreferences(ctx);
		while (true) {
			const profilesItem = "Profile settings…";
			const limitsItem = `Limits… (concurrency ${this.config.maxConcurrency}, retain ${this.config.maxAgents})`;
			const clearItem = "Clear finished workers…";
			const stopItem = "Stop all running";
			const doneItem = "Done";
			const action = await ctx.ui.select("Subagent settings", [
				profilesItem,
				limitsItem,
				clearItem,
				stopItem,
				doneItem,
			]);
			if (!action || action === doneItem) return;
			if (action === profilesItem) {
				await this.openSettingsMenu(ctx);
				continue;
			}
			if (action === limitsItem) {
				await this.openLimitsMenu(ctx);
				continue;
			}
			if (action === clearItem) {
				try {
					ctx.ui.notify(this.clearAgents(undefined), "info");
				} catch (error) {
					ctx.ui.notify(
						error instanceof Error ? error.message : String(error),
						"warning",
					);
				}
				continue;
			}
			if (action === stopItem) {
				const active = [...this.records.values()].filter(
					(r) =>
						r.status === "queued" ||
						r.status === "starting" ||
						r.status === "running",
				);
				if (!active.length) {
					ctx.ui.notify("No running or queued workers.", "info");
					continue;
				}
				const ok = await ctx.ui.confirm(
					"Stop all subagents?",
					`Stops ${active.length} worker${active.length === 1 ? "" : "s"} and notifies the parent.`,
				);
				if (!ok) continue;
				for (const record of active) {
					try {
						await this.stopAgent(record.id);
					} catch {
						// Best-effort.
					}
				}
				ctx.ui.notify(`Stopped ${active.length} worker(s).`, "info");
			}
		}
	}

	async openSettingsMenu(
		ctx: ExtensionContext,
		requestedAgent?: string,
	): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify(
				"/agents settings requires an interactive UI.",
				"warning",
			);
			return;
		}
		await this.loadPreferences(ctx);
		const discovery = discoverAgents(ctx.cwd, "both");
		let agentName = requestedAgent?.trim();
		if (
			agentName &&
			!discovery.agents.some((agent) => agent.name === agentName)
		) {
			ctx.ui.notify(`Unknown subagent profile: ${agentName}`, "warning");
			return;
		}
		if (!agentName) {
			const labels = new Map<string, string>();
			for (const agent of discovery.agents) {
				labels.set(
					`${agent.name} — ${agent.source}: ${agent.description}`,
					agent.name,
				);
			}
			const selected = await ctx.ui.select("Configure subagent profile", [
				...labels.keys(),
			]);
			if (!selected) return;
			agentName = labels.get(selected);
		}
		if (!agentName) return;

		while (true) {
			const preference = this.userConfig.profiles[agentName] ?? {};
			const modelDisplay =
				preference.model ?? "agent default (built-ins inherit)";
			const thinkingDisplay =
				preference.thinkingLevel ?? "agent default (built-ins inherit)";
			const modelItem = `Model · ${modelDisplay}`;
			const thinkingItem = `Thinking · ${thinkingDisplay}`;
			const resetItem = "Reset saved overrides";
			const doneItem = "Done";
			const action = await ctx.ui.select(`Subagent profile: ${agentName}`, [
				modelItem,
				thinkingItem,
				resetItem,
				doneItem,
			]);
			if (!action || action === doneItem) return;

			if (action === modelItem) {
				const choices = new Map<string, string | undefined>();
				choices.set(
					"inherit — use the parent session model at spawn time",
					"inherit",
				);
				choices.set(
					"agent default — clear the saved model override",
					undefined,
				);
				for (const model of ctx.modelRegistry.getAvailable()) {
					const spec = `${model.provider}/${model.id}`;
					choices.set(`${spec} — ${model.name ?? model.id}`, spec);
				}
				const selected = await ctx.ui.select(`Model for ${agentName}`, [
					...choices.keys(),
				]);
				if (!selected) continue;
				this.updateProfilePreference(agentName, {
					model: choices.get(selected),
				});
				await this.savePreferences(ctx);
				continue;
			}

			if (action === thinkingItem) {
				const choices = new Map<
					string,
					ThinkingLevelName | "inherit" | undefined
				>([
					[
						"inherit — use the parent session thinking level at spawn time",
						"inherit",
					],
					["agent default — clear the saved thinking override", undefined],
					["off", "off"],
					["minimal", "minimal"],
					["low", "low"],
					["medium", "medium"],
					["high", "high"],
					["xhigh", "xhigh"],
					["max", "max"],
				]);
				const selected = await ctx.ui.select(
					`Thinking level for ${agentName}`,
					[...choices.keys()],
				);
				if (!selected) continue;
				this.updateProfilePreference(agentName, {
					thinkingLevel: choices.get(selected),
				});
				await this.savePreferences(ctx);
				continue;
			}

			if (action === resetItem) {
				delete this.userConfig.profiles[agentName];
				await this.savePreferences(ctx);
			}
		}
	}

	async openLimitsMenu(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("/agents limits requires an interactive UI.", "warning");
			return;
		}
		while (true) {
			const concurrencyItem = `Max concurrency · ${this.config.maxConcurrency}`;
			const retainedItem = `Retained agents · ${this.config.maxAgents}`;
			const doneItem = "Done";
			const action = await ctx.ui.select("Subagent deployment limits", [
				concurrencyItem,
				retainedItem,
				doneItem,
			]);
			if (!action || action === doneItem) return;

			if (action === concurrencyItem) {
				const value = await ctx.ui.select(
					"Maximum concurrent subagents",
					Array.from({ length: HARD_MAX_CONCURRENCY }, (_, index) =>
						String(index + 1),
					),
				);
				if (!value) continue;
				const text = this.configureLimits(Number(value), undefined);
				ctx.ui.notify(text, "info");
				continue;
			}

			const value = await ctx.ui.select(
				"Maximum retained subagent records",
				Array.from({ length: HARD_MAX_AGENTS }, (_, index) =>
					String(index + 1),
				),
			);
			if (!value) continue;
			const text = this.configureLimits(undefined, Number(value));
			ctx.ui.notify(text, "info");
		}
	}

	/** Whether an id maps to a retained record. */
	hasAgent(id: string): boolean {
		return this.records.has(id);
	}

	markViewed(id: string): void {
		const record = this.records.get(id);
		if (!record || !record.unread) return;
		record.unread = false;
		this.stateChanged();
	}

	async sendInstruction(
		id: string,
		message: string | undefined,
		fresh = false,
	): Promise<string> {
		return this.sendAgent(id, message, fresh);
	}

	/**
	 * Open the interactive fleet panel (transcript + steer/stop).
	 * Used by Alt+O — capturing overlay like a focused Pi session view.
	 */
	async openPanel(ctx: ExtensionContext, initialId?: string): Promise<void> {
		this.bindContext(ctx);
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Subagent panel requires the Pi TUI.", "warning");
			return;
		}
		if (this.records.size === 0) {
			ctx.ui.notify("No subagents running. Spawn one first.", "info");
			return;
		}
		if (this.panelOpen) {
			ctx.ui.notify("Subagent panel is already open.", "info");
			return;
		}

		this.panelOpen = true;
		try {
			const startId = initialId ?? this.mostRelevantId();
			let overlayTui: TUI | undefined;
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					overlayTui = tui;
					const panel = new SubagentPanel({
						tui,
						theme,
						host: this,
						done: () => done(undefined),
						...(startId ? { initialId: startId } : {}),
					});
					this.panel = panel;
					return panel;
				},
				{
					overlay: true,
					overlayOptions: () =>
						panelOverlayOptions(
							overlayTui?.terminal.columns ??
								process.stdout.columns ??
								80,
							overlayTui?.terminal.rows ?? process.stdout.rows ?? 24,
						),
				},
			);
		} finally {
			this.cancelPanelRenderTimer();
			this.panel?.dispose();
			this.panel = undefined;
			this.panelOpen = false;
		}
	}

	async execute(
		params: SubagentParams,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<SubagentDetails>> {
		this.bindContext(ctx);
		await this.loadPreferences(ctx);
		const action = params.action ?? "spawn";
		switch (action) {
			case "spawn":
				return this.spawn(params, ctx);
			case "read":
				return this.readResult(params.id);
			case "send":
				return this.sendResult(params.id, params.message, params.fresh ?? false);
			case "stop":
				return this.stopResult(params.id);
		}
	}

	private async sendAgent(
		id: string,
		message: string | undefined,
		fresh: boolean,
	): Promise<string> {
		const record = this.requireRecord(id);
		const instruction = message?.trim();
		if (fresh || record.status === "failed" || record.status === "stopped") {
			return this.restartAgent(id, instruction);
		}
		if (!instruction) {
			throw new Error(
				`${record.id} is ${record.status}; send requires a message unless fresh=true or the worker is failed/stopped. Example: { action:"send", id:"${record.id}", message:"..." }`,
			);
		}

		if (record.status === "queued" || record.status === "starting") {
			record.pendingInstructions.push(instruction);
			this.addTimeline(record, "user", instruction);
			record.updatedAt = Date.now();
			this.requestPanelRender();
			return `Attached — delivered when ${record.id} starts.`;
		}

		if (record.status === "running") {
			if (!record.session)
				throw new Error(`${record.id} is still initializing.`);
			this.addTimeline(record, "user", instruction);
			record.updatedAt = Date.now();
			// Always steer: deliver after the current tool batch (human UI and model agree).
			await record.session.steer(instruction);
			this.requestPanelRender();
			return `Sent — ${record.id} sees it after the current tool batch.`;
		}

		this.enqueueRun(record, { prompt: instruction, fresh: false });
		return `Continuing — ${record.id} resumes its conversation.`;
	}

	private async restartAgent(id: string, message?: string): Promise<string> {
		const record = this.requireRecord(id);
		if (
			record.status === "queued" ||
			record.status === "starting" ||
			record.status === "running"
		) {
			await this.stopAgent(id);
		}
		record.pendingInstructions = [];
		const prompt = message?.trim() || record.task;
		this.addTimeline(
			record,
			"system",
			"Fresh rerun requested with a new isolated context.",
		);
		this.enqueueRun(record, { prompt, fresh: true });
		return `Rerunning ${record.id} with a fresh context.`;
	}

	async stopAgent(id: string): Promise<string> {
		const record = this.requireRecord(id);
		if (record.status === "queued") {
			const completionGroupId = record.pendingRun?.completionGroupId;
			this.removeFromQueue(record.id);
			record.pendingRun = undefined;
			record.pendingInstructions = [];
			record.status = "stopped";
			record.endedAt = Date.now();
			record.updatedAt = Date.now();
			record.unread = true;
			this.addTimeline(record, "system", "Stopped before execution started.");
			this.stateChanged();
			// Always notify so the parent need not poll (batch settles when all members finish).
			this.settleCompletion(record, completionGroupId, true);
			return `${record.id} removed from the queue.`;
		}

		if (record.status === "starting" || record.status === "running") {
			const completionGroupId = record.currentCompletionGroupId;
			record.generation++;
			record.status = "stopped";
			record.endedAt = Date.now();
			record.updatedAt = Date.now();
			record.currentActivity = undefined;
			record.pendingRun = undefined;
			record.pendingInstructions = [];
			record.unread = true;
			this.addTimeline(record, "system", "Stopped by the parent session.");
			this.stateChanged();
			this.settleCompletion(record, completionGroupId, true);
			try {
				await record.session?.abort();
			} catch {
				// The run finalizer owns any remaining cleanup.
			}
			return `${record.id} stopped.`;
		}

		return `${record.id} is already ${record.status}.`;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.queue.length = 0;
		this.completionGroups.clear();
		this.cancelPanelRenderTimer();
		this.panel = undefined;
		this.panelOpen = false;
		if (this.ctx?.hasUI) {
			this.ctx.ui.setStatus(SUBAGENT_STATUS_KEY, undefined);
			if (this.ctx.mode === "tui") {
				this.ctx.ui.setWidget(SUBAGENT_STATUS_KEY, undefined);
				this.ctx.ui.setWidget(SUBAGENT_PREVIEW_KEY, undefined);
			}
		}

		await Promise.all(
			[...this.records.values()].map(async (record) => {
				record.generation++;
				try {
					await record.session?.abort();
				} catch {
					// Shutdown is best-effort.
				}
				record.unsubscribe?.();
				record.unsubscribe = undefined;
				record.session?.dispose();
				record.session = undefined;
			}),
		);
		// Drop all cross-worker caches; a revived session rebuilds them cheaply
		// and picks up any on-disk settings/model/agent changes made meanwhile.
		this.loaders.clear();
		this.settingsManagers.clear();
		this.modelRuntimePromise = undefined;
		this.replayedProviderIds.clear();
		this.snapshotsCache = undefined;
	}

	private async spawn(
		params: SubagentParams,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<SubagentDetails>> {
		const tasks = this.normalizeSpawnTasks(params);
		if ("error" in tasks)
			return this.errorResult("spawn", "invalid_parameters", tasks.error);
		const scope = params.agentScope ?? "user";
		const discovery = discoverAgents(ctx.cwd, scope);
		const prepared = this.prepareLaunchSpecs(tasks, scope, discovery, ctx);
		if ("error" in prepared)
			return this.errorResult("spawn", prepared.code, prepared.error);

		const projectAgents = prepared.specs
			.map((spec) => spec.agentDefinition)
			.filter((agent) => agent.source === "project");
		// Project definitions are repo-controlled; always require interactive confirm.
		// The model cannot disable this gate.
		if (projectAgents.length) {
			if (!ctx.hasUI) {
				return this.errorResult(
					"spawn",
					"no_ui",
					"Project-local agents require interactive confirmation. Retry in an interactive UI, or use agentScope \"user\" with built-in/user profiles only.",
				);
			}
			const names = [...new Set(projectAgents.map((agent) => agent.name))].join(
				", ",
			);
			const approved = await ctx.ui.confirm(
				"Run project-local subagents?",
				`Agents: ${names}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}\n\nThese prompts are controlled by the repository and can use coding tools. Continue only for a trusted project.`,
			);
			if (!approved)
				return this.errorResult(
					"spawn",
					"not_approved",
					"Project-local subagents were not approved.",
				);
		}

		const targetMaxAgents = Math.max(
			1,
			Math.min(HARD_MAX_AGENTS, this.config.maxAgents),
		);
		const capacity = this.makeRoomForSpawn(tasks.length, targetMaxAgents);
		if ("error" in capacity) {
			return this.errorResult("spawn", "max_agents", capacity.error);
		}

		const spawned: SubagentRecord[] = [];
		for (const preparedSpec of prepared.specs) {
			const id = createWorkerId();
			const now = Date.now();
			const record: SubagentRecord = {
				...preparedSpec.spec,
				id,
				agentDefinition: preparedSpec.agentDefinition,
				status: "queued",
				createdAt: now,
				updatedAt: now,
				generation: 0,
				runCount: 0,
				unread: false,
				lastOutput: "",
				liveText: "",
				activities: [],
				omittedActivities: 0,
				timeline: [],
				usage: emptyUsage(),
				pendingInstructions: [],
				resolvedModel: preparedSpec.resolvedModel,
			};
			this.records.set(id, record);
			spawned.push(record);
		}

		const completionGroupId =
			spawned.length > 1
				? `batch-${String(this.nextCompletionGroupId++).padStart(2, "0")}`
				: undefined;
		if (completionGroupId) {
			this.completionGroups.set(completionGroupId, {
				id: completionGroupId,
				memberIds: spawned.map((record) => record.id),
				settled: new Map(),
			});
		}
		for (const record of spawned) {
			this.enqueueRun(record, {
				prompt: record.task,
				fresh: true,
				...(completionGroupId ? { completionGroupId } : {}),
			});
		}

		const text = [
			`Spawned ${spawned.length} background subagent${spawned.length === 1 ? "" : "s"}; the call returns before they finish.`,
			...spawned.map(
				(record) =>
					`- ${record.id} [${record.status}] ${record.label} (${record.agentName}) — ${oneLine(record.task, 180)}`,
			),
			capacity.evicted.length
				? `Reclaimed ${capacity.evicted.length} terminal record${capacity.evicted.length === 1 ? "" : "s"}: ${capacity.evicted.join(", ")}.`
				: "",
			completionGroupId
				? "One combined completion follow-up will arrive after the batch settles. Do not poll."
				: "Completion will arrive automatically as a parent follow-up. Do not poll.",
		]
			.filter(Boolean)
			.join("\n");
		return this.result("spawn", text, spawned);
	}

	private normalizeSpawnTasks(
		params: SubagentParams,
	): SubagentTaskParams[] | { error: string } {
		const hasBatch = Boolean(params.tasks?.length);
		const singlePrompt =
			params.prompt?.trim() || params.task?.trim() || "";
		const hasSingle = Boolean(singlePrompt);
		if (hasBatch === hasSingle) {
			return {
				error:
					'spawn requires exactly one of prompt/task (single) or tasks (batch). Example: { agent:"explorer", description:"auth map", prompt:"..." }',
			};
		}
		if (params.tasks) {
			return params.tasks.map((task) => this.normalizeTaskEntry(task));
		}
		return [
			this.normalizeTaskEntry({
				prompt: singlePrompt,
				task: singlePrompt,
				...(params.agent ? { agent: params.agent } : {}),
				...(params.description
					? { description: params.description }
					: params.label
						? { label: params.label }
						: {}),
				...(params.model ? { model: params.model } : {}),
				...(params.cwd ? { cwd: params.cwd } : {}),
				...(params.thinking
					? { thinking: params.thinking }
					: params.thinkingLevel
						? { thinkingLevel: params.thinkingLevel }
						: {}),
			}),
		];
	}

	/** Normalize prompt/description/thinking aliases onto task + label + thinkingLevel. */
	private normalizeTaskEntry(task: SubagentTaskParams): SubagentTaskParams {
		const prompt = task.prompt?.trim() || task.task?.trim() || "";
		const description = task.description?.trim() || task.label?.trim();
		const thinking = task.thinking ?? task.thinkingLevel;
		return {
			task: prompt,
			prompt,
			...(task.agent ? { agent: task.agent } : {}),
			...(description ? { description, label: description } : {}),
			...(task.model ? { model: task.model } : {}),
			...(task.cwd ? { cwd: task.cwd } : {}),
			...(thinking ? { thinking, thinkingLevel: thinking } : {}),
		};
	}

	private prepareLaunchSpecs(
		tasks: SubagentTaskParams[],
		scope: AgentScope,
		discovery: AgentDiscoveryResult,
		ctx: ExtensionContext,
	):
		| {
				specs: Array<{
					spec: SubagentLaunchSpec;
					agentDefinition: AgentDefinition;
					resolvedModel?: Model<Api>;
				}>;
		  }
		| { error: string; code: string } {
		const specs: Array<{
			spec: SubagentLaunchSpec;
			agentDefinition: AgentDefinition;
			resolvedModel?: Model<Api>;
		}> = [];

		for (const task of tasks) {
			const agentName = task.agent?.trim() || "general";
			const agentDefinition = discovery.agents.find(
				(agent) => agent.name === agentName,
			);
			if (!agentDefinition) {
				const available =
					discovery.agents
						.map((agent) => `${agent.name} (${agent.source})`)
						.join(", ") || "none";
				return {
					error: `Unknown agent "${agentName}". Available: ${available}.`,
					code: "unknown_agent",
				};
			}

			const parentCwd = path.resolve(ctx.cwd);
			const cwd = path.resolve(parentCwd, task.cwd?.trim() || ".");
			if (!isPathInsideParent(parentCwd, cwd)) {
				return {
					error: `Subagent cwd must stay inside the parent session working directory (${parentCwd}). Use a relative path under that tree.`,
					code: "invalid_cwd",
				};
			}
			try {
				if (!fs.statSync(cwd).isDirectory()) {
					return {
						error: `Subagent cwd is not a directory: ${cwd}`,
						code: "invalid_cwd",
					};
				}
			} catch {
				return {
					error: `Subagent cwd does not exist: ${cwd}`,
					code: "invalid_cwd",
				};
			}

			// Capability comes only from the agent profile / Markdown definition —
			// callers cannot escalate tools via the tool arguments.
			const tools = agentDefinition.tools;
			if (tools) {
				const unsupported = tools.filter((tool) => !BUILTIN_TOOLS.has(tool));
				if (unsupported.length) {
					return {
						error: `Agent "${agentName}" declares unsupported tools: ${unsupported.join(", ")}. Allowed built-ins: ${[...BUILTIN_TOOLS].join(", ")}.`,
						code: "unsupported_tools",
					};
				}
			}

			const preference = this.userConfig.profiles[agentName];
			const explicitModel = task.model?.trim();
			const hasExplicitModel =
				task.model !== undefined && Boolean(explicitModel);
			const hasPreferredModel = Boolean(
				preference && Object.hasOwn(preference, "model"),
			);
			let modelSetting: string | undefined;
			if (hasExplicitModel) modelSetting = explicitModel;
			else if (hasPreferredModel) modelSetting = preference?.model;
			else modelSetting = agentDefinition.model;
			const forceInheritedModel = modelSetting === "inherit";
			const modelSpec = forceInheritedModel ? undefined : modelSetting;
			let resolvedModel: Model<Api> | undefined;
			try {
				resolvedModel = forceInheritedModel
					? ctx.model
					: this.resolveModel(modelSpec, ctx);
			} catch (error) {
				return {
					error: error instanceof Error ? error.message : String(error),
					code: "invalid_model",
				};
			}

			const parentThinking = this.pi.getThinkingLevel();
			const hasPreferredThinking = Boolean(
				preference && Object.hasOwn(preference, "thinkingLevel"),
			);
			const taskThinking = task.thinkingLevel ?? task.thinking;
			let thinkingLevel: ThinkingLevelName;
			if (taskThinking === "inherit") thinkingLevel = parentThinking;
			else if (taskThinking) thinkingLevel = taskThinking;
			else if (hasPreferredThinking) {
				const preferredThinking = preference?.thinkingLevel;
				thinkingLevel =
					preferredThinking === "inherit" || preferredThinking === undefined
						? parentThinking
						: preferredThinking;
			} else {
				thinkingLevel = agentDefinition.thinkingLevel ?? parentThinking;
			}

			const taskText = (task.task ?? task.prompt ?? "").trim();
			const label =
				oneLine(
					task.description?.trim() || task.label?.trim() || taskText,
					48,
				) || agentName;
			specs.push({
				spec: {
					task: taskText,
					agentName,
					label,
					...(modelSpec ? { model: modelSpec } : {}),
					...(tools ? { tools: [...new Set(tools)] } : {}),
					cwd,
					thinkingLevel,
					agentScope: scope,
				},
				agentDefinition,
				resolvedModel,
			});
		}
		return { specs };
	}

	private resolveModel(
		spec: string | undefined,
		ctx: ExtensionContext,
	): Model<Api> | undefined {
		if (!spec) return ctx.model;
		const available = ctx.modelRegistry.getAvailable();
		const slash = spec.indexOf("/");
		if (slash > 0) {
			const provider = spec.slice(0, slash);
			const modelId = spec.slice(slash + 1);
			const exact = ctx.modelRegistry.find(provider, modelId);
			if (!exact || !ctx.modelRegistry.hasConfiguredAuth(exact)) {
				throw new Error(
					`Model "${spec}" was not found with configured authentication.`,
				);
			}
			return exact;
		}

		const matches = available.filter(
			(model) => model.id === spec || model.name === spec,
		);
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) {
			const sameProvider = matches.find(
				(model) => model.provider === ctx.model?.provider,
			);
			if (sameProvider) return sameProvider;
			throw new Error(
				`Model "${spec}" is ambiguous. Use provider/model: ${matches.map((model) => `${model.provider}/${model.id}`).join(", ")}.`,
			);
		}
		throw new Error(
			`Model "${spec}" was not found among models with configured authentication.`,
		);
	}

	private enqueueRun(record: SubagentRecord, run: PendingRun): void {
		this.removeFromQueue(record.id);
		record.pendingRun = run;
		record.status = "queued";
		record.error = undefined;
		record.endedAt = undefined;
		record.updatedAt = Date.now();
		record.unread = false;
		this.queue.push(record.id);
		this.stateChanged();
		void this.pumpQueue();
	}

	private async pumpQueue(): Promise<void> {
		if (this.pumping || this.disposed) return;
		this.pumping = true;
		try {
			while (
				!this.disposed &&
				this.activeRuns < this.config.maxConcurrency &&
				this.queue.length
			) {
				const id = this.queue.shift();
				if (!id) break;
				const record = this.records.get(id);
				const run = record?.pendingRun;
				if (!record || record.status !== "queued" || !run) continue;
				record.pendingRun = undefined;
				this.activeRuns++;
				void this.executeQueuedRun(record, run).finally(() => {
					this.activeRuns = Math.max(0, this.activeRuns - 1);
					this.stateChanged();
					void this.pumpQueue();
				});
			}
		} finally {
			this.pumping = false;
		}
	}

	private async executeQueuedRun(
		record: SubagentRecord,
		run: PendingRun,
	): Promise<void> {
		const generation = ++record.generation;
		record.currentCompletionGroupId = run.completionGroupId;
		record.status = "starting";
		record.startedAt = Date.now();
		record.updatedAt = Date.now();
		record.currentActivity = "Starting isolated AgentSession...";
		record.runCount++;
		record.unread = false;
		if (run.fresh) {
			this.releaseSession(record);
			record.usage = emptyUsage();
			record.lastOutput = "";
			record.liveText = "";
			record.error = undefined;
		}
		this.addTimeline(record, "user", run.prompt);
		this.stateChanged();

		try {
			if (!record.session) await this.createSession(record, generation);
			if (this.disposed || record.generation !== generation) return;

			const deferred = record.pendingInstructions.splice(0);
			const prompt = [
				run.prompt,
				...deferred.map(
					(item) => `Additional parent instruction: ${item}`,
				),
			].join("\n\n");
			const session = record.session;
			if (!session)
				throw new Error(`Failed to initialize AgentSession for ${record.id}.`);
			record.status = "running";
			record.currentActivity = "Waiting for the model...";
			record.resolvedModel = session.model ?? record.resolvedModel;
			this.stateChanged();

			await session.prompt(prompt, { expandPromptTemplates: false });
			if (this.disposed || record.generation !== generation) return;

			const finalMessage = latestAssistantMessage(session.messages);
			const failed =
				finalMessage?.stopReason === "error" ||
				finalMessage?.stopReason === "aborted";
			record.status = failed ? "failed" : "completed";
			record.error = failed
				? finalMessage?.errorMessage ||
					record.error ||
					`Subagent stopped with ${finalMessage?.stopReason ?? "an error"}.`
				: undefined;
			record.endedAt = Date.now();
			record.updatedAt = Date.now();
			record.currentActivity = undefined;
			record.unread = true;
			this.stateChanged();
			this.settleCompletion(record, run.completionGroupId, true);
		} catch (error) {
			if (this.disposed || record.generation !== generation) return;
			const message = error instanceof Error ? error.message : String(error);
			record.status = "failed";
			record.error = message;
			record.endedAt = Date.now();
			record.updatedAt = Date.now();
			record.currentActivity = undefined;
			record.liveText = "";
			record.unread = true;
			this.addTimeline(record, "error", message);
			this.stateChanged();
			this.settleCompletion(record, run.completionGroupId, true);
		}
	}

	/** SettingsManager.create per cwd; the loader and session share one instance. */
	private settingsManagerFor(cwd: string): SettingsManager {
		const existing = this.settingsManagers.get(cwd);
		if (existing) return existing;
		const created = SettingsManager.create(cwd, getAgentDir());
		this.settingsManagers.set(cwd, created);
		return created;
	}

	/** Cached, reloaded ResourceLoader keyed by cwd + agent identity + prompt. */
	private loaderFor(record: SubagentRecord): Promise<DefaultResourceLoader> {
		const agent = record.agentDefinition;
		// systemPrompt and loader flags are part of the key so definition edits
		// and omitContextFiles do not reuse a stale loader.
		const key = [
			record.cwd,
			agent.name,
			agent.source,
			agent.systemPrompt,
			agent.omitContextFiles ? "1" : "0",
		].join("\0");
		const existing = this.loaders.get(key);
		if (existing) return existing;
		const promise = (async () => {
			const loader = new DefaultResourceLoader({
				cwd: record.cwd,
				agentDir: getAgentDir(),
				// Block recursive extension tools (including this one) and keep
				// workers lean: no skills/prompt-templates/themes by default.
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				// Explorer (and similar) skip AGENTS.md injection to save tokens;
				// general keeps project context for implementation fidelity.
				noContextFiles: Boolean(agent.omitContextFiles),
				settingsManager: this.settingsManagerFor(record.cwd),
				// Replace loader system prompt with a slim worker role. Optional
				// on-disk SYSTEM.md is dropped for workers; project_context still
				// comes from context files when noContextFiles is false.
				systemPromptOverride: () => makeWorkerSystemPrompt(agent),
			});
			await loader.reload();
			return loader;
		})().catch((error) => {
			// Drop a failed loader so the next spawn retries, but only if a newer
			// attempt has not already replaced this cache slot.
			if (this.loaders.get(key) === promise) this.loaders.delete(key);
			throw error;
		});
		this.loaders.set(key, promise);
		return promise;
	}

	/** Lazily create one shared ModelRuntime for all workers, mirroring sdk defaults. */
	private ensureModelRuntime(): Promise<ModelRuntime> {
		const existing = this.modelRuntimePromise;
		if (existing) return existing;
		const promise = ModelRuntime.create({
			authPath: path.join(getAgentDir(), "auth.json"),
			modelsPath: path.join(getAgentDir(), "models.json"),
		}).catch((error) => {
			if (this.modelRuntimePromise === promise) this.modelRuntimePromise = undefined;
			throw error;
		});
		this.modelRuntimePromise = promise;
		return promise;
	}

	/**
	 * Replay the parent session's dynamically registered providers into the
	 * shared runtime so custom/proxy models resolve for workers. Registrations
	 * are validate-then-merge (idempotent); each id is isolated so one bad
	 * provider cannot block the rest. Two limitations: providers registered as a
	 * native pi-ai Provider object are not exposed by this API surface (only the
	 * config form is replayable), and runtime-only api keys (setRuntimeApiKey)
	 * live in the parent runtime's memory and cannot be replayed — such workers
	 * fall back to disk auth.
	 */
	private replayProviderRegistrations(runtime: ModelRuntime): void {
		const registry = this.ctx?.modelRegistry;
		if (!registry) return;
		const currentIds = new Set<string>();
		for (const id of registry.getRegisteredProviderIds()) {
			currentIds.add(id);
			try {
				const config = registry.getRegisteredProviderConfig(id);
				if (config) runtime.registerProvider(id, config);
				this.replayedProviderIds.add(id);
			} catch {
				// A provider that conflicts with builtins/models.json will surface a
				// clean spawn error when its model fails to resolve; skip it here.
			}
		}
		// Mirror parent unregistrations so the shared runtime keeps no ghosts.
		for (const id of [...this.replayedProviderIds]) {
			if (currentIds.has(id)) continue;
			try {
				runtime.unregisterProvider(id);
			} catch {
				// Best-effort cleanup.
			}
			this.replayedProviderIds.delete(id);
		}
	}

	private async createSession(
		record: SubagentRecord,
		generation: number,
	): Promise<void> {
		if (!this.modelRuntimePromise) {
			// Only the very first spawn pays the runtime bootstrap (may include a
			// one-time model-catalog refresh); surface it instead of stalling.
			record.currentActivity = "Preparing model runtime...";
		}
		const runtime = await this.ensureModelRuntime();
		// Replay before createAgentSession: resolvedModel is resolved against the
		// parent registry, but auth is resolved in the shared runtime by provider id.
		this.replayProviderRegistrations(runtime);
		const loader = await this.loaderFor(record);

		const { session } = await createAgentSession({
			cwd: record.cwd,
			agentDir: getAgentDir(),
			modelRuntime: runtime,
			...(record.resolvedModel ? { model: record.resolvedModel } : {}),
			...(record.thinkingLevel ? { thinkingLevel: record.thinkingLevel } : {}),
			...(record.tools ? { tools: record.tools } : {}),
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(record.cwd),
			settingsManager: this.settingsManagerFor(record.cwd),
		});

		if (this.disposed || record.generation !== generation) {
			// A dispose/stop/restart raced this build. A newer run may already own
			// record.session, so never mount or release through the record here —
			// just drop the session this call created.
			session.dispose();
			return;
		}

		record.session = session;
		record.resolvedModel = session.model ?? record.resolvedModel;
		const boundSession = session;
		record.unsubscribe = session.subscribe((event) => {
			if (this.disposed || record.session !== boundSession) return;
			this.handleSessionEvent(record, event);
		});
	}

	private handleSessionEvent(
		record: SubagentRecord,
		event: AgentSessionEvent,
	): void {
		record.updatedAt = Date.now();
		// updatedAt mutates on every event, including types with no branch below.
		this.invalidateSnapshots();
		switch (event.type) {
			case "message_update":
				if (event.assistantMessageEvent.type === "text_delta") {
					record.liveText += event.assistantMessageEvent.delta;
					if (record.liveText.length > READ_OUTPUT_CHARS * 2) {
						record.liveText = `[earlier streaming text omitted]\n${record.liveText.slice(-READ_OUTPUT_CHARS * 2)}`;
					}
					record.currentActivity = "Writing response...";
					this.requestPanelRender();
				} else if (
					event.assistantMessageEvent.type === "thinking_delta" &&
					record.currentActivity !== "Thinking..."
				) {
					// Thinking output is not accumulated; just surface that the worker
					// is reasoning so the activity line does not stall pre-response.
					record.currentActivity = "Thinking...";
					this.requestPanelRender();
				}
				break;

			case "message_end":
				if (event.message.role === "assistant") {
					const message = event.message as AssistantMessage;
					const text = assistantText(event.message);
					if (text) {
						record.lastOutput = text;
						this.addTimeline(record, "assistant", text);
					}
					record.liveText = "";
					record.usage.input += message.usage?.input ?? 0;
					record.usage.output += message.usage?.output ?? 0;
					record.usage.cacheRead += message.usage?.cacheRead ?? 0;
					record.usage.cacheWrite += message.usage?.cacheWrite ?? 0;
					record.usage.totalTokens =
						message.usage?.totalTokens ?? record.usage.totalTokens;
					record.usage.cost += message.usage?.cost?.total ?? 0;
					if (message.stopReason === "error" && message.errorMessage)
						record.error = message.errorMessage;
					this.requestPanelRender();
				}
				break;

			case "turn_end":
				if (event.message.role === "assistant") record.usage.turns++;
				this.requestPanelRender(true);
				break;

			case "tool_execution_start":
				this.startToolActivity(
					record,
					event.toolCallId,
					event.toolName,
					event.args,
				);
				record.usage.toolUses++;
				this.requestPanelRender(true);
				break;

			case "tool_execution_update":
				// The structured activity created at tool start remains the stable
				// preview while streaming updates arrive.
				this.requestPanelRender();
				break;

			case "tool_execution_end":
				this.finishToolActivity(
					record,
					event.toolCallId,
					event.result,
					event.isError,
				);
				this.requestPanelRender(true);
				break;

			case "auto_retry_start":
				record.currentActivity = `Retrying request (attempt ${event.attempt})...`;
				this.addTimeline(record, "system", record.currentActivity);
				this.requestPanelRender(true);
				break;

			case "auto_retry_end":
				// Clear the "Retrying..." activity the start event set. Terminal
				// status/error stay owned by the run finalizer (stopReason), never here.
				if (event.success) {
					record.currentActivity = "Waiting for the model...";
					this.addTimeline(
						record,
						"system",
						`Retry succeeded (attempt ${event.attempt}).`,
					);
				} else {
					record.currentActivity = undefined;
					this.addTimeline(
						record,
						"error",
						`Retry failed (attempt ${event.attempt})${event.finalError ? `: ${oneLine(event.finalError, 200)}` : ""}.`,
					);
				}
				this.requestPanelRender(true);
				break;

			case "compaction_start":
				record.currentActivity = "Compacting subagent context...";
				this.requestPanelRender(true);
				break;

			case "compaction_end":
				record.currentActivity = undefined;
				this.requestPanelRender(true);
				break;
		}
	}

	private captureCompletion(record: SubagentRecord): CompletionNotice {
		return {
			id: record.id,
			label: record.label,
			agentName: record.agentName,
			status: record.status,
			task: record.task,
			lastOutput: record.lastOutput,
			...(record.error ? { error: record.error } : {}),
			usage: { ...record.usage },
			...(record.startedAt ? { startedAt: record.startedAt } : {}),
			...(record.endedAt ? { endedAt: record.endedAt } : {}),
		};
	}

	private settleCompletion(
		record: SubagentRecord,
		completionGroupId: string | undefined,
		notifySingle: boolean,
	): void {
		if (!completionGroupId) {
			record.currentCompletionGroupId = undefined;
			if (notifySingle) this.notifyParent(record);
			return;
		}

		const group = this.completionGroups.get(completionGroupId);
		if (!group) {
			record.currentCompletionGroupId = undefined;
			if (notifySingle) this.notifyParent(record);
			return;
		}
		if (!group.settled.has(record.id)) {
			group.settled.set(record.id, this.captureCompletion(record));
		}
		if (group.settled.size < group.memberIds.length) return;

		const notices = group.memberIds
			.map((id) => group.settled.get(id))
			.filter((notice): notice is CompletionNotice => Boolean(notice));
		for (const id of group.memberIds) {
			const member = this.records.get(id);
			if (member?.currentCompletionGroupId === completionGroupId) {
				member.currentCompletionGroupId = undefined;
			}
		}
		this.completionGroups.delete(completionGroupId);
		this.notifyParentBatch(group.id, notices);
	}

	private completionStats(notice: CompletionNotice): string {
		return [
			`${notice.usage.toolUses} tool use${notice.usage.toolUses === 1 ? "" : "s"}`,
			`${notice.usage.turns} turn${notice.usage.turns === 1 ? "" : "s"}`,
			notice.usage.output
				? `output ${formatTokens(notice.usage.output)} tokens`
				: "",
			notice.startedAt
				? `elapsed ${formatDuration(notice.startedAt, notice.endedAt ?? Date.now())}`
				: "",
		]
			.filter(Boolean)
			.join(" · ");
	}

	private notifyParentBatch(
		groupId: string,
		notices: CompletionNotice[],
	): void {
		if (this.disposed || !notices.length) return;
		const completed = notices.filter(
			(notice) => notice.status === "completed",
		).length;
		const intro = `Subagent batch ${groupId} settled: ${completed}/${notices.length} completed successfully.`;
		const closing = [
			"Respond to the user once with a concise synthesis of the whole batch. Do not quote this notification verbatim and do not call subagent read merely to confirm completion.",
			'Control: subagent read for a snapshot, send to continue/steer, send with fresh=true for a new context, stop to cancel.',
		].join("\n\n");
		const sectionPrefixes = notices.map((notice) =>
			[
				`## ${notice.id} [${notice.status}] ${oneLine(notice.label, 64)} (agent=${oneLine(notice.agentName, 64)})`,
				`Task: ${oneLine(notice.task, 240)}`,
				`Stats: ${this.completionStats(notice)}`,
				"Result:\n",
			].join("\n\n"),
		);
		const separator = "\n\n---\n\n";
		const fixedChars = [intro, ...sectionPrefixes, closing].join(separator).length;
		const resultBudget = Math.max(
			0,
			Math.floor((COMPLETION_OUTPUT_CHARS - fixedChars) / notices.length),
		);
		const sections = notices.map((notice, index) => {
			const succeeded = notice.status === "completed";
			const rawOutput = succeeded
				? notice.lastOutput || "(completed without text output)"
				: notice.lastOutput ||
					notice.error ||
					(notice.status === "stopped"
						? "(stopped with no partial output)"
						: "(no diagnostics)");
			return `${sectionPrefixes[index]}${truncateText(rawOutput, resultBudget, `${notice.id} result`)}`;
		});
		const content = [intro, ...sections, closing].join(separator);

		try {
			this.pi.sendMessage(
				{
					customType: SUBAGENT_NOTIFICATION_TYPE,
					content,
					display: false,
					details: {
						batchId: groupId,
						ids: notices.map((notice) => notice.id),
						statuses: notices.map((notice) => notice.status),
					},
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			// The parent session may be shutting down; retained records still hold results.
		}

		if (this.ctx?.hasUI) {
			this.ctx.ui.notify(
				`Subagent batch finished: ${completed}/${notices.length} completed`,
				completed === notices.length ? "info" : "warning",
			);
		}
	}

	private notifyParent(record: SubagentRecord): void {
		if (this.disposed) return;
		const succeeded = record.status === "completed";
		// Prefer partial assistant text on stop/fail so the parent has evidence.
		const rawOutput = succeeded
			? record.lastOutput || "(completed without text output)"
			: record.lastOutput ||
				record.error ||
				(record.status === "stopped"
					? "(stopped with no partial output)"
					: "(no diagnostics)");
		const stats = [
			`${record.usage.toolUses} tool use${record.usage.toolUses === 1 ? "" : "s"}`,
			`${record.usage.turns} turn${record.usage.turns === 1 ? "" : "s"}`,
			record.usage.output ? `output ${formatTokens(record.usage.output)} tokens` : "",
			record.startedAt
				? `elapsed ${formatDuration(record.startedAt, record.endedAt ?? Date.now())}`
				: "",
		]
			.filter(Boolean)
			.join(" · ");
		const summary = [
			`Subagent ${record.id} (${oneLine(record.label, 64)}, agent=${oneLine(record.agentName, 64)}) ${record.status}.`,
			`Task: ${oneLine(record.task, 500)}`,
			`Stats: ${stats}`,
		];
		const resultPrefix =
			record.status === "stopped" || record.status === "failed"
				? "Partial result:\n"
				: "Result:\n";
		const closing = [
			"Respond to the user once with a concise synthesis. Do not quote this notification verbatim and do not call subagent read merely to confirm completion.",
			'Control: subagent read for a snapshot, send to continue/steer, send with fresh=true for a new context, stop to cancel.',
		];
		const separator = "\n\n";
		const fixedChars = [
			...summary,
			resultPrefix,
			...closing,
		].join(separator).length;
		const output = truncateText(
			rawOutput,
			Math.max(0, COMPLETION_OUTPUT_CHARS - fixedChars),
			"completion output",
		);
		const content = [
			...summary,
			`${resultPrefix}${output}`,
			...closing,
		].join(separator);

		try {
			this.pi.sendMessage(
				{
					customType: SUBAGENT_NOTIFICATION_TYPE,
					content,
					display: false,
					details: {
						id: record.id,
						label: record.label,
						agent: record.agentName,
						status: record.status,
						turns: record.usage.turns,
					},
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			// The parent session may be shutting down; status/timeline still retain the result.
		}

		if (this.ctx?.hasUI) {
			this.ctx.ui.notify(
				`Subagent ${record.id} ${record.status}: ${record.label}`,
				record.status === "failed" ? "error" : "info",
			);
		}
	}

	private startToolActivity(
		record: SubagentRecord,
		id: string,
		toolName: string,
		args: unknown,
	): void {
		const description = describeToolCall(toolName, args);
		const activity: ToolActivity = {
			id,
			toolName,
			headline: description.headline,
			summary: description.summary,
			status: "running",
			startedAt: Date.now(),
		};
		record.activities.push(activity);
		record.currentActivity = description.headline;
		this.trimActivities(record);
	}

	private finishToolActivity(
		record: SubagentRecord,
		id: string,
		result: unknown,
		isError: boolean,
	): void {
		const activity = record.activities.findLast((item) => item.id === id);
		if (activity) {
			activity.status = isError ? "failed" : "succeeded";
			activity.endedAt = Date.now();
			const summary = summarizeToolResult(result);
			if (summary) activity.resultSummary = summary;
		}
		const running = record.activities.findLast(
			(item) => item.status === "running",
		);
		record.currentActivity = running?.headline;
		this.trimActivities(record);
	}

	private trimActivities(record: SubagentRecord): void {
		let characterCount = record.activities.reduce(
			(total, item) =>
				total + item.headline.length + item.summary.length + (item.resultSummary?.length ?? 0),
			0,
		);
		while (
			record.activities.length > ACTIVITY_MAX_ITEMS ||
			characterCount > ACTIVITY_MAX_CHARS
		) {
			const removed = record.activities.shift();
			if (!removed) break;
			characterCount -=
				removed.headline.length +
				removed.summary.length +
				(removed.resultSummary?.length ?? 0);
			record.omittedActivities++;
		}
	}

	private addTimeline(
		record: SubagentRecord,
		kind: TimelineKind,
		text: string,
	): void {
		const normalized = text.trim();
		if (!normalized) return;
		record.timeline.push({ kind, text: normalized, timestamp: Date.now() });
		let characterCount = record.timeline.reduce(
			(total, item) => total + item.text.length,
			0,
		);
		while (
			record.timeline.length > TIMELINE_MAX_ITEMS ||
			characterCount > TIMELINE_MAX_CHARS
		) {
			const removed = record.timeline.shift();
			if (!removed) break;
			characterCount -= removed.text.length;
		}
	}

	private releaseSession(record: SubagentRecord): void {
		record.unsubscribe?.();
		record.unsubscribe = undefined;
		record.session?.dispose();
		record.session = undefined;
	}

	private updateProfilePreference(
		name: string,
		patch: Partial<ProfilePreference>,
	): void {
		const current = { ...(this.userConfig.profiles[name] ?? {}) };
		if (Object.hasOwn(patch, "model")) {
			if (patch.model === undefined) delete current.model;
			else current.model = patch.model;
		}
		if (Object.hasOwn(patch, "thinkingLevel")) {
			if (patch.thinkingLevel === undefined) delete current.thinkingLevel;
			else current.thinkingLevel = patch.thinkingLevel;
		}
		if (Object.keys(current).length) this.userConfig.profiles[name] = current;
		else delete this.userConfig.profiles[name];
	}

	private async savePreferences(ctx: ExtensionContext): Promise<void> {
		try {
			await saveSubagentUserConfig(this.userConfig);
			ctx.ui.notify(
				`Saved subagent profile settings to ${getSubagentUserConfigPath()}.`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(
				`Could not save subagent settings: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}

	private removeFromQueue(id: string): void {
		for (let index = this.queue.length - 1; index >= 0; index--) {
			if (this.queue[index] === id) this.queue.splice(index, 1);
		}
	}

	private deleteRecord(record: SubagentRecord): void {
		this.removeFromQueue(record.id);
		this.releaseSession(record);
		this.records.delete(record.id);
	}

	private makeRoomForSpawn(
		count: number,
		maxAgents: number,
	): { evicted: string[] } | { error: string } {
		const required = this.records.size + count - maxAgents;
		if (required <= 0) return { evicted: [] };

		const candidates = [...this.records.values()]
			.filter(
				(record) =>
					isTerminalStatus(record.status) &&
					!record.currentCompletionGroupId &&
					!(record.status === "failed" && record.unread),
			)
			.sort((first, second) => {
				const firstUnread = first.unread ? 1 : 0;
				const secondUnread = second.unread ? 1 : 0;
				const firstFailure = first.status === "failed" ? 1 : 0;
				const secondFailure = second.status === "failed" ? 1 : 0;
				return (
					firstUnread - secondUnread ||
					firstFailure - secondFailure ||
					(first.endedAt ?? first.updatedAt) -
						(second.endedAt ?? second.updatedAt) ||
					first.createdAt - second.createdAt
				);
			});
		if (candidates.length < required) {
			return {
				error: `Spawning ${count} worker(s) would exceed maxAgents=${maxAgents}. Active workers, unsettled batch members, and unread failures are protected; stop/view records, use /agents clear, or raise the limit (hard maximum ${HARD_MAX_AGENTS}).`,
			};
		}

		const selected = candidates.slice(0, required);
		for (const record of selected) this.deleteRecord(record);
		return { evicted: selected.map((record) => record.id) };
	}

	private applyConfig(config: Partial<SubagentConfig>, persist: boolean): void {
		const next: SubagentConfig = {
			maxConcurrency: Math.max(
				1,
				Math.min(
					HARD_MAX_CONCURRENCY,
					config.maxConcurrency ?? this.config.maxConcurrency,
				),
			),
			maxAgents: Math.max(
				1,
				Math.min(HARD_MAX_AGENTS, config.maxAgents ?? this.config.maxAgents),
			),
		};
		const changed =
			next.maxConcurrency !== this.config.maxConcurrency ||
			next.maxAgents !== this.config.maxAgents;
		this.config = next;
		if (changed && persist)
			this.pi.appendEntry(SUBAGENT_CONFIG_ENTRY_TYPE, cloneConfig(this.config));
		if (changed) {
			this.stateChanged();
			void this.pumpQueue();
		}
	}

	configureLimits(
		maxConcurrency: number | undefined,
		maxAgents: number | undefined,
	): string {
		if (maxConcurrency === undefined && maxAgents === undefined) {
			throw new Error("Specify maxConcurrency and/or maxAgents.");
		}
		this.applyConfig({ maxConcurrency, maxAgents }, true);
		const warning =
			this.records.size > this.config.maxAgents
				? ` ${this.records.size - this.config.maxAgents} retained record(s) exceed the new cap; new spawns reclaim eligible terminal records before failing.`
				: "";
		return `Subagent limits updated: maxConcurrency=${this.config.maxConcurrency}, maxAgents=${this.config.maxAgents}.${warning}`;
	}

	private listResult(): AgentToolResult<SubagentDetails> {
		const records = [...this.records.values()].sort(
			(first, second) => second.updatedAt - first.updatedAt,
		);
		if (!records.length) {
			return this.result(
				"read_list",
				"No subagents in this session.",
			);
		}
		const lines = records.map((record) => {
			const elapsed = record.startedAt
				? formatDuration(record.startedAt, record.endedAt ?? Date.now()) || "-"
				: "-";
			const activity = record.currentActivity
				? ` · ${oneLine(record.currentActivity, 60)}`
				: "";
			const tokens = record.usage.output
				? ` · ↓${formatTokens(record.usage.output)}`
				: "";
			return `${record.id} [${record.status}] ${oneLine(record.label, 40)} (${record.agentName}) · ${elapsed}${tokens}${activity}`;
		});
		return this.result(
			"read_list",
			[
				`Subagents ${this.activeRuns} active / ${this.queue.length} queued / ${records.length} retained:`,
				...lines,
			].join("\n"),
			records,
		);
	}

	private readResult(id: string | undefined): AgentToolResult<SubagentDetails> {
		if (!id) return this.listResult();
		const record = this.records.get(id);
		if (!record)
			return this.errorResult(
				"read",
				"not_found",
				`Unknown subagent id: ${id}. Use read without id to list workers.`,
			);
		if (record.unread) {
			record.unread = false;
			this.stateChanged();
		}

		// Compact snapshot for the model — full activity stays in the live preview.
		const recentTools = record.activities
			.slice(-5)
			.map((activity) => `[${activity.status}] ${activity.summary}`)
			.join("; ");
		const finalOutput = truncateText(
			record.liveText ||
				record.lastOutput ||
				"(no assistant output yet)",
			Math.floor(READ_OUTPUT_CHARS * 0.75),
			"output",
		);
		const raw = [
			`${record.id} [${record.status}] ${record.label}`,
			`agent=${record.agentName} source=${record.agentDefinition.source}`,
			`task: ${oneLine(record.task, 300)}`,
			`usage: turns=${record.usage.turns} tools=${record.usage.toolUses} out=${formatTokens(record.usage.output)} cost=$${record.usage.cost.toFixed(4)}`,
			record.currentActivity
				? `activity: ${oneLine(record.currentActivity, 120)}`
				: "",
			record.error ? `error: ${record.error}` : "",
			recentTools ? `recent tools: ${recentTools}` : "",
			record.status === "completed" ? "result:" : "output:",
			finalOutput,
		]
			.filter(Boolean)
			.join("\n");
		return this.result(
			"read",
			truncateText(raw, READ_OUTPUT_CHARS, "snapshot"),
			[record],
		);
	}

	private async sendResult(
		id: string | undefined,
		message: string | undefined,
		fresh: boolean,
	): Promise<AgentToolResult<SubagentDetails>> {
		if (!id) {
			return this.errorResult(
				"send",
				"invalid_parameters",
				'send requires id. Example: { action:"send", id:"a7c3e91f", message:"..." }',
			);
		}
		try {
			const text = await this.sendAgent(id, message, fresh);
			return this.result("send", text, [this.requireRecord(id)]);
		} catch (error) {
			return this.errorResult(
				"send",
				"send_failed",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	private async stopResult(
		id: string | undefined,
	): Promise<AgentToolResult<SubagentDetails>> {
		if (!id)
			return this.errorResult(
				"stop",
				"invalid_parameters",
				'stop requires id. Example: { action:"stop", id:"a7c3e91f" }',
			);
		try {
			const text = await this.stopAgent(id);
			return this.result("stop", text, [this.requireRecord(id)]);
		} catch (error) {
			return this.errorResult(
				"stop",
				"stop_failed",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	clearAgents(id: string | undefined): string {
		const targets = id
			? [this.records.get(id)].filter((record): record is SubagentRecord =>
					Boolean(record),
				)
			: [...this.records.values()].filter((record) =>
					isTerminalStatus(record.status),
				);
		if (id && targets.length === 0) {
			throw new Error(`Unknown subagent id: ${id}.`);
		}
		const nonTerminal = targets.find(
			(record) => !isTerminalStatus(record.status),
		);
		if (nonTerminal) {
			throw new Error(
				`${nonTerminal.id} is ${nonTerminal.status}; stop it before clearing.`,
			);
		}
		for (const record of targets) this.deleteRecord(record);
		this.stateChanged();
		return `Cleared ${targets.length} terminal subagent record${targets.length === 1 ? "" : "s"}.`;
	}

	private requireRecord(id: string): SubagentRecord {
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown subagent id: ${id}.`);
		return record;
	}

	private snapshot(record: SubagentRecord): SubagentSnapshot {
		return {
			id: record.id,
			label: record.label,
			agentName: record.agentName,
			agentSource: record.agentDefinition.source,
			task: record.task,
			cwd: record.cwd,
			status: record.status,
			createdAt: record.createdAt,
			...(record.startedAt ? { startedAt: record.startedAt } : {}),
			...(record.endedAt ? { endedAt: record.endedAt } : {}),
			updatedAt: record.updatedAt,
			runCount: record.runCount,
			unread: record.unread,
			...(record.error ? { error: record.error } : {}),
			lastOutput: record.lastOutput,
			liveText: record.liveText,
			...(record.currentActivity
				? { currentActivity: record.currentActivity }
				: {}),
			activities: record.activities.map((activity) => ({ ...activity })),
			omittedActivities: record.omittedActivities,
			timeline: record.timeline.map((item: TimelineItem) => ({ ...item })),
			usage: { ...record.usage },
			...(record.resolvedModel
				? {
						model: `${record.resolvedModel.provider}/${record.resolvedModel.id}`,
					}
				: record.model
					? { model: record.model }
					: {}),
		};
	}

	private result(
		action: string,
		text: string,
		records: Iterable<SubagentRecord> = this.records.values(),
	): AgentToolResult<SubagentDetails> {
		return {
			content: [{ type: "text", text }],
			details: this.details(action, records),
		};
	}

	private errorResult(
		action: string,
		code: string,
		message: string,
	): AgentToolResult<SubagentDetails> {
		return {
			content: [
				{
					type: "text",
					text: `Subagent ${action} failed (${code}): ${message}`,
				},
			],
			details: { ...this.details(action, []), errorCode: code },
		};
	}

	private details(
		action: string,
		records: Iterable<SubagentRecord>,
	): SubagentDetails {
		return {
			action,
			config: cloneConfig(this.config),
			agents: [...records].map((record) => ({
				id: record.id,
				label: record.label,
				agent: record.agentName,
				status: record.status,
				cwd: record.cwd,
				runCount: record.runCount,
				turns: record.usage.turns,
				toolUses: record.usage.toolUses,
				outputTokens: record.usage.output,
				unread: record.unread,
			})),
		};
	}

	private stateChanged(): void {
		this.requestPanelRender(true);
		this.syncStatusline();
	}

	/** Compact statusline chip; open Alt+O for the interactive panel. */
	private syncStatusline(): void {
		const ctx = this.ctx;
		if (!ctx?.hasUI) return;
		if (this.disposed || this.records.size === 0) {
			ctx.ui.setStatus(SUBAGENT_STATUS_KEY, undefined);
			return;
		}
		const snapshots = this.getSnapshots();
		const summary = formatStatuslineSummary(snapshots);
		if (!summary) {
			ctx.ui.setStatus(SUBAGENT_STATUS_KEY, undefined);
			return;
		}
		const theme = ctx.ui.theme;
		const tone = statuslineTone(snapshots);
		// Pre-colored so statusline can pass ANSI through (see formatExtensionStatuses).
		ctx.ui.setStatus(
			SUBAGENT_STATUS_KEY,
			`${theme.fg(tone, summary)}${theme.fg("dim", " · Alt+O")}`,
		);
	}

	private cancelPanelRenderTimer(): void {
		if (!this.panelRenderTimer) return;
		clearTimeout(this.panelRenderTimer);
		this.panelRenderTimer = undefined;
	}

	private requestPanelRender(immediate = false): void {
		this.invalidateSnapshots();
		if (!this.panel) return;

		const now = Date.now();
		if (immediate) {
			this.cancelPanelRenderTimer();
			this.lastPanelRenderAt = now;
			this.panel.requestRender();
			return;
		}
		if (this.panelRenderTimer) return;

		const delay = Math.max(
			0,
			PANEL_RENDER_THROTTLE_MS - (now - this.lastPanelRenderAt),
		);
		if (delay === 0) {
			this.lastPanelRenderAt = now;
			this.panel.requestRender();
			return;
		}

		this.panelRenderTimer = setTimeout(() => {
			this.panelRenderTimer = undefined;
			this.lastPanelRenderAt = Date.now();
			this.panel?.requestRender();
		}, delay);
		this.panelRenderTimer.unref?.();
	}
}

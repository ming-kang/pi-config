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
	READ_OUTPUT_CHARS,
	SUBAGENT_CONFIG_ENTRY_TYPE,
	SUBAGENT_NOTIFICATION_TYPE,
	SUBAGENT_USER_CONFIG_VERSION,
	SUBAGENT_WIDGET_KEY,
	TIMELINE_MAX_CHARS,
	TIMELINE_MAX_ITEMS,
} from "./constants.ts";
import {
	formatDuration,
	formatTokens,
	isTerminalStatus,
	oneLine,
} from "./format.ts";
import { panelOverlayOptions, SubagentPanel } from "./panel.ts";
import type {
	AgentScope,
	DeliveryMode,
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
import { SubagentFooterWidget } from "./widget.ts";

const BUILTIN_TOOLS = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
]);

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

function truncateText(
	text: string,
	maxChars: number,
	label = "output",
): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[${label} truncated: ${text.length - maxChars} characters omitted. Use subagent action "read" for the retained snapshot.]`;
}

function makeWorkerSystemPrompt(agent: AgentDefinition): string {
	const role = agent.systemPrompt.trim();
	return [
		`You are Pi background subagent "${agent.name}", a focused worker delegated one concrete task.`,
		"Work directly and efficiently inside the assigned working directory. Keep scope bounded to the task, obey applicable project instruction files, and report a clear result for the parent agent.",
		"Do not ask the end user questions from this isolated session. If blocked, explain the exact blocker and the decision the parent agent needs to make.",
		"Do not spawn additional subagents; this worker is already the delegated execution context.",
		role,
	]
		.filter(Boolean)
		.join("\n\n");
}

function cloneConfig(config: SubagentConfig): SubagentConfig {
	return { maxConcurrency: config.maxConcurrency, maxAgents: config.maxAgents };
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
	private nextId = 1;
	private activeRuns = 0;
	private pumping = false;
	private disposed = false;
	private panelOpen = false;
	/** Once true, the widget's one-time "/agents to view" onboarding line disappears. */
	private panelOpenedThisSession = false;
	private panel: SubagentPanel | undefined;
	private widget: SubagentFooterWidget | undefined;
	private widgetVisible = false;
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
		// A revived session re-mounts the widget; drop any stale cached snapshots
		// so the first render reflects current records (applyConfig may not fire
		// stateChanged when persistedConfig is unchanged).
		this.invalidateSnapshots();
		if (persistedConfig) this.applyConfig(persistedConfig, false);
		this.syncWidget();
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

	/** The worker the user most likely wants to open: unread first, then active, then most recent. */
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

	markViewed(id: string): void {
		const record = this.records.get(id);
		if (!record || !record.unread) return;
		record.unread = false;
		this.stateChanged();
	}

	/** Whether an id maps to a retained record; gates the /agents usage hint. */
	hasAgent(id: string): boolean {
		return this.records.has(id);
	}

	async openPanel(ctx: ExtensionContext, initialId?: string): Promise<void> {
		this.bindContext(ctx);
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/agents requires the Pi TUI.", "warning");
			return;
		}
		if (this.panelOpen) {
			ctx.ui.notify("The subagent panel is already open.", "info");
			return;
		}

		this.panelOpen = true;
		this.panelOpenedThisSession = true;
		this.widget?.requestRender(); // drop the one-time /agents onboarding line
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
						done,
						...(startId ? { initialId: startId } : {}),
					});
					this.panel = panel;
					return panel;
				},
				{
					overlay: true,
					// Evaluated after the factory runs, so overlayTui is set; the
					// tier is chosen for the terminal size at open time.
					overlayOptions: () =>
						panelOverlayOptions(
							overlayTui?.terminal.columns ?? process.stdout.columns ?? 80,
							overlayTui?.terminal.rows ?? process.stdout.rows ?? 24,
						),
				},
			);
		} finally {
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
		switch (params.action) {
			case "spawn":
				return this.spawn(params, ctx);
			case "list":
				return this.listResult();
			case "read":
				return this.readResult(params.id);
			case "send":
				return this.sendResult(
					params.id,
					params.message,
					params.delivery ?? "steer",
				);
			case "restart":
				return this.restartResult(params.id, params.message);
			case "stop":
				return this.stopResult(params.id);
			case "clear":
				return this.clearResult(params.id);
			case "configure":
				return this.configureResult(params.maxConcurrency, params.maxAgents);
		}
	}

	async sendInstruction(
		id: string,
		message: string,
		delivery: DeliveryMode,
	): Promise<string> {
		const record = this.requireRecord(id);
		const instruction = message.trim();
		if (!instruction) throw new Error("Instruction cannot be empty.");

		if (record.status === "queued" || record.status === "starting") {
			record.pendingInstructions.push({ message: instruction, delivery });
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
			if (delivery === "followUp") await record.session.followUp(instruction);
			else await record.session.steer(instruction);
			this.requestPanelRender();
			return delivery === "followUp"
				? `Queued — ${record.id} sees it when current work settles.`
				: `Sent — ${record.id} sees it after the current tool batch.`;
		}

		if (record.status === "completed") {
			this.enqueueRun(record, { prompt: instruction, fresh: false });
			return `Continuing — ${record.id} resumes its conversation.`;
		}

		throw new Error(
			`${record.id} is ${record.status}; use restart for a fresh run.`,
		);
	}

	async restartAgent(id: string, message?: string): Promise<string> {
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
			"Restart requested with a fresh isolated context.",
		);
		this.enqueueRun(record, { prompt, fresh: true });
		return `Rerunning ${record.id} with a fresh context.`;
	}

	async stopAgent(id: string): Promise<string> {
		const record = this.requireRecord(id);
		if (record.status === "queued") {
			this.removeFromQueue(record.id);
			record.pendingRun = undefined;
			record.pendingInstructions = [];
			record.status = "stopped";
			record.endedAt = Date.now();
			record.updatedAt = Date.now();
			record.unread = true;
			this.addTimeline(record, "system", "Stopped before execution started.");
			this.stateChanged();
			return `${record.id} removed from the queue.`;
		}

		if (record.status === "starting" || record.status === "running") {
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
		if (this.ctx?.mode === "tui") {
			if (this.widgetVisible) {
				this.widgetVisible = false;
				this.widget = undefined;
				this.ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, undefined);
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
		this.panel = undefined;
	}

	private async spawn(
		params: SubagentParams,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<SubagentDetails>> {
		const tasks = this.normalizeSpawnTasks(params);
		if ("error" in tasks)
			return this.errorResult("spawn", "invalid_parameters", tasks.error);
		if (
			this.records.size + tasks.length >
			(params.maxAgents ?? this.config.maxAgents)
		) {
			return this.errorResult(
				"spawn",
				"max_agents",
				`Spawning ${tasks.length} worker(s) would exceed maxAgents=${params.maxAgents ?? this.config.maxAgents}. Clear completed agents or raise the limit (hard maximum 32).`,
			);
		}

		const scope = params.agentScope ?? "user";
		const discovery = discoverAgents(ctx.cwd, scope);
		const prepared = this.prepareLaunchSpecs(tasks, scope, discovery, ctx);
		if ("error" in prepared)
			return this.errorResult("spawn", prepared.code, prepared.error);

		const projectAgents = prepared.specs
			.map((spec) => spec.agentDefinition)
			.filter((agent) => agent.source === "project");
		if (projectAgents.length && (params.confirmProjectAgents ?? true)) {
			if (!ctx.hasUI) {
				return this.errorResult(
					"spawn",
					"no_ui",
					"Project-local agents require interactive confirmation. Retry in an interactive UI or explicitly set confirmProjectAgents=false for a trusted repository.",
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

		const nextConfig = {
			maxConcurrency: params.maxConcurrency ?? this.config.maxConcurrency,
			maxAgents: params.maxAgents ?? this.config.maxAgents,
		};
		this.applyConfig(nextConfig, true);

		const spawned: SubagentRecord[] = [];
		for (const preparedSpec of prepared.specs) {
			const id = `sa-${String(this.nextId++).padStart(2, "0")}`;
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
			this.enqueueRun(record, { prompt: record.task, fresh: true });
		}

		const text = [
			`Spawned ${spawned.length} background subagent${spawned.length === 1 ? "" : "s"}; the call returns before they finish.`,
			...spawned.map(
				(record) =>
					`- ${record.id} [${record.status}] ${record.label} (${record.agentName}) — ${oneLine(record.task, 180)}`,
			),
			`Concurrency: ${this.activeRuns}/${this.config.maxConcurrency} active; ${this.queue.length} queued. Completion notifications will be delivered automatically.`,
		].join("\n");
		return this.result("spawn", text, spawned);
	}

	private normalizeSpawnTasks(
		params: SubagentParams,
	): SubagentTaskParams[] | { error: string } {
		const hasBatch = Boolean(params.tasks?.length);
		const singleTask = params.task?.trim();
		const hasSingle = Boolean(singleTask);
		if (hasBatch === hasSingle) {
			return {
				error: "spawn requires exactly one of task (single) or tasks (batch).",
			};
		}
		if (params.tasks) return params.tasks;
		return [
			{
				task: singleTask ?? "",
				...(params.agent ? { agent: params.agent } : {}),
				...(params.label ? { label: params.label } : {}),
				...(params.model ? { model: params.model } : {}),
				...(params.tools ? { tools: params.tools } : {}),
				...(params.cwd ? { cwd: params.cwd } : {}),
				...(params.thinkingLevel
					? { thinkingLevel: params.thinkingLevel }
					: {}),
			},
		];
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

			const cwd = path.resolve(ctx.cwd, task.cwd?.trim() || ".");
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

			const tools = task.tools ?? agentDefinition.tools;
			if (tools) {
				const unsupported = tools.filter((tool) => !BUILTIN_TOOLS.has(tool));
				if (unsupported.length) {
					return {
						error: `Unsupported subagent tools: ${unsupported.join(", ")}. Allowed built-ins: ${[...BUILTIN_TOOLS].join(", ")}.`,
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
			let thinkingLevel: ThinkingLevelName;
			if (task.thinkingLevel === "inherit") thinkingLevel = parentThinking;
			else if (task.thinkingLevel) thinkingLevel = task.thinkingLevel;
			else if (hasPreferredThinking) {
				const preferredThinking = preference?.thinkingLevel;
				thinkingLevel =
					preferredThinking === "inherit" || preferredThinking === undefined
						? parentThinking
						: preferredThinking;
			} else {
				thinkingLevel = agentDefinition.thinkingLevel ?? parentThinking;
			}

			const taskText = task.task.trim();
			const label = oneLine(task.label?.trim() || taskText, 48) || agentName;
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
					(item) =>
						`Additional parent instruction (${item.delivery === "followUp" ? "follow-up" : "steer"}): ${item.message}`,
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
			this.notifyParent(record);
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
			this.notifyParent(record);
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
		// systemPrompt is part of the key: an on-disk agent definition can be
		// edited between spawns, and a stale loader closes over the old prompt.
		const key = [record.cwd, agent.name, agent.source, agent.systemPrompt].join(
			"\0",
		);
		const existing = this.loaders.get(key);
		if (existing) return existing;
		const promise = (async () => {
			const loader = new DefaultResourceLoader({
				cwd: record.cwd,
				agentDir: getAgentDir(),
				noExtensions: true,
				noPromptTemplates: true,
				noThemes: true,
				settingsManager: this.settingsManagerFor(record.cwd),
				systemPromptOverride: (base) =>
					[base, makeWorkerSystemPrompt(agent)].filter(Boolean).join("\n\n"),
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
				this.requestPanelRender();
				break;

			case "tool_execution_start":
				this.startToolActivity(
					record,
					event.toolCallId,
					event.toolName,
					event.args,
				);
				record.usage.toolUses++;
				this.requestPanelRender();
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
				this.requestPanelRender();
				break;

			case "auto_retry_start":
				record.currentActivity = `Retrying request (attempt ${event.attempt})...`;
				this.addTimeline(record, "system", record.currentActivity);
				this.requestPanelRender();
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
				this.requestPanelRender();
				break;

			case "compaction_start":
				record.currentActivity = "Compacting subagent context...";
				this.requestPanelRender();
				break;

			case "compaction_end":
				record.currentActivity = undefined;
				this.requestPanelRender();
				break;
		}
	}

	private notifyParent(record: SubagentRecord): void {
		if (this.disposed) return;
		const succeeded = record.status === "completed";
		const rawOutput = succeeded
			? record.lastOutput || "(completed without text output)"
			: record.error || record.lastOutput || "(no diagnostics)";
		const output = truncateText(
			rawOutput,
			COMPLETION_OUTPUT_CHARS,
			"completion output",
		);
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
		const content = [
			`Subagent ${record.id} (${record.label}, agent=${record.agentName}) ${record.status}.`,
			`Task: ${oneLine(record.task, 500)}`,
			`Stats: ${stats}`,
			`Result:\n${output}`,
			"Respond to the user once with a concise synthesis. Do not quote this notification verbatim and do not call subagent read/list merely to confirm completion.",
			`Control: use subagent action "read" for its retained snapshot, "send" to continue/steer it, or "restart" for a fresh context.`,
		].join("\n\n");

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

	private configureResult(
		maxConcurrency: number | undefined,
		maxAgents: number | undefined,
	): AgentToolResult<SubagentDetails> {
		if (maxConcurrency === undefined && maxAgents === undefined) {
			return this.errorResult(
				"configure",
				"invalid_parameters",
				"configure requires maxConcurrency and/or maxAgents.",
			);
		}
		this.applyConfig({ maxConcurrency, maxAgents }, true);
		const warning =
			this.records.size > this.config.maxAgents
				? ` ${this.records.size - this.config.maxAgents} retained record(s) exceed the new cap; no new spawns are allowed until cleared.`
				: "";
		return this.result(
			"configure",
			`Subagent limits updated: maxConcurrency=${this.config.maxConcurrency}, maxAgents=${this.config.maxAgents}.${warning}`,
		);
	}

	private listResult(): AgentToolResult<SubagentDetails> {
		const records = [...this.records.values()].sort(
			(first, second) => second.updatedAt - first.updatedAt,
		);
		if (!records.length) {
			return this.result(
				"list",
				`No subagents in this session. Limits: maxConcurrency=${this.config.maxConcurrency}, maxAgents=${this.config.maxAgents}.`,
			);
		}
		const lines = records.map((record) => {
			const elapsed = record.startedAt
				? formatDuration(record.startedAt, record.endedAt ?? Date.now()) || "-"
				: "-";
			return `- ${record.id} [${record.status}] ${record.label} agent=${record.agentName} toolUses=${record.usage.toolUses} elapsed=${elapsed}${record.currentActivity ? ` activity=${oneLine(record.currentActivity, 100)}` : ""}`;
		});
		return this.result(
			"list",
			[
				`Subagents (${this.activeRuns}/${this.config.maxConcurrency} active, ${this.queue.length} queued, ${records.length}/${this.config.maxAgents} retained):`,
				...lines,
			].join("\n"),
			records,
		);
	}

	private readResult(id: string | undefined): AgentToolResult<SubagentDetails> {
		if (!id)
			return this.errorResult(
				"read",
				"invalid_parameters",
				"read requires id.",
			);
		const record = this.records.get(id);
		if (!record)
			return this.errorResult(
				"read",
				"not_found",
				`Unknown subagent id: ${id}.`,
			);
		this.markViewed(record.id);

		const activities = [
			record.omittedActivities
				? `... ${record.omittedActivities} earlier tool activities omitted`
				: "",
			...record.activities.slice(-120).map((activity) => {
				const result = activity.resultSummary
					? ` — ${activity.resultSummary}`
					: "";
				return `[${activity.status}] ${activity.summary}${result}`;
			}),
		]
			.filter(Boolean)
			.join("\n");
		const timeline = record.timeline
			.slice(-120)
			.filter(
				(item) =>
					item.kind !== "tool" &&
					item.kind !== "toolResult" &&
					!(item.kind === "assistant" && item.text === record.lastOutput),
			)
			.map((item) => `[${item.kind}] ${item.text}`)
			.concat(
				record.liveText ? [`[assistant-streaming] ${record.liveText}`] : [],
			)
			.join("\n");
		const finalOutput = truncateText(
			record.lastOutput || "(no final assistant output yet)",
			Math.floor(READ_OUTPUT_CHARS * 0.7),
			"final result",
		);
		const raw = [
			`${record.id} [${record.status}] ${record.label}`,
			`Agent: ${record.agentName} (${record.agentDefinition.source})`,
			`Cwd: ${record.cwd}`,
			`Task: ${record.task}`,
			`Runs: ${record.runCount}; turns: ${record.usage.turns}; tool uses: ${record.usage.toolUses}; tokens: input=${record.usage.input}, output=${record.usage.output}, cacheRead=${record.usage.cacheRead}, cacheWrite=${record.usage.cacheWrite}; cost=$${record.usage.cost.toFixed(4)}`,
			record.currentActivity
				? `Current activity: ${record.currentActivity}`
				: "",
			record.error ? `Error: ${record.error}` : "",
			"Tool activity:",
			activities || "(no tool activity yet)",
			record.status === "completed" ? "Final result:" : "Latest assistant output:",
			finalOutput,
			"Conversation updates:",
			timeline || "(no conversation updates yet)",
		]
			.filter(Boolean)
			.join("\n\n");
		return this.result(
			"read",
			truncateText(raw, READ_OUTPUT_CHARS, "retained snapshot"),
			[record],
		);
	}

	private async sendResult(
		id: string | undefined,
		message: string | undefined,
		delivery: DeliveryMode,
	): Promise<AgentToolResult<SubagentDetails>> {
		if (!id || !message?.trim()) {
			return this.errorResult(
				"send",
				"invalid_parameters",
				"send requires id and message.",
			);
		}
		try {
			const text = await this.sendInstruction(id, message, delivery);
			return this.result("send", text, [this.requireRecord(id)]);
		} catch (error) {
			return this.errorResult(
				"send",
				"send_failed",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	private async restartResult(
		id: string | undefined,
		message: string | undefined,
	): Promise<AgentToolResult<SubagentDetails>> {
		if (!id)
			return this.errorResult(
				"restart",
				"invalid_parameters",
				"restart requires id.",
			);
		try {
			const text = await this.restartAgent(id, message);
			return this.result("restart", text, [this.requireRecord(id)]);
		} catch (error) {
			return this.errorResult(
				"restart",
				"restart_failed",
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
				"stop requires id.",
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

	private clearResult(
		id: string | undefined,
	): AgentToolResult<SubagentDetails> {
		const targets = id
			? [this.records.get(id)].filter((record): record is SubagentRecord =>
					Boolean(record),
				)
			: [...this.records.values()].filter((record) =>
					isTerminalStatus(record.status),
				);
		if (id && targets.length === 0)
			return this.errorResult(
				"clear",
				"not_found",
				`Unknown subagent id: ${id}.`,
			);
		const nonTerminal = targets.find(
			(record) => !isTerminalStatus(record.status),
		);
		if (nonTerminal) {
			return this.errorResult(
				"clear",
				"still_running",
				`${nonTerminal.id} is ${nonTerminal.status}; stop it before clearing.`,
			);
		}
		for (const record of targets) {
			this.removeFromQueue(record.id);
			this.releaseSession(record);
			this.records.delete(record.id);
		}
		this.stateChanged();
		return this.result(
			"clear",
			`Cleared ${targets.length} terminal subagent record${targets.length === 1 ? "" : "s"}.`,
		);
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
		this.invalidateSnapshots();
		this.syncWidget();
		this.requestPanelRender();
	}

	/** Show the footer widget while records exist; remove it when the session has none. */
	private syncWidget(): void {
		const ctx = this.ctx;
		if (!ctx || ctx.mode !== "tui") return;
		const shouldShow = !this.disposed && this.records.size > 0;
		if (shouldShow === this.widgetVisible) {
			this.widget?.requestRender();
			return;
		}
		this.widgetVisible = shouldShow;
		if (shouldShow) {
			ctx.ui.setWidget(
				SUBAGENT_WIDGET_KEY,
				(tui, theme) => {
					const widget = new SubagentFooterWidget(
						tui,
						theme,
						() => this.getSnapshots(),
						() => !this.panelOpenedThisSession,
					);
					this.widget = widget;
					return widget;
				},
				{ placement: "belowEditor" },
			);
		} else {
			this.widget = undefined;
			ctx.ui.setWidget(SUBAGENT_WIDGET_KEY, undefined);
		}
	}

	private requestPanelRender(): void {
		// Every controller-side caller invokes this after mutating a record, so
		// it doubles as a snapshot invalidation point (panel-internal scrolling
		// renders bypass the controller entirely).
		this.invalidateSnapshots();
		this.panel?.requestRender();
	}
}

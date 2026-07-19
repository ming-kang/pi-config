/**
 * subagent — isolated background AgentSession workers with statusline status
 * and an interactive fleet panel (Alt+O) for transcript, steer, and stop.
 *
 * Always-on chrome is only a statusline chip. Alt+O opens a capturing overlay
 * session view (Tab workers, Enter to send, Esc close). /agents is settings only.
 *
 * Security: workers share the parent process OS permissions and credentials.
 * Tool allowlists and cwd bounds reduce accidents; they are not a sandbox.
 */
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolExecutionMode,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, fuzzyFilter } from "@earendil-works/pi-tui";

import { buildSubagentToolDescription, discoverAgents } from "./agents.ts";
import {
	AGENTS_COMMAND_NAME,
	SUBAGENT_CONFIG_ENTRY_TYPE,
	SUBAGENT_PROMPT_GUIDELINES,
	SUBAGENT_PROMPT_SNIPPET,
	SUBAGENT_TOOL_DESCRIPTION,
	SUBAGENT_TOOL_LABEL,
	SUBAGENT_TOOL_NAME,
} from "./constants.ts";
import { SubagentController } from "./controller.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import { SubagentParamsSchema, type SubagentParams } from "./schema.ts";
import type { SubagentConfig, SubagentDetails } from "./types.ts";

function replayConfig(
	ctx: ExtensionContext,
): Partial<SubagentConfig> | undefined {
	let latest: Partial<SubagentConfig> | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (
			entry.type !== "custom" ||
			entry.customType !== SUBAGENT_CONFIG_ENTRY_TYPE
		)
			continue;
		if (!entry.data || typeof entry.data !== "object") continue;
		const data = entry.data as Record<string, unknown>;
		latest = {
			...(typeof data.maxConcurrency === "number"
				? { maxConcurrency: data.maxConcurrency }
				: {}),
			...(typeof data.maxAgents === "number"
				? { maxAgents: data.maxAgents }
				: {}),
		};
	}
	return latest;
}

/** Normalize legacy / alias fields before schema validation paths in execute. */
function prepareSubagentArguments(args: unknown): SubagentParams {
	if (!args || typeof args !== "object") return args as SubagentParams;
	const input = { ...(args as Record<string, unknown>) };

	if (input.action === "list") {
		delete input.id;
		input.action = "read";
	} else if (input.action === "restart") {
		input.action = "send";
		input.fresh = true;
	}

	// Spawn-first: prompt/task without action → spawn.
	if (
		input.action === undefined &&
		(typeof input.prompt === "string" ||
			typeof input.task === "string" ||
			Array.isArray(input.tasks))
	) {
		input.action = "spawn";
	}

	// Aliases.
	if (input.prompt !== undefined && input.task === undefined) {
		input.task = input.prompt;
	}
	if (input.task !== undefined && input.prompt === undefined) {
		input.prompt = input.task;
	}
	if (input.description !== undefined && input.label === undefined) {
		input.label = input.description;
	}
	if (input.label !== undefined && input.description === undefined) {
		input.description = input.label;
	}
	if (input.thinking !== undefined && input.thinkingLevel === undefined) {
		input.thinkingLevel = input.thinking;
	}
	if (input.thinkingLevel !== undefined && input.thinking === undefined) {
		input.thinking = input.thinkingLevel;
	}

	// Dropped from the model contract (security / simplicity). Silently ignore
	// so resume does not fail schema validation on extras some providers echo.
	delete input.tools;
	delete input.delivery;
	delete input.maxConcurrency;
	delete input.maxAgents;
	delete input.confirmProjectAgents;

	if (Array.isArray(input.tasks)) {
		input.tasks = input.tasks.map((task) => {
			if (!task || typeof task !== "object") return task;
			const next = { ...(task as Record<string, unknown>) };
			if (next.prompt !== undefined && next.task === undefined)
				next.task = next.prompt;
			if (next.task !== undefined && next.prompt === undefined)
				next.prompt = next.task;
			if (next.description !== undefined && next.label === undefined)
				next.label = next.description;
			if (next.label !== undefined && next.description === undefined)
				next.description = next.label;
			if (next.thinking !== undefined && next.thinkingLevel === undefined)
				next.thinkingLevel = next.thinking;
			if (next.thinkingLevel !== undefined && next.thinking === undefined)
				next.thinking = next.thinkingLevel;
			delete next.tools;
			return next;
		});
	}

	return input as SubagentParams;
}

export default function subagent(pi: ExtensionAPI): void {
	const controller = new SubagentController(pi);

	pi.registerTool({
		name: SUBAGENT_TOOL_NAME,
		label: SUBAGENT_TOOL_LABEL,
		description: SUBAGENT_TOOL_DESCRIPTION,
		promptSnippet: SUBAGENT_PROMPT_SNIPPET,
		promptGuidelines: SUBAGENT_PROMPT_GUIDELINES,
		parameters: SubagentParamsSchema,
		prepareArguments(args) {
			return prepareSubagentArguments(args);
		},
		executionMode: "sequential" as ToolExecutionMode,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Refresh description with project agents when cwd is known (best-effort).
			return controller.execute(params, ctx);
		},

		renderCall(args, theme) {
			return renderSubagentCall(args, theme);
		},
		renderResult(result, options, theme, context) {
			return renderSubagentResult(
				result as AgentToolResult<SubagentDetails>,
				options,
				theme,
				context.isError,
			);
		},
	});

	// Tool execute results cannot set Pi's error flag directly. Preserve the
	// structured controller details, then mark expected operation failures in
	// the official result middleware instead of throwing them away.
	pi.on("tool_result", (event) => {
		if (event.toolName !== SUBAGENT_TOOL_NAME) return;
		const details = event.details as SubagentDetails | undefined;
		if (details?.errorCode) return { isError: true };
		return undefined;
	});

	pi.registerCommand(AGENTS_COMMAND_NAME, {
		description:
			"Subagent settings: profiles, concurrency limits, clear finished workers",
		getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
			const settingsMatch = /^settings\s+(.*)$/.exec(prefix);
			if (settingsMatch) {
				const cwd = controller.getBoundCwd();
				if (!cwd) return null;
				const items = discoverAgents(cwd, "both").agents.map((agent) => ({
					value: `settings ${agent.name}`,
					label: agent.name,
					description: `${agent.source} · ${agent.description}`,
				}));
				const filtered = fuzzyFilter(
					items,
					settingsMatch[1] ?? "",
					(item) => item.label,
				);
				return filtered.length ? filtered : null;
			}
			const clearMatch = /^clear\s+(.*)$/.exec(prefix);
			if (clearMatch) {
				const items: AutocompleteItem[] = [
					{
						value: "clear all",
						label: "all",
						description: "clear every terminal record",
					},
					...controller
						.getCompletionWorkers()
						.filter((worker) =>
							["completed", "failed", "stopped"].includes(worker.status),
						)
						.map((worker) => ({
							value: `clear ${worker.id}`,
							label: worker.id,
							description: `${worker.status} · ${worker.label}`,
						})),
				];
				const filtered = fuzzyFilter(
					items,
					clearMatch[1] ?? "",
					(item) => item.label,
				);
				return filtered.length ? filtered : null;
			}
			const items: AutocompleteItem[] = [
				{
					value: "settings",
					label: "settings",
					description: "configure profile model/thinking",
				},
				{
					value: "limits",
					label: "limits",
					description: "configure concurrency and retention",
				},
				{
					value: "clear",
					label: "clear",
					description: "clear terminal records",
				},
			];
			const filtered = fuzzyFilter(items, prefix, (item) => item.value);
			return filtered.length ? filtered : null;
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			if (input === "settings" || input.startsWith("settings ")) {
				if (!ctx.hasUI) {
					ctx.ui.notify(
						`/${AGENTS_COMMAND_NAME} settings requires an interactive UI.`,
						"warning",
					);
					return;
				}
				await controller.openSettingsMenu(
					ctx,
					input.slice("settings".length).trim() || undefined,
				);
				return;
			}
			if (input === "limits") {
				if (!ctx.hasUI) {
					ctx.ui.notify(
						`/${AGENTS_COMMAND_NAME} limits requires an interactive UI.`,
						"warning",
					);
					return;
				}
				await controller.openLimitsMenu(ctx);
				return;
			}
			if (input === "clear" || input.startsWith("clear ")) {
				if (!ctx.hasUI) {
					ctx.ui.notify(
						`/${AGENTS_COMMAND_NAME} clear requires an interactive UI.`,
						"warning",
					);
					return;
				}
				const requested = input.slice("clear".length).trim();
				const id = requested && requested !== "all" ? requested : undefined;
				try {
					ctx.ui.notify(controller.clearAgents(id), "info");
				} catch (error) {
					ctx.ui.notify(
						error instanceof Error ? error.message : String(error),
						"warning",
					);
				}
				return;
			}
			if (input.startsWith("limits ")) {
				ctx.ui.notify(`Usage: /${AGENTS_COMMAND_NAME} limits`, "info");
				return;
			}
			// Default: settings root menu (no worker panel).
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`/${AGENTS_COMMAND_NAME} requires an interactive UI.`,
					"warning",
				);
				return;
			}
			if (input) {
				ctx.ui.notify(
					`Unknown argument "${input}" — usage: /agents · /agents settings [profile] · /agents limits · /agents clear [id|all]`,
					"info",
				);
			}
			await controller.openSettingsRoot(ctx);
		},
	});

	pi.registerShortcut("alt+o", {
		description: "Open subagent fleet panel (transcript / steer / stop)",
		handler: async (ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("Subagent panel requires the Pi TUI.", "warning");
				return;
			}
			await controller.openPanel(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await controller.loadPreferences(ctx);
		controller.bindContext(ctx, replayConfig(ctx));
		// Best-effort: widen tool description with discovered agents for this cwd.
		// Pi reads description at register time; dynamic rebuild is not always
		// re-injected mid-session, but prepareArguments + guidelines cover usage.
		void buildSubagentToolDescription(ctx.cwd);
	});

	pi.on("session_tree", async (_event, ctx) => {
		controller.bindContext(ctx, replayConfig(ctx));
	});

	pi.on("session_shutdown", async () => {
		await controller.dispose();
	});
}

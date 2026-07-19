/**
 * subagent — isolated background AgentSession workers with parent feedback.
 *
 * Interaction model (closest Pi-native approximation of Claude Code's
 * background-agent UX, deliberately minimal in keys and concepts): a
 * persistent below-editor widget lists workers with a live pulse spinner,
 * elapsed time, and output tokens; the single `/agents` command opens one
 * focused transcript overlay — the widget is the list, the overlay is the
 * interaction. `/agents settings` configures profiles, `/agents limits`
 * configures deployment bounds, and `/agents clear` removes terminal records.
 * The extension registers no global shortcuts, keeping that namespace clean.
 * Inside the overlay only universal keys apply: Enter does the one
 * state-appropriate action, Tab cycles workers, arrows/PgUp/PgDn/Home/End
 * scroll, ctrl+c stops the running worker (or closes when idle), Esc closes.
 * The hint line shows only currently-usable keys.
 *
 * Security: workers share the parent process OS permissions and credentials.
 * Tool allowlists and cwd bounds reduce accidents; they are not a sandbox.
 * Project agent definitions require interactive confirmation. Skills are not
 * loaded into workers by default.
 *
 * Pi's public TUI API supports focused keyboard overlays plus passive widgets
 * but no footer hit-testing, focus transfer into widgets, or mouse events; Pi
 * renders into the normal terminal screen, so the mouse wheel always scrolls
 * terminal scrollback and panel scrolling is keyboard-only. Pi's generic
 * custom-tool fallback dumps full retained snapshots, so this extension owns a
 * small private call/result renderer with Ctrl+O expansion.
 */
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolExecutionMode,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, fuzzyFilter } from "@earendil-works/pi-tui";

import { discoverAgents } from "./agents.ts";
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

export default function subagent(pi: ExtensionAPI): void {
	const controller = new SubagentController(pi);

	pi.registerTool({
		name: SUBAGENT_TOOL_NAME,
		label: SUBAGENT_TOOL_LABEL,
		description: SUBAGENT_TOOL_DESCRIPTION,
		promptSnippet: SUBAGENT_PROMPT_SNIPPET,
		promptGuidelines: SUBAGENT_PROMPT_GUIDELINES,
		parameters: SubagentParamsSchema,
		// Resumed sessions may replay calls emitted under the previous contract.
		// Strip knobs that left the model surface (tools/delivery/limits/confirm)
		// so old transcripts still validate; map retired action names.
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args as SubagentParams;
			const input = { ...(args as Record<string, unknown>) };
			if (input.action === "list") {
				delete input.id;
				input.action = "read";
			} else if (input.action === "restart") {
				input.action = "send";
				input.fresh = true;
			}
			// Dropped from the model contract (security / simplicity). Silently
			// ignore so resume does not fail schema validation on extras that
			// some providers still echo back.
			delete input.tools;
			delete input.delivery;
			delete input.maxConcurrency;
			delete input.maxAgents;
			delete input.confirmProjectAgents;
			if (Array.isArray(input.tasks)) {
				input.tasks = input.tasks.map((task) => {
					if (!task || typeof task !== "object") return task;
					const next = { ...(task as Record<string, unknown>) };
					delete next.tools;
					return next;
				});
			}
			return input as SubagentParams;
		},
		executionMode: "sequential" as ToolExecutionMode,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
			"Background subagents: open a worker, configure profile/limits, or clear terminal records",
		getArgumentCompletions: (prefix): AutocompleteItem[] | null => {
			// The returned value replaces the whole argument text after
			// "/agents ", so profile items must carry the "settings " prefix.
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
				...controller.getCompletionWorkers().map((worker) => ({
					value: worker.id,
					label: worker.id,
					description: `${worker.status} · ${worker.label} [${worker.agentName}]`,
				})),
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
				ctx.ui.notify(
					`Usage: /${AGENTS_COMMAND_NAME} limits`,
					"info",
				);
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					`/${AGENTS_COMMAND_NAME} requires the Pi TUI.`,
					"warning",
				);
				return;
			}
			let id: string | undefined = input || undefined;
			if (id && !controller.hasAgent(id)) {
				ctx.ui.notify(
					`Unknown subagent "${id}" — usage: /agents [id] · /agents settings [profile] · /agents limits · /agents clear [id|all]`,
					"info",
				);
				id = undefined;
			}
			await controller.openPanel(ctx, id);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await controller.loadPreferences(ctx);
		controller.bindContext(ctx, replayConfig(ctx));
	});

	pi.on("session_tree", async (_event, ctx) => {
		controller.bindContext(ctx, replayConfig(ctx));
	});

	pi.on("session_shutdown", async () => {
		await controller.dispose();
	});
}

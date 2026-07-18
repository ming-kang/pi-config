/**
 * subagent — isolated background AgentSession workers with parent feedback.
 *
 * Interaction model (closest Pi-native approximation of Claude Code's
 * background-agent UX, deliberately minimal in keys and concepts): a
 * persistent below-editor widget lists workers with a live pulse spinner,
 * elapsed time, and output tokens; the single `/agents` command opens one
 * focused transcript overlay — the widget is the list, the overlay is the
 * interaction. `/agents settings` opens profile model/thinking configuration.
 * The extension registers no global shortcuts, keeping that namespace clean.
 * Inside the overlay only universal keys apply: Enter does the one
 * state-appropriate action, Tab cycles workers, arrows/PgUp/PgDn/Home/End
 * scroll, ctrl+c stops the running worker (or closes when idle), Esc closes.
 * The hint line shows only currently-usable keys.
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
import { SubagentParamsSchema } from "./schema.ts";
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
		executionMode: "sequential" as ToolExecutionMode,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await controller.execute(params, ctx);
			if (result.details?.errorCode) {
				const first = result.content[0];
				throw new Error(
					first?.type === "text"
						? first.text
						: `Subagent operation failed (${result.details.errorCode}).`,
				);
			}
			return result;
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

	pi.registerCommand(AGENTS_COMMAND_NAME, {
		description:
			"Background subagents: /agents [id] opens the panel, /agents settings [profile] configures profiles",
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
					`Unknown subagent "${id}" — usage: /agents [id] · /agents settings [profile]`,
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

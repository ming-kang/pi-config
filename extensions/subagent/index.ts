/**
 * subagent — isolated background AgentSession workers with parent feedback.
 *
 * Pi's public TUI API supports focused keyboard overlays but does not expose
 * footer hit-testing or mouse events to extension Components. The statusline is
 * therefore informational; `/subagents` and Ctrl+Alt+A open the right-side
 * manager. The panel is an experimental Pi overlay, not a permanent split pane.
 * Pi's generic custom-tool fallback also dumps full retained snapshots and does
 * not provide a useful collapsed view, so this extension owns a small private
 * call/result renderer with Ctrl+O expansion.
 */
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolExecutionMode,
} from "@earendil-works/pi-coding-agent";

import {
	SUBAGENT_CONFIG_ENTRY_TYPE,
	SUBAGENT_PROMPT_GUIDELINES,
	SUBAGENT_PROMPT_SNIPPET,
	SUBAGENT_SETTINGS_COMMAND_NAME,
	SUBAGENT_TOOL_DESCRIPTION,
	SUBAGENT_TOOL_LABEL,
	SUBAGENT_TOOL_NAME,
	SUBAGENTS_COMMAND_NAME,
	SUBAGENTS_SHORTCUT,
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

	pi.registerCommand(SUBAGENTS_COMMAND_NAME, {
		description:
			"Open the background subagent manager (optionally pass an agent id)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/subagents requires the Pi TUI.", "warning");
				return;
			}
			await controller.openPanel(ctx, args.trim() || undefined);
		},
	});

	pi.registerCommand(SUBAGENT_SETTINGS_COMMAND_NAME, {
		description:
			"Configure inherited or explicit model/thinking settings for subagent profiles",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/subagent requires an interactive UI.", "warning");
				return;
			}
			await controller.openSettingsMenu(ctx, args.trim() || undefined);
		},
	});

	pi.registerShortcut(SUBAGENTS_SHORTCUT, {
		description: "Open background subagents",
		handler: async (ctx) => {
			if (ctx.mode !== "tui") return;
			await controller.openPanel(ctx);
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

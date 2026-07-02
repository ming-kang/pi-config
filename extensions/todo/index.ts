/**
 * todo — Pi-native task tracking for multi-step work.
 *
 * The state is intentionally conversation-backed: every tool result carries a
 * full snapshot in `details`, and lifecycle handlers replay the current branch.
 * This keeps /reload, compaction, and session-tree navigation aligned with the
 * conversation without adding a separate disk database. (Compaction-safe by
 * design: sessionManager.getBranch() returns the FULL branch history including
 * pre-compaction toolResult entries — only buildSessionContext summarizes.)
 *
 * State is keyed per session id (see state.ts): resume and /tree switches can
 * change the session within one process, and execute + lifecycle handlers
 * re-point the active bucket before touching state.
 */
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { TodoOverlay } from "./overlay.ts";
import { activeDotLine, callLine, errorResultLine, firstText, resultLine } from "../tools-view/shared.ts";
import { requireInteractiveUI } from "../shared/extension-ui.ts";
import { firstLine } from "../shared/text.ts";
import {
	applyTodoMutation,
	buildTodoDetails,
	commitTodoState,
	formatTodoContent,
	getTodoState,
	replaceTodoState,
	replayTodosFromBranch,
	setActiveTodoSession,
} from "./state.ts";
import {
	TODO_PROMPT_GUIDELINES,
	TODO_PROMPT_SNIPPET,
	TODOS_COMMAND_NAME,
	TODO_TOOL_DESCRIPTION,
	TODO_TOOL_LABEL,
	TODO_TOOL_NAME,
} from "./constants.ts";
import { TodoParamsSchema, type TodoDetails, type TodoParams, type TodoStatus } from "./schema.ts";
import { formatCommandList, STATUS_MARK, STATUS_COLOR } from "./view.ts";

interface TodoSessionCtx {
	sessionManager: { getBranch(): Iterable<unknown>; getSessionId(): string };
}

function safeReplay(ctx: TodoSessionCtx): void {
	setActiveTodoSession(ctx.sessionManager.getSessionId());
	try {
		replaceTodoState(replayTodosFromBranch(ctx));
	} catch (error) {
		if (!/stale after session replacement/.test(String(error))) throw error;
	}
}

export default function todo(pi: ExtensionAPI): void {
	let overlay: TodoOverlay | undefined;

	pi.registerTool({
		name: TODO_TOOL_NAME,
		label: TODO_TOOL_LABEL,
		description: TODO_TOOL_DESCRIPTION,
		promptSnippet: TODO_PROMPT_SNIPPET,
		promptGuidelines: TODO_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,
		renderShell: "self",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<TodoDetails>> {
			// Re-point the active bucket: resume//tree can switch sessions between
			// lifecycle events and this call.
			setActiveTodoSession(ctx.sessionManager.getSessionId());
			const result = applyTodoMutation(getTodoState(), params);
			commitTodoState(result.state);
			const text = formatTodoContent(result.operation, result.state);
			return {
				content: [{ type: "text", text }],
				details: buildTodoDetails(params, result.state, result.operation),
			};
		},

		renderCall(args, theme) {
			const state = getTodoState();
			let suffix = theme.fg("muted", args.action);
			if (args.action === "create" && args.subject) {
				suffix += ` ${theme.fg("dim", args.subject)}`;
			} else if ((args.action === "update" || args.action === "get" || args.action === "delete") && args.id !== undefined) {
				const subject = state.items.find((item) => item.id === args.id)?.subject;
				suffix += ` ${theme.fg("accent", subject ?? `#${args.id}`)}`;
			} else if (args.action === "list" && args.status) {
				suffix += ` ${theme.fg("dim", args.status)}`;
			}
			return new Text(callLine("Todo", suffix, theme), 0, 0);
		},

		renderResult(result, options, theme) {
			const details = result.details as TodoDetails | undefined;

			if (options.isPartial) {
				return new Text(activeDotLine("Todo", " Working...", theme), 0, 0);
			}

			if (details?.error) {
				return new Text(errorResultLine(details.error, options.expanded, theme), 0, 0);
			}

			const textContent = firstText(result);

			let status: TodoStatus | undefined;
			if (details) {
				const params = details.params as Partial<TodoParams>;
				if (details.action === "create") status = "pending";
				if (details.action === "update" && params.id !== undefined) {
					status = (params.status as TodoStatus | undefined) ?? details.items.find((item) => item.id === params.id)?.status;
				}
				if (details.action === "delete") status = "deleted";
			}

			if (status) {
				const label = `${STATUS_MARK[status]} ${status}`;
				return new Text(resultLine(theme.fg(STATUS_COLOR[status], label), theme), 0, 0);
			}

			if (!options.expanded) {
				const summary = firstLine(textContent, "ok");
				return new Text(resultLine(theme.fg("success", summary), theme), 0, 0);
			}

			let text = "";
			for (const line of textContent.split("\n")) {
				text += `\n  ${theme.fg("toolOutput", line)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand(TODOS_COMMAND_NAME, {
		description: "Show todos for the current conversation branch",
		handler: async (_args, ctx) => {
			if (!requireInteractiveUI(ctx, "/todos")) return;
			ctx.ui.notify(formatCommandList(getTodoState()), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		safeReplay(ctx);
		if (ctx.hasUI) {
			overlay ??= new TodoOverlay();
			overlay.setUI(ctx.ui);
			overlay.resetVisibility();
			overlay.update();
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		safeReplay(ctx);
		overlay?.resetVisibility();
		overlay?.update();
	});

	pi.on("session_tree", async (_event, ctx) => {
		safeReplay(ctx);
		overlay?.resetVisibility();
		overlay?.update();
	});

	pi.on("session_shutdown", async () => {
		overlay?.dispose();
		overlay = undefined;
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== TODO_TOOL_NAME || event.isError) return;
		overlay?.update();
	});

	pi.on("agent_start", async () => {
		overlay?.hideCompletedFromPreviousTurn();
	});
}

/**
 * todo — Pi-native task tracking for multi-step work.
 *
 * The state is intentionally conversation-backed: every tool result carries a
 * full snapshot in `details`, and lifecycle handlers replay the current branch.
 * This keeps /reload, compaction, and session-tree navigation aligned with the
 * conversation without adding a separate disk database.
 */
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { TodoOverlay } from "./overlay.ts";
import { activeDotLine, callLine, errLine, resultLine } from "../tools-view/shared.ts";
import {
	applyTodoMutation,
	buildTodoDetails,
	commitTodoState,
	formatTodoContent,
	getTodoState,
	replaceTodoState,
	replayTodosFromBranch,
} from "./state.ts";
import { TODOS_COMMAND_NAME, TODO_TOOL_LABEL, TODO_TOOL_NAME, TodoParamsSchema, type TodoDetails, type TodoParams, type TodoStatus } from "./types.ts";
import { formatCommandList, STATUS_MARK, STATUS_COLOR } from "./view.ts";

const DEFAULT_PROMPT_SNIPPET = "Track multi-step work with a small task list";

const DEFAULT_PROMPT_GUIDELINES = [
	"Use `todo` for work with three or more meaningful steps, user-provided task lists, or long sessions where progress can drift. Skip it for trivial one-step requests.",
	"Create short imperative tasks. Mark exactly one task in_progress before working on it, and mark it completed as soon as it is genuinely done.",
	"Do not mark a task completed when tests are failing, verification has not run, or the implementation is only partial.",
	"If a completed task turns out to need more work, set it back to in_progress instead of creating a duplicate.",
	"Use blockedBy for real dependencies. The tool rejects missing dependencies, deleted dependencies, self-dependencies, and dependency cycles.",
	"Use `list` to inspect current state and `/todos` only when the user asks to see the visible list.",
];

function safeReplay(ctx: Parameters<typeof replayTodosFromBranch>[0]): void {
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
		description:
			"Manage a task list for multi-step coding work. Actions: create, update, list, get, delete, clear. Statuses: pending, in_progress, completed, deleted. Supports blockedBy dependencies with cycle checks.",
		promptSnippet: DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: DEFAULT_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,
		renderShell: "self",

		async execute(_toolCallId, params): Promise<AgentToolResult<TodoDetails>> {
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
			return new Text(callLine("Todo", suffix, theme, "warning"), 0, 0);
		},

		renderResult(result, options, theme) {
			const details = result.details as TodoDetails | undefined;

			if (options.isPartial) {
				return new Text(activeDotLine("Todo", " Working…", theme), 0, 0);
			}

			if (details?.error) {
				return new Text(errLine(details.error, theme), 0, 0);
			}

			const textContent = result.content.find((part) => part.type === "text")?.text ?? "";

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
				const summary = textContent.split("\n")[0] || "ok";
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
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires an interactive UI.", "warning");
				return;
			}
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

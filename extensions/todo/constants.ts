/**
 * todo/constants.ts — tool identity, command name, and prompt copy.
 *
 * Name/label/command live here so `index.ts` only assembles the tool, matching
 * the advisor/question/deepwiki constants.ts pattern. Prompt copy is the
 * model-facing contract; keep it stable.
 */

export const TODO_TOOL_NAME = "todo";
export const TODO_TOOL_LABEL = "Todo";
export const TODOS_COMMAND_NAME = "todos";

export const TODO_TOOL_DESCRIPTION =
	"Manage a small conversation-backed task list for multi-step coding work. Use it to create, update, inspect, delete, or clear outcome-oriented tasks with pending/in_progress/completed/deleted status. Supports blockedBy dependencies with validation and cycle checks.";

export const TODO_PROMPT_SNIPPET =
	"Track multi-step coding work with a small outcome-oriented task list";

export const TODO_PROMPT_GUIDELINES = [
	"Use `todo` for work with three or more meaningful steps, user-provided task lists, long sessions, or changes where progress can drift. Skip it for trivial one-step tasks and simple Q&A.",
	"Keep `todo` lists short and outcome-oriented: create tasks as imperative verb phrases that represent reviewable units of work, not every command or micro-step.",
	"Maintain at most one `todo` item in_progress. Mark the next task in_progress before working on it, and mark it completed only after implementation and relevant verification for that task are genuinely done.",
	"Do not mark a `todo` item completed when tests/checks are failing, verification has not run, or the implementation is only partial.",
	"If a completed `todo` item turns out to need more work, update it back to in_progress or pending instead of creating a duplicate.",
	"Delete obsolete or no-longer-needed `todo` items promptly so the list reflects remaining work.",
	"Use blockedBy only for real dependencies. The tool rejects missing dependencies, deleted dependencies, self-dependencies, and dependency cycles.",
	"Use `list` to inspect current state and `/todos` only when the user asks to see the visible list.",
];

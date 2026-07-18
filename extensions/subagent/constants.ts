/** Model-facing identity and bounded runtime defaults for the subagent extension. */

export const SUBAGENT_TOOL_NAME = "subagent";
export const SUBAGENT_TOOL_LABEL = "Subagent";
/** Named -settings (not /subagent) so it cannot be confused with /subagents. */
export const SUBAGENT_SETTINGS_COMMAND_NAME = "subagent-settings";
export const SUBAGENTS_COMMAND_NAME = "subagents";
/** The single global shortcut: jump into the most relevant worker's transcript. */
export const SUBAGENT_VIEW_SHORTCUT = "alt+o" as const;

export const SUBAGENT_STATUS_KEY = "subagent";
export const SUBAGENT_WIDGET_KEY = "subagent";
export const SUBAGENT_CONFIG_ENTRY_TYPE = "pi-config-subagent-config";
export const SUBAGENT_NOTIFICATION_TYPE = "pi-config-subagent-notification";
export const SUBAGENT_USER_CONFIG_VERSION = 1;

export const DEFAULT_MAX_CONCURRENCY = 3;
export const DEFAULT_MAX_AGENTS = 16;
export const HARD_MAX_CONCURRENCY = 8;
export const HARD_MAX_AGENTS = 32;
export const MAX_BATCH_TASKS = 16;

/** Bounded parent-visible output; the live panel retains a larger in-memory timeline. */
export const COMPLETION_OUTPUT_CHARS = 24_000;
export const READ_OUTPUT_CHARS = 32_000;
export const TIMELINE_MAX_ITEMS = 400;
export const TIMELINE_MAX_CHARS = 120_000;

export const SUBAGENT_TOOL_DESCRIPTION = [
	"Launch and control isolated background Pi AgentSession workers.",
	"Actions: spawn one task or a batch; list/read progress; send steer or follow-up instructions; restart, stop, clear, or configure limits.",
	"Spawns return immediately. Completion is delivered back to the parent conversation automatically; do not poll with sleep/list/read while waiting.",
].join(" ");

export const SUBAGENT_PROMPT_SNIPPET =
	"Launch isolated background workers and later inspect, steer, continue, restart, or stop them";

export const SUBAGENT_PROMPT_GUIDELINES = [
	"Use `subagent` action `spawn` for bounded work that can proceed independently; the call returns immediately with stable subagent ids.",
	"After `subagent` action `spawn`, do not poll with `bash` sleep, `subagent` list, or `subagent` read merely to wait; finish the current turn or do other useful work because completion automatically queues a parent follow-up turn.",
	"Choose the `subagent` profile deliberately: `general` may edit, while `explorer`, `planner`, and `reviewer` are built-in read-only profiles; omitted model/thinking settings inherit through the configured profile chain.",
	"Use `subagent` action `list` or `read` only when the user requests progress or the result needs inspection; use `send` to steer or queue a follow-up, and `restart` only when a fresh context is preferable.",
	"Avoid assigning overlapping edits to multiple `subagent` workers because they share the requested working directory unless the tasks are explicitly coordinated.",
	"Use `subagent` action `configure`, or `maxConcurrency` on `spawn`, to bound concurrent deployments; set `maxTurns` on a task to cap runaway workers (the run is reported as completed with a turn-limit note when the cap is reached).",
];

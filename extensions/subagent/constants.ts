/** Model-facing identity and bounded runtime defaults for the subagent extension. */

export const SUBAGENT_TOOL_NAME = "subagent";
export const SUBAGENT_TOOL_LABEL = "Subagent";
/** Single command surface; no global shortcuts. `settings` is a subcommand. */
export const AGENTS_COMMAND_NAME = "agents";

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
export const ACTIVITY_MAX_ITEMS = 160;
export const ACTIVITY_MAX_CHARS = 40_000;
export const PANEL_FINAL_OUTPUT_CHARS = 120_000;
export const PANEL_RENDER_THROTTLE_MS = 80;

export const SUBAGENT_TOOL_DESCRIPTION = [
	"Launch and control isolated background Pi AgentSession workers.",
	"Actions: spawn one task or a batch; read the retained list or one snapshot; send state-aware instructions or fresh reruns; stop active work.",
	"Spawns return immediately. Completion is delivered back to the parent conversation automatically; do not poll while waiting.",
].join(" ");

export const SUBAGENT_PROMPT_SNIPPET =
	"Launch isolated background workers and later inspect, steer, continue, fresh-rerun, or stop them";

export const SUBAGENT_PROMPT_GUIDELINES = [
	"Use `subagent` action `spawn` for bounded work that can proceed independently; the call returns immediately with stable subagent ids.",
	"After `subagent` action `spawn`, do not poll with `bash` sleep or repeated `subagent` reads merely to wait; finish the current turn or do other useful work because completion automatically queues a parent follow-up turn.",
	"Choose the `subagent` profile deliberately: `general` may edit, while `explorer` is a built-in read-only reconnaissance profile; omitted model/thinking settings inherit through the configured profile chain.",
	"Use `subagent` action `read` without an id to list retained workers, or with an id only when the user requests progress or a result needs inspection; do not poll merely to wait.",
	"Use `subagent` action `send` to attach/steer/continue according to worker state; set `fresh: true` only when a new isolated context is preferable. Failed or stopped workers rerun fresh automatically.",
	"Avoid assigning overlapping edits to multiple `subagent` workers because they share the requested working directory unless the tasks are explicitly coordinated.",
	"Use `maxConcurrency` or `maxAgents` on `subagent` action `spawn` only when the deployment needs explicit bounds; queued workers start automatically as slots become available.",
];

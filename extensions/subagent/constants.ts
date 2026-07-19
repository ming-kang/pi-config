/** Model-facing identity and bounded runtime defaults for the subagent extension. */

export const SUBAGENT_TOOL_NAME = "subagent";
export const SUBAGENT_TOOL_LABEL = "Subagent";
/** Single command surface; no global shortcuts. `settings` is a subcommand. */
export const AGENTS_COMMAND_NAME = "agents";

/** Key for ctx.ui.setStatus — statusline middle slot when workers exist. */
export const SUBAGENT_STATUS_KEY = "subagent";
export const SUBAGENT_CONFIG_ENTRY_TYPE = "pi-config-subagent-config";
export const SUBAGENT_NOTIFICATION_TYPE = "pi-config-subagent-notification";
export const SUBAGENT_USER_CONFIG_VERSION = 1;

export const DEFAULT_MAX_CONCURRENCY = 3;
export const DEFAULT_MAX_AGENTS = 16;
export const HARD_MAX_CONCURRENCY = 8;
export const HARD_MAX_AGENTS = 32;
export const MAX_BATCH_TASKS = 16;

/**
 * Bounded parent-visible output. The live panel retains a larger in-memory
 * timeline that is not sent to the model via `read`.
 */
export const COMPLETION_OUTPUT_CHARS = 16_000;
export const READ_OUTPUT_CHARS = 8_000;
export const TIMELINE_MAX_ITEMS = 400;
export const TIMELINE_MAX_CHARS = 120_000;
export const ACTIVITY_MAX_ITEMS = 160;
export const ACTIVITY_MAX_CHARS = 40_000;
export const PANEL_FINAL_OUTPUT_CHARS = 120_000;
export const PANEL_RENDER_THROTTLE_MS = 80;

export const SUBAGENT_TOOL_DESCRIPTION = [
	"Launch and control isolated background Pi workers that share the parent process permissions (tool allowlists reduce accidents; they are not a sandbox).",
	"Actions: spawn (one task or tasks[] batch — returns ids immediately); read (compact list, or one result snapshot by id); send (steer/continue/fresh-rerun by id); stop (abort and notify).",
	"Completion is delivered automatically as a parent follow-up — do not poll with read, bash sleep, or busy-wait.",
	'Profiles: "general" may edit; "explorer" is read-only reconnaissance. Prefer explorer for search-only work.',
].join(" ");

export const SUBAGENT_PROMPT_SNIPPET =
	"Spawn isolated background workers; read/send/stop them by id (completion arrives automatically)";

export const SUBAGENT_PROMPT_GUIDELINES = [
	"Use `subagent` only for multi-step work that can proceed independently. Do not spawn for a known path, a single grep, or reading 1–3 files — use read/grep/find/ls directly.",
	"After `subagent` action `spawn`, do not poll with `bash` sleep or repeated `subagent` read merely to wait; finish the turn or do other useful work. Completion automatically queues a parent follow-up.",
	"Write each `subagent` task like a briefing for a smart colleague who cannot see this conversation: goal, relevant paths, constraints, and the expected report shape. Never write “based on your findings, implement…” — synthesize first, then give concrete instructions.",
	"Choose the `subagent` profile deliberately: `explorer` for read-only recon (default thinking is low); `general` when edits or shell writes are required. Omit model/thinking unless you must override the profile chain.",
	"For independent work, prefer one `subagent` spawn with `tasks[]` rather than serial spawns. Avoid overlapping edits in the same working directory unless the tasks are explicitly coordinated.",
	"Use `subagent` action `read` without an id for a compact status list, or with an id only when the user asks for progress or a completion was insufficient. Use `send` to steer/continue; failed/stopped workers rerun fresh automatically. Use `stop` to cancel.",
	"Never invent `subagent` results before the completion follow-up arrives. Summarize results for the user yourself — worker output is not shown to them automatically.",
];

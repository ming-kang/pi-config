/** Model-facing identity and bounded runtime defaults for the subagent extension. */

export const SUBAGENT_TOOL_NAME = "subagent";
export const SUBAGENT_TOOL_LABEL = "Subagent";
/** Settings command; live preview is automatic (no panel open). */
export const AGENTS_COMMAND_NAME = "agents";

/** Key for statusline middle chip (setStatus). */
export const SUBAGENT_STATUS_KEY = "subagent";
/** @deprecated cleared on bind for older widget-based previews */
export const SUBAGENT_PREVIEW_KEY = "pi-config-subagent-preview";
export const SUBAGENT_CONFIG_ENTRY_TYPE = "pi-config-subagent-config";
export const SUBAGENT_NOTIFICATION_TYPE = "pi-config-subagent-notification";
export const SUBAGENT_USER_CONFIG_VERSION = 1;

export const DEFAULT_MAX_CONCURRENCY = 3;
export const DEFAULT_MAX_AGENTS = 16;
export const HARD_MAX_CONCURRENCY = 8;
export const HARD_MAX_AGENTS = 32;
export const MAX_BATCH_TASKS = 16;

/**
 * Bounded parent-visible output. The live preview retains a larger in-memory
 * activity list that is not sent to the model via `read`.
 */
export const COMPLETION_OUTPUT_CHARS = 16_000;
export const READ_OUTPUT_CHARS = 8_000;
export const TIMELINE_MAX_ITEMS = 400;
export const TIMELINE_MAX_CHARS = 120_000;
export const ACTIVITY_MAX_ITEMS = 160;
export const ACTIVITY_MAX_CHARS = 40_000;
export const PANEL_FINAL_OUTPUT_CHARS = 120_000;
export const PANEL_RENDER_THROTTLE_MS = 80;

export const SUBAGENT_PROMPT_SNIPPET =
	"Launch a focused background worker; completion arrives automatically (do not poll)";

export const SUBAGENT_PROMPT_GUIDELINES = [
	"Use `subagent` only for multi-step work that can proceed independently. Do not spawn for a known path, a single grep, or reading 1–3 files — use read/grep/find/ls directly.",
	"After spawn, do not poll with bash sleep or `subagent` read merely to wait; finish the turn or do other useful work. Completion automatically queues a parent follow-up.",
	"Write each prompt as a briefing for a smart colleague who cannot see this conversation: goal, relevant paths, constraints, and the expected report shape. Set `description` to a short 3–8 word UI label.",
	'Choose the agent deliberately: `explorer` for read-only recon; `general` when edits or shell writes are required. Prefer one spawn with `tasks[]` for independent parallel work.',
];

/** Static fallback when dynamic agent list is unavailable. */
export const SUBAGENT_TOOL_DESCRIPTION = [
	"Launch specialized background workers that share the parent process permissions (tool allowlists reduce accidents; they are not a sandbox).",
	"Default action is spawn (prompt/task + short description). Also: read (list or snapshot by id), send (steer/continue/fresh-rerun), stop (abort and notify).",
	"Completion is delivered automatically as a parent follow-up — do not poll.",
	'Profiles: "general" may edit; "explorer" is read-only reconnaissance. Prefer explorer for search-only work.',
].join(" ");

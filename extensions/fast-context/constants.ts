/** Tool/command identifiers and prompt text. */

export const TOOL_NAME = "fast_context_search";
export const TOOL_LABEL = "Fast Context";

export const CMD = "fast-context";

export const TOOL_DESCRIPTION =
	"Semantic code discovery for the current local repo. Prefer it when relevant files are unknown and the " +
	"task needs exploratory, behavioral, architectural, or cross-module understanding, especially in large " +
	"or unfamiliar codebases. Use concise English queries for best semantic matching, preserving code " +
	"identifiers and exact literals when useful. Returns candidate paths, line ranges, and grep keywords " +
	"only; verify with read/grep before editing. For known paths, exact symbols, filenames, literals, or " +
	"existence checks, use local find/grep/read directly.";

export const PROMPT_SNIPPET =
	"Use fast_context_search first for semantic discovery of unknown local code by behavior/concept, preferably with an English query; verify with read/grep";

// Deliberately makes Fast Context the early choice for unknown-code semantic
// discovery only. Exact local questions should still use Pi's grep/read/find.
export const PROMPT_GUIDELINES = [
	"Prefer `fast_context_search` early for non-trivial local code research when relevant files are unknown, especially for exploratory search, architecture tracing, feature/refactor planning, bug-flow discovery, onboarding, or cross-module behavior.",
	"Use `fast_context_search` for natural-language code discovery: describe the behavior, flow, error, API, business logic, or domain concept you want to locate rather than only a bare keyword.",
	"Write `fast_context_search` queries in English for best semantic matching. If the user asks in Chinese, translate the intent into concise English while preserving code identifiers, API names, file names, exact errors, and user-facing literals.",
	"Do not use `fast_context_search` for known filenames, paths, exact symbols, literal strings, or yes/no existence checks. Use local find/grep/read for those, and use grep when exact existence matters.",
	"For quick coarse orientation with `fast_context_search`, use tree_depth=1, max_turns=1, and a small max_results. Use defaults for normal searches, and max_turns=4-5 only for complex cross-module tracing.",
	"For `fast_context_search` in monorepos or known subsystems, set project_path to the focused package/subtree when possible. Add exclude_paths for generated, vendored, build, or bulky directories if results are noisy or payloads/timeouts occur.",
	"Treat `fast_context_search` output as a reading list, not evidence. Read returned ranges before editing, and use grep keywords only as follow-up search hints.",
	"If `fast_context_search` returns no files or weak/noisy candidates, do not invent relevance. Retry once with a narrower English behavioral query or fall back to local grep/find/read.",
];

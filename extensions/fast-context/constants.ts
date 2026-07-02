/** Tool/command identifiers and prompt text. */

export const TOOL_NAME = "fast_context_search";
export const TOOL_LABEL = "Fast Context";

export const CMD = "fast-context";

export const TOOL_DESCRIPTION =
	"Semantic code discovery for the current local repo. Prefer it when relevant files are unknown and the " +
	"task needs exploratory, behavioral, architectural, or cross-module understanding, especially in large " +
	"or unfamiliar codebases. Describe the behavior, flow, error, or concept to locate (concise English " +
	"queries match best; see the query parameter). Returns candidate paths, line ranges, and grep keywords " +
	"only — a reading list, not evidence: read or grep the results before editing. For known paths, exact " +
	"symbols, filenames, literals, or existence checks, use local find/grep/read directly.";

export const PROMPT_SNIPPET =
	"Semantic discovery of unknown local code by behavior or concept; verify results with read/grep";

// Deliberately makes Fast Context the early choice for unknown-code semantic
// discovery only. Exact local questions should still use Pi's grep/read/find;
// parameter tuning (tree_depth/max_turns/max_results/project_path) lives in
// the schema field descriptions, not here.
export const PROMPT_GUIDELINES = [
	"Prefer `fast_context_search` early for non-trivial local code research when relevant files are unknown: exploration, architecture tracing, bug-flow discovery, feature or refactor planning.",
	"Do not use `fast_context_search` for known filenames, paths, exact symbols, literal strings, or existence checks; use local find/grep/read for those.",
	"Treat `fast_context_search` output as a reading list: read returned ranges before editing; if results are empty or weak, retry once with a narrower behavioral query or fall back to grep.",
];

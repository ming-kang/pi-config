/** Tool/command identifiers and prompt text. */

export const TOOL_NAME = "fast_context_search";
export const TOOL_LABEL = "Fast Context";

export const CMD = "fast-context";

export const TOOL_DESCRIPTION =
	"Semantic code retrieval for local repos. Use when the relevant files are unknown and the task is " +
	"conceptual, cross-module, or in a large/unfamiliar codebase. It returns candidate files, line " +
	"ranges, and grep keywords; verify with read/grep before editing. For known paths, exact symbols, filenames, " +
	"or literals, use grep/find/read directly.";

export const PROMPT_SNIPPET =
	"Use fast_context_search to locate unknown code by behavior/concept in large or unfamiliar local repos. It returns candidate paths/ranges plus grep keywords; read/grep to verify.";

// Deliberately positions this as one option among Pi's own grep/read/find, not a
// mandatory first step: it costs network round-trips against a third-party backend.
export const PROMPT_GUIDELINES = [
	"Use fast_context_search for exploratory retrieval: architecture tracing, feature/refactor planning, bug-flow discovery, or onboarding in a large or unfamiliar local repo when you do not know the files yet.",
	"Do not use it for known filenames, paths, exact symbols, or literal strings. Use find/grep/read for those, and use grep when exact existence matters.",
	"Write a short natural-language query, preferably in English; include domain terms, errors, APIs, or behavior, not just a bare keyword.",
	"Narrow project_path to the package/subtree you care about when possible. Add exclude_paths for generated, vendored, or bulky directories if results are noisy or payloads/timeouts occur.",
	"Use small max_results (3-8) for focused work. Use max_turns 1-2 for quick orientation, 3 for normal searches, and 4-5 only for complex cross-cutting flows.",
	"Treat returned files and ranges as starting context, not proof. Read the returned ranges before editing; use grep keywords only as follow-up search hints.",
	"If it returns no files or weak/noisy candidates, do not invent relevance. Retry with a narrower behavioral query or fall back to local grep/find/read.",
];

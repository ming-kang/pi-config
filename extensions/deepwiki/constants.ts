/**
 * constants.ts — deepwiki tool identity + prompt copy.
 *
 * Name/label/description/promptSnippet/promptGuidelines live here so
 * `index.ts` only assembles the tool, matching the advisor/constants.ts
 * pattern. Prompt copy is the model-facing contract; keep it stable.
 */

export const DEEPWIKI_TOOL_NAME = "deepwiki";
export const DEEPWIKI_LABEL = "DeepWiki";

export const DEEPWIKI_DESCRIPTION =
	"Query DeepWiki's generated documentation for public GitHub repositories. Best for understanding an unfamiliar repo, finding reference patterns while designing or building something, explaining architecture/APIs/implementation details, and comparing up to 10 public repos. Results are generated from indexed public repo snapshots and often include cited source files; they are not local workspace state or guaranteed-latest upstream facts.";

export const DEEPWIKI_PROMPT_SNIPPET =
	"Use DeepWiki for public GitHub repo architecture, APIs, implementation patterns, reference designs, and repo comparisons";

export const DEEPWIKI_PROMPT_GUIDELINES = [
	"Use `deepwiki` when the user wants to understand a public GitHub repository: architecture, module layout, APIs, extension points, data flow, onboarding, or where a concept lives.",
	"Use `deepwiki` as reference research while developing a new feature or project when public repos can provide implementation patterns, design tradeoffs, or examples to adapt.",
	"Use `question` for targeted questions; use repoName as an array of up to 10 repos when comparing libraries, frameworks, plugin systems, or implementation approaches.",
	"When these conditions apply, call `deepwiki` yourself instead of asking the user to open DeepWiki or paste docs.",
	"Use `structure` first when the repo is unfamiliar and you need the topic map; use `contents` only when broad generated docs and source-file citations are worth the larger output.",
	"Prefer repoName in owner/repo format; GitHub and DeepWiki URLs are accepted as fallback inputs, but do not pass package names or local paths.",
	"Do not use `deepwiki` for local workspace files, uncommitted changes, private repos, exact current HEAD, release dates, pricing, security advisories, or anything where freshness is required; use local tools or current primary sources instead.",
];

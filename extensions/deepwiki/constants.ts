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
	"Query DeepWiki's generated documentation for public GitHub repositories. Use for architecture, APIs, module layout, implementation patterns, onboarding, extension points, or cross-repo comparisons while designing or building. Supports topic maps, full generated wiki contents, and focused questions over up to 10 repos. Results describe indexed public snapshots and may include source citations; they are not local workspace state, private code, or guaranteed-fresh facts.";

export const DEEPWIKI_PROMPT_SNIPPET =
	"Use deepwiki for public GitHub repo architecture, APIs, implementation patterns, generated docs, and cross-repo comparisons";

export const DEEPWIKI_PROMPT_GUIDELINES = [
	"Use `deepwiki` to understand a public GitHub repo's architecture, module layout, APIs, extension points, data flow, onboarding path, or where a concept lives.",
	"Use `deepwiki` as reference research while developing a feature or project when public repos can provide implementation patterns, design tradeoffs, or examples to adapt.",
	"Call `deepwiki` yourself when those conditions apply; do not ask the user to open DeepWiki or paste generated docs unless the repo is private, unknown, or not identifiable.",
	"For `deepwiki`, use action `question` for targeted repo questions and compare up to 10 repos by passing repoName as an array.",
	"For `deepwiki`, use action `structure` before deep reading an unfamiliar repo; use action `contents` only when broad generated docs and source-file citations are worth the larger output.",
	"Pass repoName to `deepwiki` as owner/repo whenever possible. GitHub and DeepWiki URLs are accepted fallback inputs; package names and local paths are not valid repoName values.",
	"Do not use `deepwiki` for local workspace files, uncommitted changes, private repos, exact current HEAD, release dates, pricing, security advisories, or freshness-sensitive facts; use local tools or current primary sources instead.",
];

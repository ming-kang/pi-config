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
	"Query DeepWiki's AI-generated documentation for public GitHub repositories. Recommended flow: structure lists the wiki's pages; contents with page (title or 1-based index) reads one page — read pages selectively rather than pulling the whole wiki (omitting page returns everything, truncated past ~120k chars); question answers a focused query (up to 10 repos for comparisons) — reach for it when the wiki pages don't cover what you need, or on its own for a quick answer without reading. Use it for architecture, module layout, APIs, extension points, and implementation patterns when designing or building. Results describe indexed public snapshots and may cite sources; they are not local workspace state, private code, or guaranteed-fresh facts.";

export const DEEPWIKI_PROMPT_SNIPPET =
	"Query AI-generated docs for public GitHub repos: architecture, APIs, implementation patterns, cross-repo comparisons";

export const DEEPWIKI_PROMPT_GUIDELINES = [
	"Use `deepwiki` to understand a public GitHub repo's design or to mine reference implementations while building: run structure first, then read the specific pages you need with contents + page; avoid fetching the whole wiki (contents without page) unless it is genuinely small.",
	"Use `deepwiki` action question when the read pages don't cover what you need, or directly for a quick answer without reading; pass repoName as an array to compare up to 10 repos.",
	"Do not use `deepwiki` for local workspace files, private repos, exact current HEAD, or freshness-sensitive facts (releases, pricing, advisories); use local tools or current primary sources instead.",
];

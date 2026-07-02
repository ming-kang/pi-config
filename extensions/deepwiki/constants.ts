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
	"Query DeepWiki's AI-generated documentation for public GitHub repositories. Actions: structure lists a repo's wiki topics; contents reads the generated wiki (truncated past ~120k chars with omitted page titles listed — prefer question for specifics); question — the preferred action — answers a focused query and accepts up to 10 repos for comparisons. Use it for architecture, module layout, APIs, extension points, and implementation patterns when designing or building. Results describe indexed public snapshots and may cite sources; they are not local workspace state, private code, or guaranteed-fresh facts.";

export const DEEPWIKI_PROMPT_SNIPPET =
	"Query AI-generated docs for public GitHub repos: architecture, APIs, implementation patterns, cross-repo comparisons";

export const DEEPWIKI_PROMPT_GUIDELINES = [
	"Use `deepwiki` to understand a public GitHub repo's design or to mine reference implementations while building; prefer action question, run structure before deep-reading an unfamiliar repo, and pass repoName as an array to compare up to 10 repos.",
	"Do not use `deepwiki` for local workspace files, private repos, exact current HEAD, or freshness-sensitive facts (releases, pricing, advisories); use local tools or current primary sources instead.",
];

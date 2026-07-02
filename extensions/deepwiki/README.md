# DeepWiki

`deepwiki` is a Pi-native tool for querying DeepWiki's generated documentation for GitHub repositories.

It is intentionally not a general MCP bridge. The extension exposes one dedicated tool with three fixed actions:

| Action | Behavior |
|---|---|
| `structure` | List the generated wiki topics for a repository. |
| `contents` | Read the generated repository wiki. |
| `question` | Ask a focused question about a repository. |

## Tool Parameters

- `action`: `structure`, `contents`, or `question`
- `repoName`: GitHub repository in `owner/repo` format, or an array of up to 10 repositories for `question`
- `question`: required only for `action: "question"`

`repoName` is normalized before validation. `owner/repo` is the expected form, but common GitHub and DeepWiki URLs are accepted as a fallback. For model tolerance, comma-separated repo strings are also accepted and normalized into repo lists. If `action` is omitted, the tool defaults to `question` when a question is present and `structure` otherwise. `structure` and `contents` require exactly one repository.

## Usage Strategy

Use DeepWiki when generated docs for public repositories are useful context:

- Understanding an unfamiliar public repo's architecture, module layout, APIs, data flow, or extension points.
- Researching reference implementations while designing or building a new feature or project.
- Asking a focused question about how a public repo implements something.
- Comparing patterns or extension surfaces across multiple public repos with `question` and a repo array.
- Pulling a broad topic map with `structure` before deciding which part of a repo matters.

The prompt is model-facing: when these conditions apply, the model should call the tool itself instead of telling the user to open DeepWiki manually.

Avoid DeepWiki when the authoritative source is local or time-sensitive:

- Local workspace files, private code, uncommitted changes, or exact current checkout state.
- Latest releases, pricing, security advisories, schedules, or facts that need current primary-source verification.
- Package names without a known GitHub repo; resolve the repo first instead of guessing.

## Notes

- DeepWiki currently exposes this data through its public MCP HTTP endpoint; this extension calls only the three DeepWiki operations above.
- DeepWiki may return generated explanations with source-file citations and "related pages" links; collapsed rendering strips the navigation tail for concise summaries.
- `contents` responses are truncated at a ~120k-character budget on `# Page:` boundaries (whole pages kept in order; at least the first page survives, cut mid-page if it alone exceeds the budget). A trailing notice reports shown/total pages, the full length, up to 20 omitted page titles, and points at `action: "question"` for the rest. Details carry `shownPages` / `truncatedChars` when this happens; `outputLength` always reflects the full untruncated response.
- A repository may not be indexed. DeepWiki can return that as normal text, so the extension treats repository-not-found messages as tool errors.
- Successful responses are cached in-process for 10 minutes, keyed by action, repo, and question. Failed, aborted, and timed-out requests are not cached. The cache stores the full response; `contents` truncation is recomputed per call, so cached and fresh calls return identical text.
- Network requests time out after 45 seconds and surface as Pi tool errors.
- Use local Pi tools (`read`, `grep`, `find`, `ls`) for workspace state. DeepWiki answers describe repository snapshots indexed by DeepWiki, not local uncommitted files.

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
- `repoName`: GitHub repository in `owner/repo` format
- `question`: required only for `action: "question"`

## Notes

- DeepWiki currently exposes this data through its public MCP HTTP endpoint; this extension calls only the three DeepWiki operations above.
- Use local Pi tools (`read`, `grep`, `find`, `ls`) for workspace state. DeepWiki answers describe repository snapshots indexed by DeepWiki, not local uncommitted files.

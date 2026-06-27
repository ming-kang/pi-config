# read-before-edit — read before you write

Mirrors Claude Code's read-before-edit guard: the agent must `read` a file before it may `edit`/`write` it, and must re-read it if it changed on disk since the last read.

## Behavior

- Editing a file that was never read is blocked with *"File has not been read yet…"*. Creating a brand-new file (one that doesn't exist yet) is allowed without a read.
- If a file's mtime advanced but its raw content is identical to what was read (a common Windows false positive from cloud sync / antivirus), the edit is allowed.
- **Injected context files are not "read".** Files Pi injects into the system prompt (`AGENTS.md`, `CLAUDE.md`) never pass through the `read` tool, so editing one is blocked until you explicitly `read` it first.
- After `rewind` restores files, read-cache entries for changed paths are invalidated. Re-read a restored file before editing it again.

## Design notes

- **Two hooks, one cache.** `tool_result` records `{ content, mtime }`; `tool_call` (edit/write) gates the operation. The cache is the shared `extensions/shared/file-state.ts` (also invalidated by `rewind`).
- **Read-state is refreshed after the agent's own read, edit, and write** — not only `read`. Otherwise the agent's own edit bumps the file's mtime and content while the cache holds the pre-edit snapshot, so the next edit to the same file is wrongly blocked as "modified since read" (and a write-then-edit fails as "not read yet"). The `tool_call` gate runs *before* each edit, so a genuine external change is still caught first. This mirrors CC's FileWriteTool/FileEditTool.
- **Content cache bounds.** Raw content is cached only for files within the size budget; the cache is bounded to 100 entries / 25 MB total (FIFO eviction). Oversized files track mtime only and require a re-read when mtime changes.
- A soft `<read_before_edit>` constraint is appended to the system prompt each turn (the base prompt is rebuilt per turn, so it is not duplicated).

## Files

- `index.ts` — the whole extension (record hook, gate hook, soft constraint)
- uses `../shared/file-state.ts` — the shared read-state cache (not this extension's private module; `rewind` invalidates it after a restore)

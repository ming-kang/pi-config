# read-before-edit — read before you write

Mirrors Claude Code's read-before-edit guard: the agent must fully `read` a file before it may `edit`/`write` it, and must re-read it if it changed on disk since the last full read.

## Behavior

- Editing a file that was never read is blocked with *"File has not been read yet…"*. Creating a brand-new file (one that doesn't exist yet) is allowed without a read.
- **Partial and truncated reads do not count.** A `read` with `offset`/`limit`, or one that the read tool auto-truncated, is recorded as a partial view and blocks edit/write with the same "has not been read yet" message until a single full (untruncated, no offset/limit) read succeeds. Multi-offset continuation reads are not stitched into a full view.
- If a file's mtime advanced but its raw content is identical to what was recorded for a **full** read (a common Windows false positive from cloud sync / antivirus), the edit is allowed. Partial views never take this content-fallback path.
- **Injected context files are not "read".** Files Pi injects into the system prompt (`AGENTS.md`, `CLAUDE.md`) never pass through the `read` tool, so editing one is blocked until you explicitly fully `read` it first.
- After any `/tree` navigation, the extension conservatively clears its read cache. Re-read an existing file before editing it again, whether or not another extension restored files.

## Design notes

- **Two hooks, one private cache.** `tool_result` records `{ contentHash?, mtime, isPartialView? }` (sha-256 of the raw bytes for full reads — decoded-text comparison would fold invalid utf-8 to U+FFFD and could equate different binaries); `tool_call` (edit/write) gates the operation. `session_tree` clears the cache so the extension stays safe without coordinating state with another plugin.
- **Read-state is refreshed after the agent's own full read, edit, and write** — not only `read`. Otherwise the agent's own edit bumps the file's mtime and content while the cache holds the pre-edit snapshot, so the next edit to the same file is wrongly blocked as "modified since read" (and a write-then-edit fails as "not read yet"). The `tool_call` gate runs *before* each edit, so a genuine external change is still caught first. This mirrors CC's FileWriteTool/FileEditTool.
- **Content cache bounds.** Only a sha-256 hash is cached for full reads (a few bytes per entry), and only for files within the 25 MB hashing budget; the cache is bounded to 100 entries (FIFO eviction). Oversized files track mtime only and require a re-read when mtime changes. Partial entries store mtime + `isPartialView` without a content hash.
- **Write refresh skips a second disk read.** After a successful `write`, the hash is taken from the utf-8 `content` argument (same encoding Pi's write tool uses on disk); only mtime needs a `stat`. Full `read` / `edit` still hash on-disk bytes (result text can be line-numbered; edit args are a patch, not final content).
- A soft `<read_before_edit>` constraint is appended to the system prompt each turn (the base prompt is rebuilt per turn, so it is not duplicated).

## Files

- `index.ts` — record/gate hooks, soft constraint, and `/tree` invalidation
- `file-state.ts` — private bounded read-state cache
- `tool-path.ts` — private edit/write path extraction and resolution

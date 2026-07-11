# rewind — checkpoints & rewind

Per-edit file backups plus a `/rewind` settings menu. Instead of snapshotting the
whole working tree, rewind backs up **only the files Pi's `edit`/`write` tools are
about to change** — one `copyFile` before each edit. Cost is proportional to how
many files Pi changed, never to project size, so it never blocks the session
lifecycle (the old shadow-git design froze the UI in large multi-project
directories) and storage stays tiny.

## Behavior

Per turn: `before_agent_start` opens a snapshot frame (re-recording every tracked
file at its turn-start state, reusing the latest backup when unchanged);
`tool_call(edit|write)` backs up each newly edited file *before* it lands;
`agent_end` persists the frame to the session JSONL as a `pi-rewind-snapshot`
custom entry **only when files changed**. Entries survive `/reload` and
compaction; the index is rebuilt from them on `session_start`.

- **Scope (deliberate trade-off):** rewind covers edits made through Pi's built-in
  `edit` and `write` tools. Files written by `bash` (redirects, codegen, `mv`) or
  edited by hand outside Pi are **not** tracked — same boundary as Claude Code's
  file-history. Rewind undoes *Pi's edits*, not arbitrary filesystem state.
- **Time-travel is via `/tree`.** Navigating to a node whose turn changed files
  prompts to restore them, listing the affected files (cwd-relative, up to 8
  then *"+N more"*) under *"Restore 3 files to this point?"*; choosing yes
  restores the work tree to that turn's start state. Nodes with no file changes
  navigate silently. Only files that actually differ are rewritten.
- **`/rewind` is a settings + storage menu**, not a restore picker:
  - toggle rewind on/off,
  - set the auto-clean retention window,
  - inspect storage and prune (clean aged + orphaned / remove orphaned / remove
    all except current).
- **New files** created by `write` are tracked with a "did not exist" marker, so
  rewinding deletes them.
- **Resume/fork** hard-links the prior session's backup blobs into the new
  session (falling back to copy), so rewind keeps working without duplicating
  storage.

## Storage & cleanup

- **Layout:** `~/.pi/agent/pi-config/rewind/`
  - `config.json` — `{ enabled, retentionDays, maxSnapshots }`
  - `backups/<sessionId>/<sha256(relpath)[:16]>@v<n>` — backup blobs (flat, hashed
    names keep paths short on Windows; mode preserved)
- **Auto-clean:** at `session_start`, backup directories older than
  `retentionDays` (default **30**, set in `/rewind`) are reclaimed, plus an
  **orphan sweep** of directories whose session id has no session JSONL (crashed
  sessions). The GC is time-boxed and deletion-capped so it never slows startup.
- The old shadow-git storage at `~/.pi/agent/pi-config/checkpoints/` is **not**
  used or touched by this engine; remove it manually if you want the space back.

## Design notes

- **Never blocks the edit.** `tool_call` backs up the target before the write
  lands; a backup failure is swallowed (the edit proceeds un-checkpointed) rather
  than blocking the tool.
- **Restore safety.** `applySnapshot` only rewrites files that differ and never
  throws out — an unreadable backup degrades to "leave the file alone", so a
  broken backup can never abort the user's session.
- **Independent read safety.** Rewind owns only backup and restore behavior. The
  separate read-before-edit plugin conservatively clears its own cache after
  every `/tree` navigation, so the plugins do not share mutable state.
- **Change detection.** A file is re-backed-up only when its stat (mode/size) or
  content differs from its latest backup; an `mtime` older than the backup skips
  the content read entirely.

## Files

- `index.ts` — lifecycle hooks (`tool_call`, `before_agent_start`, `agent_end`,
  `session_start`, `session_before_tree`/`session_tree`, `session_shutdown`) and
  the `/rewind` command
- `engine.ts` — the file-history backup engine (track / snapshot / apply /
  resume-migrate), ported from Claude Code's file-history
- `snapshot.ts` — persisted snapshot data shapes (pure)
- `config.ts` — load/save `rewind/config.json`
- `gc.ts` — age + orphan storage reclamation; storage inventory for the menu
- `menu.ts` — the `/rewind` settings + storage menu
- `restore.ts` — `/tree`-target → snapshot matching and restore
- `paths.ts`, `text.ts`, `tool-path.ts` — private helpers owned by this plugin

Architecture informed by oh-my-pi (GPL-3.0) and Claude Code's file-history;
independent implementation.

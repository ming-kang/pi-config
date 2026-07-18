# Subagent optimization round

> Working plan and checkpoint log for the current development round. Update this
> file in the same commit as each completed batch. Durable user-facing behavior
> still belongs in [`README.md`](README.md); remove or archive this working file
> when the round is closed.

## Goal

Keep the extension's background `AgentSession` strengths—stable worker ids,
queueing, steering/continuation, retained transcripts, automatic parent
completion, and the footer/panel UI—while adopting the useful simplicity of the
Trellis runner:

- no misleading model-turn execution cap;
- compact, semantic tool activity previews;
- a clearly separated final result;
- coalesced progress rendering;
- structured error results;
- one parent wake-up for a spawned batch;
- less model-facing housekeeping.

The implementation remains self-contained under `extensions/subagent/` and
continues to use Pi public APIs. The Trellis subprocess architecture and its
project-specific context injection are reference material only.

## Decisions fixed for this round

1. **Remove `maxTurns`.** Pi defines a turn as one model response plus its tool
   batch, and most agents use roughly one tool per model response. The current
   implementation also checks the cap at assistant `message_end`, before that
   turn's tools necessarily execute. No replacement timeout is added in this
   round; workers finish naturally or are stopped explicitly.
2. **Count turns at `turn_end`.** Turn counts remain lifetime diagnostics for a
   retained worker; `runCount` continues to distinguish separate prompts/runs.
3. **Separate activity from result.** Tool activity becomes structured state.
   The panel renders compact activity rows and a dedicated Markdown final-result
   section. Model-facing completion output remains bounded by the documented
   budget.
4. **Keep the footer and overlay.** Background work cannot use Trellis's
   blocking partial tool card as its only status surface. No global shortcut is
   added.
5. **Aggregate batch completion.** Workers spawned together retain independent
   ids and UI rows, but the parent conversation receives one combined follow-up
   after the whole initial batch settles.
6. **Make retention automatic.** Before rejecting a spawn at `maxAgents`, evict
   the oldest suitable terminal records, preferring viewed successful/stopped
   records and preserving active or unread failure records as long as possible.
7. **Shrink the model control plane.** The final public actions will be
   `spawn`, `read`, `send`, and `stop`:
   - `read` without `id` lists retained workers; with `id` returns a snapshot.
   - `send` is state-aware and gains `fresh`; it attaches, steers, continues, or
     reruns as appropriate.
   - clearing records and changing deployment limits move to `/agents`
     subcommands/UI.

## Batch plan

### Batch 0 — Plan and baseline

**Status:** complete

- Add this working document.
- Record the agreed design, batches, acceptance criteria, verification matrix,
  and checkpoint policy.
- Confirm the repository is clean before implementation.

**Checkpoint:** `docs(subagent): plan optimization round`

### Batch 1 — Remove the broken turn cap

**Status:** complete

Scope:

- Remove `maxTurns` and `turnLimitHit` from schemas, runtime records, snapshots,
  panel metadata, completion copy, prompt guidelines, and README documentation.
- Keep usage aggregation on assistant `message_end`, but increment `turns` only
  on `turn_end` after the tool batch has completed.
- Restore normal aborted-run error handling.
- Correct steering copy from “current tool call” to “current tool batch.”

Acceptance:

- `rg maxTurns extensions/subagent --glob '!DEVELOPMENT.md'` returns no
  implementation or durable user-facing references.
- Tool schema no longer exposes `maxTurns`.
- A turn count represents completed Pi turns, not assistant messages observed
  before tool execution.
- Extension loads through Pi without registration errors.

**Checkpoint:** `fix(subagent): remove broken turn cap`

### Batch 2 — Structured activity preview and final result

**Status:** complete

Scope:

- Add a bounded `ToolActivity` model with tool-call id, semantic summary,
  optional detail/result summary, status, and timestamps.
- Translate Pi tool events into concise rows such as `Read controller.ts`,
  `Search "maxTurns"`, `Edit schema.ts`, and `Run verification`.
- Derive a high-level current activity such as `Inspecting code`, `Applying
  changes`, or `Running verification` while retaining useful raw detail.
- Render activities chronologically in the panel with running/success/error
  icons.
- Render the final assistant result in a dedicated Markdown section rather than
  treating it as just another activity line.
- Include an explicit bounded `Final result` section in model-facing `read`.
- Keep the footer to one semantic activity line per active worker.

Acceptance:

- Pending/running/success/error tool activities are distinguishable.
- Tool arguments are summarized without retaining full write content or large
  edit payloads.
- Completed workers show their final answer independently from activity history.
- Existing steering/user/system/error transcript information remains visible.
- Activity and final-result storage have documented bounds/omission notices.

**Checkpoint:** `feat(subagent): add structured activity previews`

### Batch 3 — Coalesced rendering and structured errors

**Status:** pending

Scope:

- Coalesce text/thinking delta repaint requests into a small render interval;
  state mutation remains immediate.
- Force immediate renders for status transitions, tool start/end, stop, and
  completion.
- Dispose pending render timers during session shutdown/reload.
- Stop throwing away controller error details in tool `execute`.
- Return structured results normally and use Pi's `tool_result` hook to mark
  results with `errorCode` as errors.

Acceptance:

- Streaming text does not request an unbounded repaint per delta.
- Terminal and tool-boundary states still appear promptly.
- Invalid calls render as errors while preserving `SubagentDetails`.
- Reload/shutdown leaves no extension-owned timer running.

**Checkpoint:** `perf(subagent): coalesce progress rendering`

### Batch 4 — Batch completion aggregation and automatic retention

**Status:** pending

Scope:

- Associate the initial runs from one multi-task `spawn` with a completion
  group.
- Notify the parent once after every member becomes terminal; include each id,
  status, statistics, and bounded final result.
- Keep later continuation/restart runs independent from the original group.
- Make stop-before-start and stop-while-running settle their initial group.
- Evict suitable terminal records automatically before a spawn would exceed
  `maxAgents`.
- Never auto-evict queued/starting/running workers; prefer viewed successful or
  stopped records over unread failures.

Acceptance:

- A three-worker batch produces one parent follow-up, not three.
- Single-worker spawns retain current notification behavior.
- A batch containing a stopped or failed worker still settles and notifies once.
- Spawns reclaim safe terminal capacity automatically and fail only when active
  or protected records leave insufficient room.

**Checkpoint:** `feat(subagent): aggregate batch completions`

### Batch 5 — Simplify the model-facing control contract

**Status:** pending

Scope:

- Reduce actions to `spawn`, `read`, `send`, and `stop`.
- Make `read.id` optional: no id lists workers; an id reads one retained worker.
- Add `send.fresh`; unify attach/steer/continue/rerun behavior behind one action.
- Move clear operations to `/agents clear [id|all]`.
- Move deployment-limit management to `/agents limits` while retaining
  per-spawn `maxConcurrency` / `maxAgents` overrides if still useful.
- Update command completion, tool rendering, prompt copy, README, and usage
  errors.
- Add argument preparation for safe legacy aliases where semantics map exactly
  (`list` → `read`, `restart` → `send` with `fresh`). Do not silently map legacy
  operations whose effects cannot be preserved.

Acceptance:

- The model sees four actions with clear state-aware descriptions.
- Human users can still clear terminal records and configure limits.
- Panel Enter behavior and model `send` behavior follow the same state machine.
- Resumed compatible legacy calls are normalized before validation.

**Checkpoint:** `refactor(subagent): simplify control contract`

### Batch 6 — End-to-end verification and documentation closeout

**Status:** pending

Scope:

- Update durable behavior in `extensions/subagent/README.md`.
- Exercise Pi load/reload and the affected pending, success, error, collapsed,
  expanded, footer, and panel states as available.
- Exercise `/tree` and shutdown/reload lifecycle cleanup.
- Record exact verification coverage, unverified UI states, risks, and rollback
  notes below.
- Decide whether this working document should be removed, archived, or retained
  after the round.

Acceptance:

- All completed batches have a matching documentation-log entry and verified
  checkpoint commit.
- No stale action/max-turn copy remains.
- `git diff --check` passes and the working tree contains only intentional
  changes.

**Checkpoint:** `docs(subagent): finish optimization round`

## Verification matrix

Update this table after each batch. “Static” means source/schema inspection and
load checks; “runtime” means the behavior was driven through Pi.

| Surface | Static | Runtime | Notes |
|---|---:|---:|---|
| Extension/package loads | pass | pending | Batch 1: `pi -ne -e . --list-models --offline` |
| `spawn` single and batch | pending | pending | |
| queued/starting/running states | pending | pending | |
| tool activity start/success/error | pass | pending | Batch 2: formatter assertions + typed event mapping |
| complete final result | pass | pending | Dedicated bounded Markdown `Result` section |
| `read` list and snapshot | partial | pending | Snapshot includes activity and explicit final result; list unchanged |
| `send` attach/steer/continue/fresh rerun | pending | pending | |
| `stop` queued/running | pending | pending | |
| batch parent notification | pending | pending | |
| automatic retention eviction | pending | pending | |
| collapsed/expanded tool rendering | pending | pending | |
| footer widget | pass | pending | Semantic `currentActivity` source wired; visual check pending |
| `/agents` panel and commands | pass | pending | Activity/conversation/result renderer type-checked |
| `/reload`, `/tree`, shutdown cleanup | pending | pending | |

## Checkpoint log

### Baseline — planning

- Reviewed the current extension, bundled Pi subagent example, Trellis Pi
  extension, Pi extension/TUI/SDK documentation, and the local Pi source under
  `references/pi/`.
- Confirmed Pi event order: assistant `message_end` occurs before tool execution;
  `turn_end` occurs after the tool batch.
- Confirmed the low-level loop has `shouldStopAfterTurn`, but the current
  `createAgentSession` surface does not expose it; this round removes the bad
  cap rather than adding an upstream dependency.
- No runtime behavior changed in this checkpoint.
- Checkpoint commit: `cb3319d` (`docs(subagent): plan optimization round`).

### Batch 1 — turn-cap removal

- Removed `maxTurns` / `turnLimitHit` from the schema, launch specs, records,
  snapshots, panel, completion notification, prompt guidance, and README.
- Usage tokens/cost remain aggregated from assistant `message_end`; completed
  Pi turns are now counted from `turn_end`, after the tool batch.
- Aborted workers again finalize as failures instead of being relabeled as
  completed limit hits.
- Corrected steer copy to say “current tool batch.”
- Static verification: no `maxTurns` references remain outside this working
  plan; `git diff --check` passes.
- Load verification: `pi -ne -e . --list-models --offline` exited successfully.
- Checkpoint commit: `ec2f7ce` (`fix(subagent): remove broken turn cap`).

### Batch 2 — structured activity and result preview

- Added `activity.ts` with bounded, argument-safe summaries for Pi's built-in
  tools and short result summaries.
- Added structured `ToolActivity` records with running/succeeded/failed status,
  timestamps, result summaries, and explicit omitted-activity accounting.
- The panel now renders a compact `Activity` section and a separate bounded
  Markdown `Result`; tool rows no longer depend on raw timeline strings.
- The footer receives semantic headlines such as `Reading code`, `Applying
  changes`, and `Running verification` through `currentActivity`.
- Model-facing `read` now returns explicit `Tool activity`, `Final result` (or
  latest assistant output), and conversation-update sections within its existing
  32,000-character budget.
- Updated README behavior and file ownership notes.
- Static verification: TypeScript strict no-emit check passed using the installed
  Pi type declarations; activity formatter assertions covered read/search/edit,
  command classification, and multi-line result summaries; `git diff --check`
  passed.
- Load verification: `pi -ne -e . --list-models --offline` exited successfully.
- Interactive panel/footer states remain scheduled for the final runtime pass.

## Open risks and rollback notes

- Batch 5 intentionally changes the model-facing schema. Keep its commit
  isolated so the old action contract can be restored without reverting the UI
  and runtime improvements.
- Batch completion grouping must not suppress notifications for later continued
  runs; completion-group state belongs to a run, not permanently to a worker.
- Rendering a very large final answer can be expensive. Keep model-facing output
  bounded and add an explicit panel/read omission notice if a UI budget is hit.
- Automatic eviction must never dispose an active session. If candidate ordering
  is uncertain, fail the spawn rather than evict a protected record.
- Do not copy Trellis source. Reimplement the behavior from the observed design
  using Pi public APIs and extension-local types/helpers.

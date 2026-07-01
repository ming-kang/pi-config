# todo — task list overlay

Adds a `todo` tool plus `/todos` for multi-step work, with a live overlay above the editor.

## Behavior

- Actions: `create`, `update`, `list`, `get`, `delete`, `clear`. Statuses: `pending`, `in_progress`, `completed`, `deleted`.
- The live overlay renders above the editor and hides itself when there are no visible tasks.
- `blockedBy` dependencies are supported for sequencing; missing dependencies, deleted dependencies, self-dependencies, and cycles are rejected.
- Completed tasks remain visible briefly, then drop from the overlay on the next agent turn so active work stays prominent.

## Design notes

- **Conversation-backed state.** Every tool result stores a full snapshot in `details`; lifecycle handlers replay the current branch on `/reload`, compaction, and session-tree navigation. There is no separate disk database.
- **Status transitions are gated.** `completed` can be reopened to `in_progress` or `pending`, but `deleted` is terminal. Reopening lets a premature completion recover without losing the task id and its `blockedBy` edges — matching the harness `TaskUpdate` semantics.
- **Overlay render is not cached.** `TodoOverlay.render` recomputes `renderOverlayLines` every call, so it is inherently width-correct on resize. It tracks which completed items were shown this turn (a render side effect) so `hideCompletedFromPreviousTurn` (on `agent_start`) can drop them next turn.
- The overlay body is capped (10 rows), prioritizing non-completed items and showing a `+N more` line when truncated.

## Files

- `index.ts` — tool + `/todos` command, lifecycle handlers, render
- `constants.ts` — tool/command identity and model-facing prompt copy
- `schema.ts` — params, status/action types, details shape, and empty state
- `state.ts` — mutation engine (`applyTodoMutation`), transition rules, cycle check, branch replay
- `view.ts` — overlay/list formatting, status marks and colors
- `overlay.ts` — the live `TodoOverlay` widget

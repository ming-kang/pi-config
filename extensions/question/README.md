# question — structured user questions

Adds a `question` tool for asking one to four multiple-choice questions when the agent needs a user decision. A Pi-native take on AskUserQuestion: a lightweight custom dialog that returns a structured result envelope the model can reliably consume.

## Behavior

- `Enter` submits the full question set; if any question is unanswered, the dialog stays put and shows a warning.
- Multi-select questions use `Space` to toggle options.
- `Tab` opens a note editor for the focused option; in multi-select, the option must be selected first. On the `Type something.` row it opens custom-answer input.
- Multi-select custom answers stay on the `Type something.` row, are selected when saved, and can be toggled with `Space` without losing text.
- `←` / `→` switch between questions and wrap at the ends.
- `Type something.` is appended automatically for custom answers; authored options may not use reserved labels (`Other`, `Type something.`, `Chat about this`, `Next`).
- `preview` shows a side-by-side markdown panel for the focused option (single-select only) — for code snippets or layout mockups to compare.

Tool results use a structured envelope in `details`: `{ answers, cancelled, error? }`. Each answer records its question index, kind (`option` / `custom` / `multi`), selected labels, optional notes, and optional selected preview text.

## Design notes

- Uses Pi's native `ctx.ui.custom()` for the dialog, not a bespoke TUI component.
- The dialog lifecycle is fully self-contained in `dialog.ts` — no state shared with the rest of the extension.
- **Render cache is guarded by width.** The dialog caches its rendered lines, but the TUI's resize handler only calls `requestRender()` (not `invalidate()`), so the cache key includes the width — matching the built-in `Markdown` component. Without this, a resize mid-dialog would show lines wrapped for the old width until the next keypress.
- `validateQuestions` enforces uniqueness (question text, option labels) and reserved-label rejection beyond what the JSON schema can express.

## Files

- `index.ts` — tool registration, render call/result
- `dialog.ts` — the interactive custom dialog (self-contained)
- `schema.ts` — params + `validateQuestions`
- `state.ts` — per-question dialog state helpers, answer ordering
- `results.ts` — tool-result envelope builders
- `types.ts` — shared interfaces and the `OTHER_OPTION` sentinel

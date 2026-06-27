# tools-view — compact rendering + central style hub

Two roles in one extension:

1. **Compact rendering for the built-in tools** (`read` / `bash` / `edit` / `write`) — each overrides the built-in's render with a compact, self-drawn layout.
2. **The central style hub** — `shared.ts` exports the rendering primitives every other extension imports. Editing `shared.ts` changes the look globally.

## The convention

All custom tool rendering follows one visual convention. Every tool sets `renderShell: "self"` (no default Pi background; each tool draws its own compact layout) and uses the bullet + prefix pattern:

```
● ToolName args              ← call line   (callLine)
│ Summary / result           ← collapsed   (resultLine)
● error description          ← error       (errLine)
● ToolName Working…          ← active      (activeDotLine)
```

Primitives live in `shared.ts`: `callLine()` for `renderCall`, `resultLine()` for collapsed `renderResult`, `errLine()` for error states, `activeDotLine()` for partial/progress states. Bullet `●` uses `theme.fg("success" | "error" | "warning", …)`; the result prefix `│ ` uses `theme.fg("dim", …)`; the tool name uses `theme.fg("toolTitle", theme.bold(...))`.

## Collapsed-result convention

Collapsed results stay compact: a one-line summary (counts / status), optionally a bounded preview (bash shows the last few output lines, write the first lines, edit the diff up to a line cap), and a `keyHint("app.tools.expand", …)` to reveal the rest. Expanded (Ctrl+O) shows the full output with appropriate formatting (markdown, diff, syntax-highlighted code).

## Files

- `shared.ts` — the style primitives (edit here to change the global look)
- `index.ts` — registers the built-in tool render overrides
- `read.ts` / `bash.ts` / `edit.ts` / `write.ts` — per-tool compact renderers

# tools-view — compact rendering + central style hub

Two roles in one extension:

1. **Compact rendering for the built-in tools** (`read` / `bash` / `edit` / `write`) — each overrides the built-in's render with a compact, self-drawn layout.
2. **The central style hub** — `shared.ts` exports the rendering primitives every other extension imports. Editing `shared.ts` changes the look globally.

## The convention

All custom tool rendering follows one visual convention. Every tool sets `renderShell: "self"` (no default Pi background; each tool draws its own compact layout) and uses the bullet + prefix pattern:

```
● ToolName args              ← call line   (callLine)
│ Summary / result           ← collapsed   (resultLine)
● error description          ← error       (errLine / errorResultLine)
● ToolName Working...        ← active      (activeDotLine)
```

Primitives live in `shared.ts`: `callLine()` for `renderCall`, `resultLine(info, theme, color?)` for collapsed `renderResult` (explicit color instead of nested `theme.fg`; `resultPrefix()` for multi-colored composites), `errLine()` / `errorResultLine()` for error states, `activeDotLine()` for partial/progress states, `markdownResultBlock()` for expanded Markdown results, `indentedOutput()` for two-space `toolOutput` bodies, and the footer hints `moreLinesHint()` / `collapseHint()` / `expandHint()`. Bullet `●` uses `theme.fg("success" | "error" | "warning", …)`; the result prefix `│ ` uses `theme.fg("dim", …)`; the tool name uses `theme.fg("toolTitle", theme.bold(...))`.

### Dot-color rule

The `callLine` bullet is **always `success` (green)** for every tool — built-in and custom alike. Custom tools are not a separate visual species; the dot color never encodes tool identity. State is conveyed by the *line form*, not the dot color:

- **`success`** — a completed call line (`callLine`, always).
- **`warning`** — an in-progress/partial line (`activeDotLine`, always warning).
- **`error`** — a failure line (`errLine` / `errorResultLine`, error color).

`callLine` takes no dot-color parameter — the `success` dot is hard-coded. If a future non-success call line is ever needed, add a distinct named primitive instead of an override.

## Collapsed-result convention

Collapsed results stay compact: a one-line summary (counts / status), optionally a bounded preview (bash shows the last few output lines, write the first lines, edit the diff up to a line cap), and an expand hint to reveal the rest. Footer hints come from `shared.ts` — `moreLinesHint(hidden)` under a bounded preview, `collapseHint()` when expanded, `expandHint()` inline after a one-line summary — so wording stays identical across tools. Expanded (Ctrl+O) shows the full output with appropriate formatting (markdown, diff, syntax-highlighted code).

## Files

- `shared.ts` — the style primitives (edit here to change the global look)
- `index.ts` — registers the built-in tool render overrides
- `read.ts` / `bash.ts` / `edit.ts` / `write.ts` — per-tool compact renderers

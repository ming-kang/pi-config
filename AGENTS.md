# pi-config — Agent Guidelines

This file is for AI coding agents working on `pi-config/`. It documents design conventions, architectural decisions, and shared agreements between maintainers.

pi-config is a shared Pi package that bundles commonly used extensions and themes, published as a standalone GitHub repository.

---

## Architectural Principles

### Extensions are decoupled; rendering is centralized

- Each tool-owning extension (`advisor/`, `todo/`, `question/`, `rewind/`, `read-before-edit/`) owns its tool logic — `execute`, `schema`, `state`, configuration, commands, lifecycle handlers. The remaining two are special: `tools-view/` is the shared rendering hub (below), and `statusline/` is a footer-only extension with no tool.
- **All tool rendering** is shipped via the `tools-view/` extension's shared style primitives. Every tool that needs a custom look must:
  1. Set `renderShell: "self"` in its tool definition.
  2. Import style helpers from `../tools-view/shared.ts`.
  3. Use `callLine()` for `renderCall`, `resultLine()` for collapsed results, `errLine()` for errors, `activeDotLine()` for partial/progress states.
- The style primitives live in one place (`tools-view/shared.ts`). To change the global look, edit that file — all tools pick it up automatically.

### Consistent rendering pattern

Every custom-rendered tool follows this visual convention:

```
● ToolName args              ← callLine (renderCall)
│ Summary / result info      ← resultLine (collapsed renderResult)
● error description          ← errLine (error state)
● ToolName Working…          ← activeDotLine (partial state)
```

- Bullet `●` uses `theme.fg("success", …)` on success, `theme.fg("error", …)` on error, `theme.fg("warning", …)` for active state.
- Result prefix `│ ` is drawn with `theme.fg("dim", "│ ")`.
- Tool name in call line uses `theme.fg("toolTitle", theme.bold(...))`.
- Collapsed results stay compact: a one-line summary (counts / status), optionally a bounded preview (bash shows the last few output lines, write the first lines, edit the diff up to a line cap), and a `keyHint("app.tools.expand", …)` to reveal the rest.
- Expanded content (Ctrl+O) shows the full tool output with appropriate formatting (markdown, diff, syntax-highlighted code, etc.).

### Pi-native mechanisms first

Reuse Pi's public API wherever possible:
- `createXToolDefinition(cwd)` + spread for overriding built-in tools.
- `keyHint("app.tools.expand", …)` for expand/collapse hints.
- `theme.fg()`, `theme.bg()`, `theme.bold()` for all styling.
- `completeSimple()` for LLM completions, `modelRegistry` for model discovery, `convertToLlm` for session message conversion.

Document unavoidable upstream limitations in the extension header comment — do not silently work around them.

---

## Extension Structure

```
extensions/<name>/
  index.ts      ← Extension entry: registerTool, registerCommand, lifecycle hooks
  schema.ts     ← Parameter schema (TypeBox)
  types.ts      ← Shared types / interfaces
  state.ts      ← Runtime state management
  config.ts     ← Persistent configuration (read/write JSON files)
  execute.ts    ← Tool execution logic (when complex)
  ...helpers    ← Any other helper modules imported by index.ts
```

A simple single-file extension (`extensions/<name>.ts`) is fine when the logic is small.

Modules shared *across* extensions live in `extensions/shared/` — it has no `index.ts` and no `pi` manifest, so Pi's loader does not treat it as an extension (it is purely an import target). Example: `shared/file-state.ts`, the read-state cache that `read-before-edit` populates and `rewind` invalidates after a restore.

Cross-extension imports are allowed **only** for `../tools-view/shared.ts` (style primitives) and for established shared utilities under `../shared/` (e.g. `../shared/file-state.ts`). Do not import from another extension's internal modules — that creates hidden coupling.

Relative imports use the `.ts` source suffix (Pi's own example extensions do the same, and jiti resolves it directly) — do not write `.js` specifiers.

---

## Design Decisions

Each extension documents its own behavior, design decisions, and file layout in its own README. Cross-cutting conventions (rendering, imports, structure) stay in this file; anything specific to one extension belongs in that extension's README.

- [`advisor/README.md`](extensions/advisor/README.md)
- [`question/README.md`](extensions/question/README.md)
- [`todo/README.md`](extensions/todo/README.md)
- [`rewind/README.md`](extensions/rewind/README.md)
- [`read-before-edit/README.md`](extensions/read-before-edit/README.md)
- [`tools-view/README.md`](extensions/tools-view/README.md)
- [`statusline/README.md`](extensions/statusline/README.md)

---

## Commits

- Use Conventional Commits (`feat:`, `fix:`, `refactor:`, `style:`, `docs:`, etc.).
- Commit at meaningful checkpoints after verification.
- Do not commit API keys, provider tokens, Pi config files, or machine-specific paths.

---

## Testing Notes

- **Load this checkout without installing.** Disable installed extensions and load the repo for the session only: `pi -ne -e ./pi-config`. `-ne` stops installed copies from shadowing your working tree; iterate and re-run to verify.
- When testing UI changes, call the tool via the `advisor` tool or `question` tool from this agent to observe renderCall / renderResult output.
- Verify both collapsed and expanded states (Ctrl+O toggle).
- Check error states by providing invalid configuration or triggering intentional failures.

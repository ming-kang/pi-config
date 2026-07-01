# Package Contract

A shared Pi package bundling commonly used extensions and themes, published as a standalone GitHub repo.

This file governs work on the code here: cross-cutting conventions live in this file; per-extension behavior lives in each extension's README.

## Build & Test

- **No build, no tracked tests.** Pi loads `.ts` directly via jiti; offline experiments go in `scratch/` (git-ignored).
- **Iterate:** `pi -ne -e ./pi-config` loads this checkout for the session only (`-ne` stops installed copies from shadowing it).
- **Verify a change:** drive the tool and check `renderCall` / `renderResult` in both collapsed and expanded (Ctrl+O) states; for lifecycle extensions (`rewind` / `read-before-edit` / `todo`) also exercise `/reload` and `/tree` navigation.

## Architecture Boundaries

- **Rendering is centralized.** Every custom-rendered tool sets `renderShell: "self"` and imports its primitives from `../tools-view/shared.ts`. To change the global look, edit `tools-view/shared.ts` — nothing else.
- **`tools-view/` is a dependency, not optional.** Other extensions import its style primitives; if you selectively load a subset of this package, do **not** exclude `tools-view`.
- **Extension layout:** `extensions/<name>/` owns `index.ts` (registration + lifecycle hooks) plus helpers (`schema` / `state` / `config` / `execute` …). A small extension may be a single `extensions/<name>.ts`.
- **Shared, non-extension code** lives in `extensions/shared/` — no `index.ts`, no `pi` manifest, so Pi's loader treats it as a pure import target (e.g. `file-state.ts`, the read-state cache `read-before-edit` populates and `rewind` invalidates).
- **Import rule:** cross-extension imports are allowed **only** for `../tools-view/shared.ts` and `../shared/*`. Never reach into another extension's internal modules.

## Conventions

- Relative imports use the **`.ts`** source suffix — never `.js`.
- **Pi-native first:** reuse `createXToolDefinition`, `keyHint("app.tools.expand", …)`, `theme.fg/bg/bold`, `completeSimple`, `modelRegistry`, `convertToLlm` instead of reimplementing.
- **Visual convention:** `●` bullet (`success` / `error` / `warning`) + dim `│ ` prefix; `callLine` (renderCall), `resultLine` (collapsed result), `errLine` (error), `activeDotLine` (partial/progress). The `callLine` dot is always `success` (see `tools-view/README.md` → Dot-color rule).
- **hasUI guard rule:** when interactive UI is unavailable, behavior depends on the call origin — **command handlers** (`/advisor`, `/todos`, `/rewind`, …) `ctx.ui.notify("… requires an interactive UI.", "warning")` then return; **lifecycle/event handlers** (`session_start`, `session_before_tree`, `session_shutdown`, …) may silent-return; **tool `execute`** returns an error result (e.g. `errorResult("no_ui", …)`). Never assume `ctx.hasUI` is true in any context; never assume `ctx.mode === "tui"` outside terminal-only rendering (footer/widgets).
- **Guiding rule:** make the smallest possible change to Pi's behavior, reusing native mechanisms, to arrive at an experience that feels like Claude Code. Document unavoidable upstream limits in the extension's header comment.

## Safety Rails

### NEVER
- Commit API keys, provider tokens, Pi config files, or machine-specific paths.
- Import another extension's internal modules (only `../tools-view/shared.ts` and `../shared/*` are shared).
- Write `.js` import specifiers.
- Exclude `tools-view` when selectively loading — it breaks every other extension's rendering.
- Copy source from the upstream Pi monorepo (or any third-party project) into this repo. Study it (DeepWiki, a throwaway clone), then translate the idea into your own implementation. This repo must never contain vendored upstream code.

### ALWAYS
- Route tool rendering through the `tools-view/shared.ts` primitives.
- Verify both collapsed and expanded (Ctrl+O) states for any UI change.
- Use Conventional Commits; commit at verified checkpoints.

## Per-extension design notes

[`advisor`](extensions/advisor/README.md) · [`question`](extensions/question/README.md) · [`todo`](extensions/todo/README.md) · [`rewind`](extensions/rewind/README.md) · [`read-before-edit`](extensions/read-before-edit/README.md) · [`tools-view`](extensions/tools-view/README.md) · [`statusline`](extensions/statusline/README.md)

## Compact Instructions

Preserve:

1. The centralized-rendering rule and the `../tools-view/shared.ts` import boundary (NEVER summarize away).
2. Extension structure and the `shared/` vs extension distinction.
3. Which extension(s) were modified and the verification status (loads / UI states checked).
4. Open risks, TODOs, rollback notes.

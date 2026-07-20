# Package Contract

A shared Pi package bundling commonly used extensions and themes, published as a standalone GitHub repo.

This file governs work on the code here: cross-cutting conventions live in this file; per-extension behavior lives in each extension's README.

## Documentation Map

- [`README.md`](README.md) is the user-facing package overview: install/update, extension index, and theme index.
- Per-extension behavior and design notes live in each `extensions/<name>/README.md`.
- Bundled theme notes live in [`themes/README.md`](themes/README.md); plugin-private implementation details belong in the owning extension's README.
- Keep this file compact: it should state package-wide contracts and point to focused docs for details.

## Build & Test

- **No build.** Pi loads `.ts` directly via jiti; offline experiments go in `scratch/` (git-ignored).
- **No tracked automated tests.** Verify extension behavior through Pi's native runtime and UI states; add tests only when a focused check materially reduces regression risk.
- **Iterate:** `pi -ne -e ./pi-config` loads this checkout for the session only (`-ne` stops installed copies from shadowing it).
- **Verify a change:** drive the affected tool through Pi's native pending, success, error, collapsed, and expanded states as applicable; for lifecycle extensions (`rewind` / `todo`) also exercise `/reload` and `/tree` navigation.
- **Upstream references:** use DeepWiki first. If source inspection is unavoidable, put temporary upstream clones, reference projects, and research material under `references/` (git-ignored and often skipped by normal searches), study them there, then delete them when no longer needed. Treat `references/` as read-only research input: never vendor or copy source from it into this repo.

## Architecture Boundaries

- **Extensions are self-contained.** `extensions/<name>/` owns its `index.ts` (registration + lifecycle hooks) and every helper it needs (`schema` / `state` / `config` / `execute` / UI primitives, etc.). A small extension may be a single `extensions/<name>.ts`.
- **Cross-extension imports are forbidden.** Do not add `extensions/shared/`, import another plugin's internals, or create a central UI/helper dependency. Small, domain-neutral duplication is preferable to coupling independently loadable plugins.
- **Pi-native tool UI is the default.** Registered tools should omit `renderShell`, `renderCall`, and `renderResult` so Pi owns framing, pending/error state, and collapsed/expanded behavior. Add a custom renderer only when native presentation cannot express behavior required by the tool, and keep it private to that extension.
- **Functional UI stays local.** Dialogs, overlays, menus, widgets, and footers that are part of an extension's behavior belong in that extension and may use Pi/TUI theme APIs directly.
- **Themes** live in `themes/`. Custom functional UI should consume theme keys through `theme.fg(...)` / `theme.bg(...)`, not hard-code colors. Theme inventory and schema notes live in `themes/README.md`.

## Conventions

- Relative imports use the **`.ts`** source suffix — never `.js`.
- **Pi-native first:** reuse Pi's built-in tool UI and public APIs such as `completeSimple`, `modelRegistry`, `convertToLlm`, and semantic theme helpers instead of reimplementing them.
- **Model-facing prompt copy:** for multi-file tools, keep name/label/description/promptSnippet/promptGuidelines in `constants.ts` and let `index.ts` assemble the tool. Each `promptGuidelines` bullet is appended flatly, so explicitly name the tool; schema field descriptions should guide argument construction.
- **Bounded model-facing output:** tool results returned to the model must be bounded — when a source can be arbitrarily large, truncate at a documented budget and append a notice stating what was omitted and how to get it (remaining items, a narrower action, or a follow-up query).
- **hasUI guard rule:** when interactive UI is unavailable, behavior depends on the call origin — **command handlers** (`/todos`, `/rewind`, …) `ctx.ui.notify("… requires an interactive UI.", "warning")` then return; **lifecycle/event handlers** (`session_start`, `session_before_tree`, `session_shutdown`, …) may silent-return; **tool `execute`** returns an error result (e.g. `errorResult("no_ui", …)`). Keep the guard local to the extension. Never assume `ctx.hasUI` is true in any context; never assume `ctx.mode === "tui"` outside terminal-only rendering (footer/widgets).
- **Guiding rule:** make the smallest possible change to Pi's behavior, reusing native mechanisms, to arrive at an experience that feels like Claude Code. Document unavoidable upstream limits in the extension's header comment.

## Safety Rails

### NEVER
- Commit API keys, provider tokens, Pi config files, or machine-specific paths.
- Import another extension's internal modules or introduce a shared extension helper directory.
- Write `.js` import specifiers.
- Copy source from the upstream Pi monorepo (or any third-party project) into this repo. Study it (DeepWiki, a throwaway clone), then translate the idea into your own implementation. This repo must never contain vendored upstream code.

### ALWAYS
- Keep every extension self-contained and prefer Pi's native tool presentation.
- Verify native collapsed and expanded states when tool output changes, plus any custom functional UI touched by the change.
- Use Conventional Commits; commit at verified checkpoints.

## Per-extension design notes

[`deepwiki`](extensions/deepwiki/README.md) · [`question`](extensions/question/README.md) · [`todo`](extensions/todo/README.md) · [`rewind`](extensions/rewind/README.md) · [`statusline`](extensions/statusline/README.md) · [`router`](extensions/router/README.md)

## Compact Instructions

Preserve:

1. The self-contained extension boundary and prohibition on cross-extension imports.
2. Pi-native tool presentation as the default; custom functional UI stays private to its extension.
3. Which extension(s) were modified and the verification status (loads / UI states checked).
4. Open risks, TODOs, rollback notes.

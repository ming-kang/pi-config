# Package Contract

A shared Pi package bundling commonly used extensions and themes, published as a standalone GitHub repo.

This file governs work on the code here: cross-cutting conventions live in this file; per-extension behavior lives in each extension's README.

## Documentation Map

- [`README.md`](README.md) is the user-facing package overview: install/update, extension index, and theme index.
- Per-extension behavior and design notes live in each `extensions/<name>/README.md`.
- Rendering details live in [`extensions/tools-view/README.md`](extensions/tools-view/README.md); shared helper inventory lives in [`extensions/shared/README.md`](extensions/shared/README.md); bundled theme notes live in [`themes/README.md`](themes/README.md).
- Keep this file compact: it should state package-wide contracts and point to focused docs for details.

## Build & Test

- **No build.** Pi loads `.ts` directly via jiti; offline experiments go in `scratch/` (git-ignored).
- **Tracked selftests are limited to Fast Context.** They are pure Node checks for its sandbox, executor, protocol, repo map, scorer, client parsing, search pure layer, and key-format logic; run the relevant one after touching that area.
- **Iterate:** `pi -ne -e ./pi-config` loads this checkout for the session only (`-ne` stops installed copies from shadowing it).
- **Verify a change:** drive the tool and check `renderCall` / `renderResult` in both collapsed and expanded (Ctrl+O) states; for lifecycle extensions (`rewind` / `read-before-edit` / `todo`) also exercise `/reload` and `/tree` navigation.
- **Upstream references:** use DeepWiki first. If source inspection is unavoidable, put temporary upstream clones, reference projects, and research material under `references/` (git-ignored and often skipped by normal searches), study them there, then delete them when no longer needed. Treat `references/` as read-only research input: never vendor or copy source from it into this repo.

## Architecture Boundaries

- **Rendering is centralized.** Every custom-rendered tool sets `renderShell: "self"` and imports its primitives from `../tools-view/shared.ts`. To change the global look, edit `tools-view/shared.ts` — nothing else.
- **`tools-view/` is a dependency, not optional.** Other extensions import its style primitives; if you selectively load a subset of this package, do **not** exclude `tools-view`.
- **Extension layout:** `extensions/<name>/` owns `index.ts` (registration + lifecycle hooks) plus helpers (`schema` / `state` / `config` / `execute` …). A small extension may be a single `extensions/<name>.ts`.
- **Shared, non-extension code** lives in `extensions/shared/` — no `index.ts`, no `pi` manifest, so Pi's loader treats it as a pure import target. Keep the helper inventory and reuse examples in `extensions/shared/README.md`.
- **Import rule:** cross-extension imports are allowed **only** for `../tools-view/shared.ts` and `../shared/*`. Never reach into another extension's internal modules.
- **Themes** live in `themes/`. Extension renderers should consume theme keys through `theme.fg(...)` / `theme.bg(...)`, not hard-code colors. Theme inventory and schema notes live in `themes/README.md`.
- **Fast Context security boundary:** `extensions/fast-context/sandbox.ts` (`PathSandbox`) is the security core. Every model-supplied path must go through `toReal()` / `contains()`; `project_path` must stay inside cwd; TLS must never be downgraded; keys must be saved only to `~/.pi/agent/pi-config/fast-context/config.json` and must never be logged or passed as tool parameters; no credential discovery from Devin/Windsurf/IDE/CLI local state.
- **Fast Context Pi surface stays minimal:** keep extension/TUI glue at the edge (`index.ts`, `commands.ts`, `render.ts`) and keep non-render Pi integration confined to `storage.ts`, `grep-backend.ts`, and `execute.ts` (via `grep-backend`). Search/security/protocol modules (`client.ts`, `protocol.ts`, `search.ts`, `repo-map.ts`, `directory-scorer.ts`, `executor.ts`, `tree.ts`, `sandbox.ts`, `state.ts`, `key-format.ts`, `prompt.ts`) stay pure and Node-testable; use dependency injection such as `GrepFn` rather than adding Pi imports.
- **Fast Context backend boundary is fragile:** `client.ts` / `protocol.ts` speak an unofficial third-party `swe-grep` wire format. Protocol constants are env-overridable only for drift/debugging; changes there require live validation with a real search and `<ANSWER>` round-trip, not just selftests.

## Conventions

- Relative imports use the **`.ts`** source suffix — never `.js`.
- **Pi-native first:** reuse `createXToolDefinition`, `keyHint("app.tools.expand", …)`, `theme.fg/bg/bold`, `completeSimple`, `modelRegistry`, `convertToLlm` instead of reimplementing.
- **Visual convention:** `●` bullet (`success` / `error` / `warning`) + dim `│ ` prefix; `callLine` (renderCall), `resultLine` (collapsed result), `errLine` (error), `activeDotLine` (partial/progress). The `callLine` dot is always `success` (see `tools-view/README.md` → Dot-color rule).
- **Standard renderers:** prefer `buildStandardRenderer<TDetails>()` from `tools-view/shared.ts` for tools with the usual call / partial / error / collapsed / expanded flow. Use a custom renderer only when the result envelope needs domain-specific formatting.
- **Model-facing prompt copy:** for multi-file tools, keep name/label/description/promptSnippet/promptGuidelines in `constants.ts` and let `index.ts` assemble the tool. Each `promptGuidelines` bullet is appended flatly, so explicitly name the tool; schema field descriptions should guide argument construction.
- **hasUI guard rule:** when interactive UI is unavailable, behavior depends on the call origin — **command handlers** (`/advisor`, `/todos`, `/rewind`, …) `ctx.ui.notify("… requires an interactive UI.", "warning")` then return; **lifecycle/event handlers** (`session_start`, `session_before_tree`, `session_shutdown`, …) may silent-return; **tool `execute`** returns an error result (e.g. `errorResult("no_ui", …)`). Use `requireInteractiveUI` from `../shared/extension-ui.ts` for command handlers when it fits. Never assume `ctx.hasUI` is true in any context; never assume `ctx.mode === "tui"` outside terminal-only rendering (footer/widgets).
- **Guiding rule:** make the smallest possible change to Pi's behavior, reusing native mechanisms, to arrive at an experience that feels like Claude Code. Document unavoidable upstream limits in the extension's header comment.

## Safety Rails

### NEVER
- Commit API keys, provider tokens, Pi config files, or machine-specific paths.
- Import another extension's internal modules (only `../tools-view/shared.ts` and `../shared/*` are shared).
- Write `.js` import specifiers.
- Exclude `tools-view` when selectively loading — it breaks every other extension's rendering.
- Copy source from the upstream Pi monorepo (or any third-party project) into this repo. Study it (DeepWiki, a throwaway clone), then translate the idea into your own implementation. This repo must never contain vendored upstream code.
- Weaken Fast Context's sandbox, key-handling, TLS, credential-discovery, or `project_path` containment invariants.

### ALWAYS
- Route tool rendering through the `tools-view/shared.ts` primitives.
- Verify both collapsed and expanded (Ctrl+O) states for any UI change.
- Re-run the focused Fast Context selftest after touching `sandbox` / `executor` / `protocol` / `repo-map` / `directory-scorer` / `client` / `search` / `key-format`.
- Use Conventional Commits; commit at verified checkpoints.

## Per-extension design notes

[`advisor`](extensions/advisor/README.md) · [`deepwiki`](extensions/deepwiki/README.md) · [`fast-context`](extensions/fast-context/README.md) · [`question`](extensions/question/README.md) · [`todo`](extensions/todo/README.md) · [`rewind`](extensions/rewind/README.md) · [`read-before-edit`](extensions/read-before-edit/README.md) · [`tools-view`](extensions/tools-view/README.md) · [`statusline`](extensions/statusline/README.md)

## Compact Instructions

Preserve:

1. The centralized-rendering rule and the `../tools-view/shared.ts` import boundary (NEVER summarize away).
2. Extension structure and the `shared/` vs extension distinction.
3. Fast Context's five security invariants, minimal Pi-import surface, fragile backend boundary, and live-validation status.
4. Which extension(s) were modified and the verification status (loads / UI states checked).
5. Open risks, TODOs, rollback notes.

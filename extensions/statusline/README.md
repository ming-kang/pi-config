# statusline — compact footer

Replaces Pi's built-in footer with a compact, color-coded status line. This is a footer-only extension — it registers no tool. It auto-enables on `session_start` in TUI mode and clears itself on `session_shutdown`.

## What it shows

```
Model · Effort · CTX 23% · ~cwd · branch              ↑in ↓out Rcache $cost
advisor: …                                            ← line 2, only when set
```

- **Left:** model name · effort (thinking level, only when the model supports reasoning and the level isn't `off`) · context usage % · cwd (shortened to `~`) · git branch (if any).
- **Right:** input / output / cache-read token counts and cost, right-aligned. Each part is omitted when zero (no `↑0 ↓0` noise).
- **Line 2:** extension statuses from `ctx.ui.setStatus()`, sorted by key. The custom footer replaces the built-in one, so without this any extension status text would silently vanish.

## Design notes

- **Theme-agnostic colors.** All coloring goes through `theme.fg(...)` / `theme.getThinkingBorderColor(level)`, so it adapts to any loaded theme, not just `ice-cream`. Context % shifts accent → warning → error by usage tier.
- **Live data.** Pi's `setFooter` returns a renderable that re-reads `ctx.sessionManager` / `ctx.model` / `ctx.getContextUsage()` on each render, so the line stays current; an `onBranchChange` subscription requests a render on branch switches. Effort (thinking level) is recovered by scanning session branch entries.
- **Narrow terminals.** When the line doesn't fit, the right-side token/cost stats are kept intact and the left side is truncated — stats are more useful than a long cwd.
- **Helpers.** `fmtTokens` is tiered (`999`, `1.2k`, `34k`, `1.5M`); `shortCwd` strips trailing separators before folding the home prefix to `~`; `sanitizeStatus` flattens status text to one line.

## Files

- `index.ts` — the whole extension (footer renderable + helpers)

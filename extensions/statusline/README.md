# statusline — compact footer

Replaces Pi's built-in footer with a compact, color-coded status line. It registers no tool — just the footer plus a `/statusline` settings menu. It auto-enables on `session_start` in TUI mode and clears itself on `session_shutdown`.

## What it shows

```
Model · Effort · CTX 23% · ~cwd · branch              ↑in ↓out Rcache $cost
advisor: …                                            ← line 2, only when set
```

- **Left:** model name · effort (thinking level, only when the model supports reasoning and the level isn't `off`) · context usage % · cwd (shortened to `~`) · git branch (if any).
- **Right:** input / output / cache-read token counts and cost, right-aligned. Each part is omitted when zero (no `↑0 ↓0` noise).
- **Line 2:** extension statuses from `ctx.ui.setStatus()`, sorted by key. The custom footer replaces the built-in one, so without this any extension status text would silently vanish.

## Configuration

Run `/statusline` for a settings menu (mirrors `/rewind`'s select loop; changes persist and apply to the footer immediately):

- **Usage stats** — toggle the right-aligned `↑in ↓out Rcache $cost` cluster.
- **Extension status line** — toggle the second line forwarding `ctx.ui.setStatus()` statuses.
- **CTX warning / error color from** — the CTX% color-tier thresholds (accent → warning → error), presets or custom. The tiers stay ordered: raising warn drags error up, lowering error pulls warn down.

Settings persist at `~/.pi/agent/pi-config/statusline.json` and may also be hand-edited (+ `/reload`; the render callback runs every frame, so the file is read once per session, not per frame). Every field may be omitted — defaults reproduce the historical behavior:

```json
{
	"ctxWarnPct": 70,
	"ctxErrorPct": 90,
	"showUsageStats": true,
	"showStatusLine2": true
}
```

Thresholds are clamped to 0–100 with `ctxErrorPct` never below `ctxWarnPct`; invalid values fall back per-field.

## Design notes

- **Theme-agnostic colors.** All coloring goes through `theme.fg(...)` / `theme.getThinkingBorderColor(level)`, so it adapts to any loaded theme, not just `ice-cream`. Context % shifts accent → warning → error by usage tier.
- **Usage stats are recomputed here by design.** `setFooter` fully replaces Pi's built-in footer and `footerData` exposes no precomputed stats (upstream: "token stats are available via `ctx.sessionManager`") — the built-in `FooterComponent` does the same iteration internally.
- **Live data.** Pi's `setFooter` returns a renderable that re-reads `ctx.sessionManager` / `ctx.model` / `ctx.getContextUsage()` on each render, so the line stays current; an `onBranchChange` subscription requests a render on branch switches. Effort (thinking level) is recovered by scanning session branch entries.
- **Narrow terminals.** When the line doesn't fit, the right-side token/cost stats are kept intact and the left side is truncated — stats are more useful than a long cwd.
- **Helpers.** `fmtTokens` is tiered (`999`, `1.2k`, `34k`, `1.5M`); `shortCwd` strips trailing separators before folding the home prefix to `~`; `sanitizeStatus` flattens status text to one line.

## Files

- `index.ts` — the footer renderable + helpers, `/statusline` registration
- `config.ts` — statusline.json load/save/validation (thresholds, toggles)
- `menu.ts` — the `/statusline` settings menu (live-applies via `onChange`)

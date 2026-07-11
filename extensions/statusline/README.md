# statusline — fixed two-line footer

Replaces Pi's built-in footer with a fixed, color-coded two-line status display.
It registers no tool or command and has no configuration file. The footer
auto-enables on `session_start` in TUI mode and clears itself on
`session_shutdown`.

## What it shows

```text
DeepSeek V4 Flash (deepseek) · max · CTX 3.5%/1.0M · ~/Projects/test · main
↑33k ↓2.8k R265k W12k CH96.8% $0.006
```

### Line 1 — session identity

- **Model:** human-readable model name, falling back to the model id.
- **Provider:** the model source in parentheses, such as `(deepseek)` or
  `(openrouter)`.
- **Effort:** the latest thinking level when the model supports reasoning and
  the level is not `off`.
- **Context:** used percentage plus context-window size. The percentage uses
  fixed semantic tiers: accent normally, warning above 70%, error above 90%.
- **Working directory:** full cwd shortened against the home directory with
  `~`.
- **Git branch:** appended when available.

### Line 2 — usage and extension status

- `↑` cumulative input tokens.
- `↓` cumulative output tokens.
- `R` cumulative cache-read tokens.
- `W` cumulative cache-write tokens, omitted when zero.
- `CH` cache-hit percentage for the latest assistant request, calculated as
  `cacheRead / (input + cacheRead + cacheWrite)` and shown only when that
  request used cache.
- `$` cumulative cost; `(sub)` is appended when the current model uses an OAuth
  subscription.
- Extension status text from `ctx.ui.setStatus()` is sorted by key and aligned
  to the right when space permits.

Zero-value usage fields are omitted. Before the first assistant response, the
second line is omitted unless an extension status exists.

## Layout and colors

- Model name uses `toolTitle` and bold; provider uses `muted`.
- Effort uses Pi's thinking-level color.
- Context uses `accent`, `warning`, or `error` according to the fixed thresholds.
- Working directory uses `success`; Git branch uses `accent`.
- Usage statistics use `dim`; extension status text uses `muted`.
- The first line truncates at the terminal width. On the second line, usage
  statistics take priority and extension status text uses the remaining width.

Pi does not expose auto-compaction state to extension footer factories, so the
native `(auto)` marker is intentionally not reproduced. Depending on private Pi
state solely for that marker would make the extension unnecessarily fragile.

## Migration from the configurable version

The previous `/statusline` command and
`~/.pi/agent/pi-config/statusline.json` configuration are no longer used. An
existing config file is left untouched and may be removed manually.

## Files

- `index.ts` — footer lifecycle, formatting, usage aggregation, and responsive
  two-line layout

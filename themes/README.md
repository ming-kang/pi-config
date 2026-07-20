# themes

This directory contains Pi theme resources bundled with `pi-config`. Theme files
are discovered through the package manifest's `pi.themes` entry.

## Bundled themes

| Theme | File | Notes |
|---|---|---|
| `ice-cream-dark` | `ice-cream-dark.json` | Cool salt night plate; warm cream tool titles; neutral user chip. |
| `ice-cream-light` | `ice-cream-light.json` | Daylight salt paper; same semantic mapping, ink-on-paper contrast. |

## Design intent (海盐冰淇淋)

Identity stays **ice-cream / sea-salt**: cool cyan-blue plate + warm cream scoops.
The palette is built around a cold neutral base with warm accents for tooling
and semantic highlights, keeping the UI calm and readable.

### Contrast hierarchy

| Role | Color idea | Examples |
|---|---|---|
| Primary accent | Cool **seasalt** | `accent`, headings, selected chrome |
| Warm tooling | Warm **cream** → **coral** | `toolTitle`, keywords, list bullets |
| Text ladder | 4-step grayscale | `text` → `muted` → `dim` → `faint` |
| User chip | Cool-neutral solid block | `bgUserMsg` with a **large step** off terminal/default bg |
| Tool cards | Transparent (no fill) | `tool*Bg` = `""`, status shown via title/output color only |
| Bash mode | Coral border | `bashMode` = coral, shared with `syntaxKeyword` |
| Semantics | Seafoam / red / gold | `success`, `error`, `warning` — kept pastel and not oversaturated |
| Selection | Cool blue-gray | `bgSelected` distinct from user chip |
| Thinking levels | Cool → warm hue arc | blue-gray → blue → teal → green → gold → orange → red |

### Surface hierarchy

| Var | Role | Intent |
|---|---|---|
| `bgBase` | page / terminal chrome | cool salt night or salt paper |
| `bgSurface` | secondary cards / export card | mid lift |
| `bgSelected` | list / tree selection | cool blue-gray, distinct from user chip |
| `bgUserMsg` | user message | **strong neutral chip** with a large luminance step off the base background (dark ≈ +40 L; light ≈ −30 L) |
| `bgCustomMsg` | extension / system (var kept) | unused while `customMessageBg` is `""` |
| `bgToolPending` / `Success` / `Error` | tool cards (vars kept) | unused while `tool*Bg` is `""` |

Tool/system chips use theme `""` = terminal default background (no alpha). Restore
solid scoops by pointing the tool/custom `*Bg` color tokens back at these vars.

### Foreground roles (Pi tokens)

| Token | Color idea | Typical use |
|---|---|---|
| `toolTitle` | cream (warm) | `edit`, `read`, `$ command` |
| `accent` | seasalt (cool) | paths, selected chrome, headings |
| `toolOutput` | muted | tool body lines when no tool bg |
| `thinkingText` | dim | thinking blocks more recessed than body |
| `muted` / `dim` | mid grays | collapse hints, secondary labels |
| `success` / `error` / `warning` | seafoam / red / gold | status, not whole-card fills |
| `bashMode` | coral | editor border in `!` bash mode |

Readability rules:

- Keep body `text` high-contrast against every surface (near-white on dark,
  near-ink on light).
- **User chip must read as a block**, not a soft wash: on dark, lift well above
  terminal default; on light, sink clearly below paper white. Aim for a similar
  delta to the ~40 L contrast benchmarks, cool-tinted.
- With transparent tool cards, `toolOutput` must stay readable on the terminal
  default bg — prefer mid-muted, not ultra-faint; keep `muted`/`dim` further
  from `text` so collapse hints stay secondary.
- State tints stay pastel; cream titles + seasalt accents carry identity.
- Avoid muddy low-luminance green/red panels and warm-brown user chips that
  fight the cool sea-salt base.

## Conventions

- Follow Pi's theme schema (`theme-schema.json` in the upstream Pi package).
  `thinkingMax` is optional upstream (falls back to `thinkingXhigh`); ice-cream
  sets it explicitly so `max` effort is distinct from `xhigh`.
- Prefer semantic color keys (`accent`, `success`, `warning`, `error`,
  `toolTitle`, `toolOutput`, `selectedBg`, etc.) over extension-specific color
  assumptions.
- **The `colors` block is shared across ice-cream variants.** Every semantic key
  references a var by name (or `""` for terminal default bg), and both variants
  define the same var set — a new variant only needs a new `vars` palette. Keep
  the mappings identical when editing either file.
- **`export` values must mirror their `vars` sources by hand** (JSON has no
  references): `pageBg` = `bgBase`, `cardBg` = `bgSurface`, `infoBg` ≈
  `bgToolPending`. Update both when changing a base background.
- Custom functional UI such as dialogs, overlays, and the statusline should
  consume colors through `theme.fg(...)`, `theme.bg(...)`, and related theme
  helpers. Do not hard-code ANSI colors or hex values in extension code.
- When changing semantic theme keys, verify Pi's native tool output and the
  package's custom functional UI with a local session:

```bash
pi -ne -e ./pi-config
```

The root [README](../README.md) lists user-facing theme entries; this file owns
theme development notes.

# themes

This directory contains Pi theme resources bundled with `pi-config`. Theme files
are discovered through the package manifest's `pi.themes` entry.

## Bundled themes

| Theme | File | Notes |
|---|---|---|
| `ice-cream-dark` | `ice-cream-dark.json` | Sea-salt ice cream on a cool night plate: bright pastel scoops, deep user chip. |
| `ice-cream-light` | `ice-cream-light.json` | Daylight counterpart: cool salt paper, same `colors` mapping, bright scoops. |

## Surface hierarchy (海盐冰淇淋)

Metaphor: a cool dark (or salt-white) plate, with **bright ice-cream scoops** for
tools/system chrome, and a **deeper scoop well** for the user message so human
input stays distinct.

| Var | Role | Intent |
|---|---|---|
| `bgBase` | page / terminal chrome | cool salt night or salt paper |
| `bgSurface` | selection, cards | mid lift, still cooler than tool scoops |
| `bgUserMsg` | user message | **deeper** than tools — recessed distinction |
| `bgCustomMsg` | extension / system messages | bright cool sky scoop |
| `bgToolPending` | tool running | bright sea-salt blue scoop |
| `bgToolSuccess` | tool ok | bright mint scoop |
| `bgToolError` | tool failed | bright soft rose scoop |

Readability rules:

- Keep body `text` high-contrast against every surface (near-white on dark,
  near-ink on light).
- Raise `muted` / `dim` when tool panels get brighter so `toolOutput` stays
  legible on the luminous scoops.
- State tints stay pastel; cream `toolTitle` and accent hues carry identity.
- Avoid muddy low-luminance green/red tool panels and pure-neutral gray user
  chips that fight the cool sea-salt base.

## Conventions

- Follow Pi's theme schema (`theme-schema.json` in the upstream Pi package).
- Prefer semantic color keys (`accent`, `success`, `warning`, `error`,
  `toolTitle`, `toolOutput`, `selectedBg`, etc.) over extension-specific color
  assumptions.
- **The `colors` block is shared across ice-cream variants.** Every semantic key
  references a var by name, and both variants define the same var set — a new
  variant only needs a new `vars` palette. Keep the mappings identical when
  editing either file.
- **`export` values must mirror their `vars` sources by hand** (JSON has no
  references): `pageBg` = `bgBase`, `cardBg` = `bgSurface`, `infoBg` =
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

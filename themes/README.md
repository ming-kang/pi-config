# themes

This directory contains Pi theme resources bundled with `pi-config`. Theme files
are discovered through the package manifest's `pi.themes` entry.

## Bundled themes

| Theme | File | Notes |
|---|---|---|
| `ice-cream-dark` | `ice-cream-dark.json` | Dark pastel theme tuned for compact tool renderers and the statusline. |
| `ice-cream-light` | `ice-cream-light.json` | Light counterpart: identical `colors` mapping, light `vars` palette. |

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
- Extension renderers should consume colors through `theme.fg(...)`,
  `theme.bg(...)`, and related theme helpers. Do not hard-code ANSI colors or
  hex values in renderer code. (`theme.fg` keys are Pi's fixed `ThemeColor`
  union — themes cannot invent new semantic keys.)
- When changing theme keys used by renderers, verify compact tool output and the
  statusline with a local session:

```bash
pi -ne -e ./pi-config
```

The root [README](../README.md) lists user-facing theme entries; this file owns
theme development notes.

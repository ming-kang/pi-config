# themes

This directory contains Pi theme resources bundled with `pi-config`. Theme files
are discovered through the package manifest's `pi.themes` entry.

## Bundled themes

| Theme | File | Notes |
|---|---|---|
| `ice-cream-dark` | `ice-cream-dark.json` | Dark pastel theme tuned for Pi's native UI and the statusline. |
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

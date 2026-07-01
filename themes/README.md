# themes

This directory contains Pi theme resources bundled with `pi-config`. Theme files
are discovered through the package manifest's `pi.themes` entry.

## Bundled themes

| Theme | File | Notes |
|---|---|---|
| `ice-cream` | `ice-cream.json` | Dark pastel theme tuned for compact tool renderers and the statusline. |

## Conventions

- Follow Pi's theme schema (`theme-schema.json` in the upstream Pi package).
- Prefer semantic color keys (`accent`, `success`, `warning`, `error`,
  `toolTitle`, `toolOutput`, `selectedBg`, etc.) over extension-specific color
  assumptions.
- Extension renderers should consume colors through `theme.fg(...)`,
  `theme.bg(...)`, and related theme helpers. Do not hard-code ANSI colors or
  hex values in renderer code.
- When changing theme keys used by renderers, verify compact tool output and the
  statusline with a local session:

```bash
pi -ne -e ./pi-config
```

The root [README](../README.md) lists user-facing theme entries; this file owns
theme development notes.

# shared — non-extension utilities

`extensions/shared/` is a pure import target for code that more than one
extension needs. It deliberately has no `index.ts` and no Pi manifest, so Pi's
extension loader does not treat it as an extension.

## Import boundary

Extensions may import from `../shared/*` and `../tools-view/shared.ts`. They
must not import another extension's internal modules directly. If two extensions
need the same behavior, move the neutral helper here instead of coupling one
extension to the other.

Keep shared modules small and specific: each file should own one reusable
concern, stay free of extension lifecycle hooks, and avoid shared mutable state
unless that state is the point of the module.

## Modules

| Module | Purpose | Common reuse case |
|---|---|---|
| `file-state.ts` | Read-state cache keyed by normalized absolute path. | `read-before-edit` records what the model saw; `rewind` invalidates entries after restores. |
| `tool-path.ts` | Edit/write tool-event path extraction + cwd resolution. | `read-before-edit` and `rewind` agreeing on "which file did this tool call touch". |
| `tool-toggle.ts` | Sync a registered tool's active state with a predicate. | `fast-context` (API key configured?) toggling model visibility. |
| `http.ts` | `fetchWithRetry`: per-attempt timeout + bounded transient retry (5xx/429/network). | Network extensions like `deepwiki`; fast-context's streaming client deliberately keeps its own (fragile wire protocol). |
| `json-store.ts` | Tolerant JSON config load/save with pretty output. | Persistent extension settings that need missing/corrupt-file fallback. |
| `paths.ts` | Single source of truth for `~/.pi/agent/pi-config` storage paths. | Config or backup files shared across machines/sessions. |
| `extension-ui.ts` | Small ExtensionContext helpers: `isTui`, `requireInteractiveUI`, `appendSoftConstraint`. | Commands that need UI guards; lifecycle hooks that append tagged soft prompt blocks. |
| `render-cache.ts` | Width-keyed render cache for custom TUI components. | Dialogs that wrap or truncate lines and must stay correct after resize. |
| `dialog-primitives.ts` | Low-level dialog render helpers: rule borders, wrapped prefix text. | Custom dialogs that should share the same border/wrap behavior. |
| `text.ts` | Small text helpers: `firstLine`, `truncateText`, `formatSize`. | Collapsed render summaries, bounded labels, and consistent byte-size display. |

## Usage examples

Use `requireInteractiveUI` in command handlers instead of repeating the same
`ctx.hasUI` notification pattern:

```ts
if (!requireInteractiveUI(ctx, "/example")) return;
```

Use `appendSoftConstraint` from `before_agent_start` handlers when an extension
needs to add a tagged, per-turn system-prompt reminder without duplicating prompt
assembly boilerplate:

```ts
return appendSoftConstraint(event, "example_constraint", [
	"One short constraint line.",
]);
```

Use `WidthCachedRender` only for render output that depends on terminal width;
the cache key includes width because some TUI resize paths request render without
calling component invalidation first.

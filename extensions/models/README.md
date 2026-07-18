# `models` — custom-provider and model management

`/models` manages `~/.pi/agent/models.json` without making users hand-edit the
whole document. Its field hierarchy follows Pi's upstream
[Custom Models documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md).

Provider ID is the only Provider identity in this UI. There is no separate
Provider display name.

## Main flow

```text
/models
└─ Provider browser
   ├─ + Add provider
   │  ├─ Guided setup: ID → Base URL → API → authentication
   │  ├─ Review and create
   │  ├─ Fetch from server
   │  └─ Models workspace
   ├─ <Provider ID> → Provider workspace
   └─ Reload providers
```

Selecting a Provider opens its workspace directly; there is no intermediate
action menu. The workspace keeps common connection fields, model management,
and advanced collections in one flat screen, with current values visible on
each row.

The new-provider wizard does not ask users to select a server template. API
protocol is a direct four-choice setting:

- `openai-completions`
- `openai-responses`
- `anthropic-messages`
- `google-generative-ai`

Authentication setup offers the common `$ENV_VAR` path first, while still
accepting a literal, interpolation, or `!command`. It can be deferred for a
keyless local server or a later `/login <provider-id>`. A final review screen
lets every value be corrected before the first write.

## Provider and model workspaces

Provider edits share one in-memory draft. Ctrl+S or **Save changes** writes it
atomically and refreshes Pi's available models. A clean Ctrl+S is a no-op.
Leaving a dirty Provider offers save, discard, or continue editing.

Every TUI selector wraps in both directions: Up on the first row moves to the
last row, and Down on the last row moves to the first. Parent menus remember
their cursor when a child screen closes. The Models workspace also remembers
the current model, follows a renamed model ID, and chooses the nearest remaining
row after removal.

The Models workspace is list-first and teaches its actions in two short hint
lines instead of hiding them behind nested menus:

- Enter edits the current model; Space selects models for bulk work.
- `a` adds model IDs and `f` fetches the remote catalog.
- With a selection, `e` bulk-edits and `d` removes.
- `/` enters filter mode; Esc clears the query, closes filter mode, then goes back.
- Tab keeps the complete action menu available.
- Ctrl+A/Ctrl+X select or clear all (or all matching the filter).
- Ctrl+S saves the Provider draft.

The empty Models workspace shows the add/fetch actions inline. Model IDs can
be pasted as comma- or newline-separated values. A model detail screen is flat
rather than split across Capabilities, Limits, and Advanced submenus. It shows
ID, name, reasoning, input, one **Limits** row, thinking map, API override,
cost, and compatibility in one place.

Bulk editing applies reasoning, input, limits, and thinking maps to the
selected models. Clearing a field is distinct from leaving it unchanged.

## Model limits

`contextWindow` and `maxTokens` are edited together in a dedicated **Limits**
screen. It accepts token shorthand such as `272K`, `128K`, or `1.05M`, while
writing an exact integer to the Provider draft. Clearing either field restores
Pi's documented fallback for that field: 128,000 context or 16,384 output.
Applying the dialog updates only the in-memory draft; Ctrl+S in the Provider
workspace is still the only persistent save.

There are intentionally no global limit presets. A model's theoretical maximum
can differ from the effective limit of its Provider, gateway, account, route,
or pricing policy. For example, a Codex relay may correctly use 272K context
where a direct model catalog lists a larger maximum.

In a TUI, the Limits screen lazily shows one models.dev reference beside the
inputs on wide terminals (and below them on narrow terminals). It uses the
best thresholded model-ID match and labels it **Exact model ID**, **Similar
model ID**, or shows no reference. The panel is explicitly read-only:

- it has no apply or sync control and never writes configuration;
- it shows only context and max-output values plus its catalog source;
- it warns that values may differ for the current Provider or gateway;
- a failed or unavailable lookup never prevents normal limit editing.

The configured route remains authoritative. The reference is not used for
pricing, reasoning maps, or automatic model updates.

Bulk Limits uses one dedicated screen with a separate action for each field:
**Leave unchanged**, **Set value**, or **Clear override**. It does not show a
single models.dev value for a heterogeneous selection.

The manager does not promote undocumented model-level `baseUrl` or `headers`.
Existing unknown fields remain untouched. The Provider workspace keeps
documented headers, `authHeader`, Radius OAuth, compatibility, and built-in
model overrides; compatibility menus list only documented keys and preserve
unknown existing keys unchanged.

## Thinking-level mapping

Each model has a seven-row `thinkingLevelMap` table:

```text
off → minimal → low → medium → high → xhigh → max
```

For every Pi level, choose one of:

- **Pi default** — remove the key. `off` through `high` use Pi's default
  mapping; unmapped `xhigh` and `max` are not offered.
- **Hidden** — write `null`, making that Pi level unavailable.
- **Map to provider value** — write a string sent to the provider.

The **High / Max only** preset maps `minimal` through `high` to `"high"`, and
`xhigh`/`max` to `"max"`; `off` remains unchanged. The identity preset makes
all levels through `max` explicit. The same table supports batch changes with a
per-row **leave unchanged** state.

## Discovering remote models

Creating a Provider automatically tries to fetch its catalog. The Models
workspace can fetch again after applying any dirty connection changes.

- OpenAI Completions/Responses: `<baseUrl>/models`.
- Ollama fallback for `/v1` URLs: `<origin>/api/tags`.
- Google Generative AI: paginated `<baseUrl>/models`.
- Anthropic Messages: no public catalog endpoint, so it goes directly to
  manual model-ID entry.

Fetching uses a cancellable bordered loader. Catalog rows start unselected:
Enter/Space toggles a row, `/` filters, and Ctrl+S imports the selection.
Results are deduplicated, sorted, bounded to 2,000 IDs / 4 MiB / 10 seconds,
and import only returned `id` plus a returned `name` when present. A failed
fetch offers retry, provider editing, or manual entry instead of ending the
workflow.

## Commands and persistence

| Command | Behavior |
|---|---|
| `/models` | Browse providers. |
| `/models <provider-id>` | Open an exact Provider ID or seed search. |
| `/models list` | Browse providers. |
| `/models add` | Create a Provider, then discover or enter models. |
| `/models edit <provider-id>` | Open a Provider workspace. |
| `/models fetch <provider-id>` | Fetch models, then open its Models workspace. |
| `/models remove <provider-id>` | Confirm and remove a Provider. |
| `/models reload` | Reload providers from local configuration. |

`/models probe <provider-id>` remains a compatibility alias for `fetch` but is
not promoted in completion. Pi's native argument completion is used throughout:
typing `/models ` offers commands and Provider IDs, while `edit`, `remove`, and
`fetch` complete Provider IDs after the space.

Writes read the complete document first, preserve unrelated and unknown fields,
use atomic replacement, and restore the exact prior bytes if Pi rejects the
new configuration. Provider IDs must be nonempty and cannot contain `/` (Pi
reserves `provider/model` references); the manager imposes no extra ASCII or
length restriction.

A Provider saved by this extension gets stable, readable field order. Known
Provider fields begin with `baseUrl`, `api`, `apiKey`, and `models`. Known model
fields begin with `id`, `name`, `reasoning`, `thinkingLevelMap`, `input`,
`contextWindow`, and `maxTokens`. Thinking levels are ordered from `off` through
`max`; input types are ordered as text then image. Every unknown field is
appended unchanged, and Providers that were not edited retain their existing
object order.

## Files

- `index.ts` — command routing, transactional saves, and catalog fetches.
- `editor.ts` — Provider/model drafts, bulk work, and advanced field editors.
- `dialog.ts` — browse-first selectors, checklists, Models workspace, and Limits UI.
- `models-dev.ts` — bounded, session-only models.dev reference lookup and matching.
- `store.ts` — comment-aware, lossless models.json storage.
- `probe.ts` — bounded catalog requests and response normalization.

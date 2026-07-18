# `models` — structured custom-model management

`/models` manages `~/.pi/agent/models.json` through provider and model menus.
Users never need to edit the complete JSON document inside Pi.

The supported fields follow Pi's upstream
[Custom Models documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md).

## Main flow

```text
/models
└─ Provider list
   ├─ + Add provider
   ├─ Reload models.json
   └─ <provider>
      ├─ Configure provider and models
      │  ├─ Provider fields
      │  ├─ Headers
      │  ├─ Compatibility settings
      │  ├─ Model overrides
      │  └─ Models
      │     ├─ + Add model
      │     └─ <model> → edit every model field
      ├─ Fetch remote model list
      └─ Remove provider
```

Every editor works on an in-memory draft. Cancel discards the draft; saving
updates `models.json`, reloads Pi's registry, and keeps the editor open if Pi
rejects the result.

## Provider fields

The provider editor exposes:

- provider ID and display name;
- default API and base URL;
- API-key configuration (`literal`, `$ENV_VAR`, interpolation, or `!command`);
- Radius OAuth and `authHeader`;
- structured header add/edit/rename/remove;
- compatibility fields, including a list of documented keys plus custom keys;
- per-model overrides;
- the provider's model list.

Renaming a provider is committed as one read and one write. Unknown provider
fields that the menu does not understand are preserved unchanged.

## Model fields

Each model can configure:

- ID and display name;
- API and base-URL overrides;
- reasoning support;
- input types (`text` or `text + image`);
- context window and maximum output tokens;
- a structured thinking-level map (`off` through `max`, including unsupported
  `null` levels);
- input/output/cache token costs and pricing tiers;
- model-specific headers and compatibility fields.

Model overrides use the same relevant field editors for built-in or
extension-registered models. Unknown model and override fields are preserved.

## Fetching model lists

**Fetch remote model list** resolves the provider's effective URL, API key, and
headers through Pi, then supports:

- OpenAI Chat Completions / Responses: `<baseUrl>/models`;
- Ollama fallback for `/v1` base paths: `<origin>/api/tags`;
- paginated Google Generative AI model lists;
- Anthropic Messages: no fetch, because Anthropic exposes no public catalog
  endpoint.

Results are deduplicated and sorted, then displayed in a scrollable
multi-select. Selected entries are appended once as minimal model definitions;
their fields can then be customized from the Models menu.

Catalog requests are bounded to 10 seconds, 4 MiB, and 2,000 model IDs. The
extension does not currently enrich results from `models.dev`; remote discovery
and per-model customization remain separate, predictable operations.

## Command shortcuts

The `/models` menu is the primary interface. Thin shortcuts are also available:

| Command | Behavior |
|---|---|
| `/models` | Open the provider list. |
| `/models list` | Same as `/models`. |
| `/models add` | Open a new provider draft. |
| `/models edit <provider-id>` | Open the provider field editor. |
| `/models remove <provider-id>` | Confirm and remove a provider. |
| `/models probe <provider-id>` | Fetch and select remote models. |
| `/models reload` | Reload `models.json`. |

Completion offers provider IDs after `edit`, `remove`, and `probe`.

## Persistence and recovery

- The whole document is read before every mutation, preserving unrelated
  providers and unknown top-level fields.
- Pi-style line and block comments are accepted on read. Managed writes format
  the result as JSON, so comments are not retained.
- Writes use a unique temporary file and atomic rename.
- Existing permissions are retained where supported by the platform.
- After every mutation, `ctx.modelRegistry.refresh()` is authoritative. Schema
  or provider-composition failures restore the exact original file bytes and
  refresh the previous registry state.
- Probe re-reads the provider before appending selections, avoiding duplicate
  models and reducing overwrite risk from concurrent manual edits.

Provider IDs created through the manager use letters, digits, `_`, and `-`
(maximum 64 characters). Authentication login/logout remains the responsibility
of `/login` and `/logout`.

## Files

- `index.ts` — command/menu routing, registry refresh, rollback, and probe integration.
- `editor.ts` — staged provider, model, header, compatibility, override, thinking, and cost menus.
- `dialog.ts` — single-line input and remote-model multi-select components.
- `store.ts` — comment-aware reads, lossless mutations, snapshots, and atomic writes.
- `probe.ts` — bounded catalog requests and response normalization.
- `constants.ts` — command parsing, API choices, and defaults.

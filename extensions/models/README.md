# `models` — structured custom-model management

`/models` manages `~/.pi/agent/models.json` through provider and model menus.
Users never need to edit the complete JSON document inside Pi.

The entry experience is browse-first: short lists use Pi's native menu, while
larger lists support fuzzy filtering by ID, API, or URL. A search
input only appears after the user types (or opens `/models <query>`), so a
normal menu never looks like an accidental form.

The supported fields follow Pi's upstream
[Custom Models documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md).

## Main flow

```text
/models
└─ Provider list (browse, then type to filter when needed)
   ├─ + Add provider
   │  └─ Choose starter: OpenAI-compatible, Ollama, Anthropic, Google, blank
   ├─ Reload models.json
   └─ <provider>
      ├─ Workspace
      │  ├─ Models (primary)
      │  │  ├─ + Add model IDs (comma-separated paste)
      │  │  ├─ Discover remote models (save workspace first)
      │  │  ├─ Bulk edit selected models
      │  │  └─ <model> → essentials / capabilities / limits / advanced
      │  ├─ Provider ID
      │  ├─ Connection (API, base URL, authentication)
      │  └─ Advanced (headers, compatibility, built-in model overrides)
      └─ Remove provider
```

Every editor works on an in-memory draft. Cancel discards the draft; saving
updates `models.json`, reloads Pi's registry, and keeps the editor open if Pi
rejects the result.

## Deliberate field hierarchy

Most custom providers only need a provider ID, API, base URL, and one or more
model IDs. The workspace therefore keeps model management, connection, and the
provider ID visible, and moves rarely needed protocol controls behind
**Advanced**. No documented provider or model field is silently removed; other
existing JSON fields are preserved untouched rather than promoted into the UI.

The new-provider starters prefill common transport choices. They never invent
user secrets or model metadata (the Ollama starter uses Pi's documented
`"ollama"` placeholder); users still set their own provider ID, endpoint, and
model IDs.

## Provider settings

The provider editor exposes:

- provider ID;
- default API and base URL;
- API-key configuration (`literal`, `$ENV_VAR`, interpolation, or `!command`);
- Radius OAuth and `authHeader`;
- structured header add/edit/rename/remove (Advanced);
- compatibility fields, including a list of documented keys plus custom keys
  (Advanced);
- per-model overrides for built-in models (Advanced);
- the provider's model list (the primary workspace action).

Renaming a provider is committed as one read and one write. Unknown provider
fields that the menu does not understand are preserved unchanged.

## Model editing and bulk work

Adding a model only asks for its ID. Paste several comma-separated IDs to add
an entire known catalog without repeated forms. The **Bulk edit** multi-select
then applies reasoning support, input type, context window, or max output
tokens to any selected models at once; clearing an override is supported too.

An individual model shows these common groups first:

- ID and optional display name;
- capabilities (reasoning and text/image input);
- limits (context window and maximum output tokens);
- Advanced settings only when a model needs a transport, pricing, or protocol
  exception.

Advanced model settings can configure:

- API and base-URL overrides;
- a structured thinking-level map (`off` through `max`, including unsupported
  `null` levels);
- input/output/cache token costs and pricing tiers;
- model-specific headers and compatibility fields.

Model overrides use the same relevant field editors for built-in or
extension-registered models. Unknown model and override fields are preserved.

## Fetching model lists

**Discover remote models**, inside the Models workspace, first saves the
provider draft and then resolves its effective URL, API key, and headers
through Pi. It supports:

- OpenAI Chat Completions / Responses: `<baseUrl>/models`;
- Ollama fallback for `/v1` base paths: `<origin>/api/tags`;
- paginated Google Generative AI model lists;
- Anthropic Messages: no fetch, because Anthropic exposes no public catalog
  endpoint.

Results are deduplicated and sorted, then displayed in a scrollable
multi-select. It starts as a clean checklist; typing reveals fuzzy filtering,
and filtering never discards selections made outside the current result set.
Selected entries are appended once as minimal model definitions; their fields
can then be customized from the Models workspace.

Catalog requests are bounded to 10 seconds, 4 MiB, and 2,000 model IDs. The
extension does not currently enrich results from `models.dev`; remote discovery
and per-model customization remain separate, predictable operations.

## Command shortcuts

The `/models` menu is the primary interface. Thin shortcuts are also available:

| Command | Behavior |
|---|---|
| `/models` | Open the provider list. |
| `/models <provider-id>` | Open one exact provider, or seed the provider search. |
| `/models list` | Same as `/models`. |
| `/models add` | Choose a provider starter, then open its workspace draft. |
| `/models edit <provider-id>` | Open the provider workspace. |
| `/models remove <provider-id>` | Confirm and remove a provider. |
| `/models probe <provider-id>` | Fetch and select remote models. |
| `/models reload` | Reload `models.json`. |

Completion offers provider IDs and model-count descriptions both directly and
after `edit`, `remove`, and `probe`.

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
- `editor.ts` — staged provider workspace, batch model operations, and focused advanced editors.
- `dialog.ts` — single-line input plus browse-first fuzzy selectors and multi-select components.
- `store.ts` — comment-aware reads, lossless mutations, snapshots, and atomic writes.
- `probe.ts` — bounded catalog requests and response normalization.
- `constants.ts` — command parsing, API choices, and defaults.

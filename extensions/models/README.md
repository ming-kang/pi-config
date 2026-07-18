# `models` — manage `~/.pi/agent/models.json`

`/models` opens one Pi-native management menu for the whole custom-model
workflow. Configuration is edited as JSON instead of duplicating Pi's evolving
schema in a large field-by-field form.

The data contract follows Pi's upstream
[Custom Models documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md).

## Main menu

```text
Models · ~/.pi/agent/models.json

  Edit complete models.json
  + Add provider from a starter JSON
  CPA — anthropic-messages · 1 custom model · http://127.0.0.1:8317
  ollama — openai-completions · 3 custom models · http://localhost:11434/v1
  Reload models.json
  Close
```

Selecting a provider opens:

```text
Edit provider JSON
Rename provider key
Probe remote model catalog
Remove provider
Back
```

The complete-file and provider editors both use Pi's native multiline editor.
That directly supports every documented field, including `oauth`,
`authHeader`, `compat`, `thinkingLevelMap`, `cost.tiers`, per-model headers,
and `modelOverrides`, without this extension having to mirror each schema
revision.

Adding a provider asks for its ID, then offers small starter objects for:

- an OpenAI-compatible local server;
- an Anthropic-compatible proxy;
- Google AI Studio;
- overriding a built-in provider.

The starter opens in the same JSON editor before anything is written.

## Command shortcuts

The menu is the primary interface. These commands are thin shortcuts into the
same operations:

| Command | Behavior |
|---|---|
| `/models` | Open the management menu. |
| `/models file` | Edit the complete file. |
| `/models list` | Open the management menu. |
| `/models add` | Add from a starter JSON. |
| `/models edit <provider-id>` | Edit one provider object. |
| `/models remove <provider-id>` | Confirm and remove one provider. |
| `/models probe <provider-id>` | Probe and append selected model IDs. |
| `/models reload` | Re-read the file without restarting Pi. |

Completion offers provider IDs after `edit`, `remove`, and `probe`.

## Probe flow

Probe is deliberately separate from JSON editing. It uses the provider's
effective API/base URL and Pi's resolved authentication, then handles:

- OpenAI Chat Completions / Responses: `<baseUrl>/models`;
- Ollama fallback for base paths ending in `/v1`: `<origin>/api/tags`;
- paginated Google Generative AI: `<baseUrl>/models`;
- Anthropic Messages: no probe, because Anthropic exposes no public catalog
  endpoint.

Catalog responses are capped at 4 MiB, 10 seconds, and 2,000 normalized IDs.
Results are deduplicated and sorted, then shown in a scrollable multi-select.
Selected entries are appended as minimal `{ "id": "..." }` definitions, with
`name` included only when the catalog supplies a distinct display name.

This extension does not query `models.dev` or guess model metadata. That would
be a separate enrichment feature with its own matching and freshness policy;
it is not required by Pi's `models.json` contract.

## Persistence and recovery

- **Complete-file edit:** writes exactly the text returned by Pi's editor, so
  comments and formatting can be retained.
- **Provider operations:** parse the whole document, preserve unrelated and
  unknown fields, then normalize the resulting file as formatted JSON. Existing
  comments are therefore not retained by provider add/edit/rename/remove/probe.
- Writes use a unique temporary file and atomic rename. Existing permissions
  are retained where the platform supports them.
- Provider rename is one read/one write, not delete followed by insert.
- Every mutation immediately calls `ctx.modelRegistry.refresh()`. If Pi rejects
  the schema or provider composition, the exact original file bytes are
  restored and the previous registry state is refreshed.
- Probe re-reads the provider before appending selections, reducing accidental
  overwrite of a concurrent manual edit.

Provider IDs created or renamed through the menu use letters, digits, `_`, and
`-` (maximum 64 characters), keeping slash-command targeting unambiguous.
Authentication login/logout remains the responsibility of `/login` and
`/logout`.

## Files

- `index.ts` — menu, command shortcuts, JSON editing, registry reload, and rollback.
- `store.ts` — comment-aware reads, lossless provider mutations, snapshots, and atomic writes.
- `probe.ts` — bounded catalog requests and response normalization.
- `dialog.ts` — private multi-select probe checklist.
- `constants.ts` — command parsing and probe limits.

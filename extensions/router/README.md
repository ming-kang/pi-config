# `router` — Codex-style API relays

`/router` connects Pi to OpenAI-compatible API relays with a **Codex-shaped** Responses client (self-hosted gateways such as sub2api, CPA, or codex2api, or any similar proxy).

Configuration lives at `~/.pi/agent/pi-config/router.json`.

Providers are registered at extension load via `pi.registerProvider` (config form + `streamSimple`). They do **not** go through `models.json`.

This follows Pi’s documented custom-provider path ([providers.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md), [custom-provider.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md)): the stream wraps the built-in `openAIResponsesApi()` from `@earendil-works/pi-ai/compat` (same idea as the GitLab Duo example), then reshapes the request for Codex-style relays.

## Request shape

Implementation: `stream.ts` calls `openAIResponsesApi().streamSimple` with a model that looks like Platform Responses (`api: "openai-responses"`), then `onPayload` reshapes the body toward Pi’s built-in `openai-codex-responses` request shape.

### Aligned with Pi `openai-codex` (body)

| Field / behavior | What we send |
|---|---|
| `store` | `false` |
| `stream` | `true` |
| System prompt | `instructions` (not a system/developer row in `input`) |
| Conversation | `input` items only |
| `text.verbosity` | default `"low"` |
| `tool_choice` | default `"auto"` |
| `parallel_tool_calls` | `true` |
| `include` | always includes `reasoning.encrypted_content` |
| `prompt_cache_key` | session id when caching is on (clamped) |
| Rejected Platform fields | drops `prompt_cache_retention`, `max_output_tokens`, `temperature`, `top_p`, `user`, `metadata`, `service_tier`, … |

Session affinity headers when a session id is present: hyphenated `session-id` and `x-client-request-id` (not underscore `session_id`). Compat: `sessionAffinityFormat: "openai-nosession"`, `supportsLongCacheRetention: false`. Originator header: `codex`.

### Intentionally different from ChatGPT Codex OAuth

These match **sk- relays**, not the official ChatGPT backend:

| | Pi `openai-codex` | This extension |
|---|---|---|
| Auth | ChatGPT OAuth JWT + `chatgpt-account-id` | Bearer `sk-…` (or `$ENV_VAR`) |
| URL | `{base}/codex/responses` | `{baseUrl}/responses` |
| Transport | SSE and optional WebSocket; SSE body may be zstd | SSE only via the OpenAI Responses client |
| `OpenAI-Beta` | set on the Codex client | not set |
| `originator` | `"pi"` in upstream | `"codex"` (CLI-style for transparent gateways) |

### Same-model multi-turn tool calls

On a **fixed relay + fixed model**, tool-call ids keep the Responses `call_…\|fc_…` form and replay like Codex. Pi only rewrites those ids when the turn is treated as a different model (`provider` / `api` / model id changed). Cross-model or cross-provider handoff into a custom relay id is **not** in Pi’s built-in allow-list (`openai`, `openai-codex`, `opencode`), so ids may be sanitized more aggressively there. That path is uncommon for relay use; we do not spoof `provider` to work around it (spoofing would mis-tag session history). Prefer staying on one model for long tool+reasoning sessions.

## Usage

```text
/router          Browse relays
/router add      Add a relay
/router reload   Re-register from disk
/router <id>     Open a relay
```

### UI map

```text
API relays                  ← relays first; add / reload at bottom
 └─ Relay · {id}            ← models · base URL · API key · remove
     └─ Models              ← Fetch catalog + one row per configured model
         └─ {model id}      ← display name · thinking levels
```

Edits **auto-save** to `router.json` and re-register the provider. There is no separate Save step — Back never discards committed field/model changes.

Nested multi-select (catalog) and the thinking-level editor still need **Ctrl+S to apply** that screen’s working set. If you Esc with unsaved toggles, the footer warns once; Esc again discards that screen only.

### Add flow

1. **Name** — provider id (for example `my-relay`); appears as `my-relay/gpt-5.6-sol` in `/model`
2. **Base URL** — usually ends with `/v1`
3. **API key** — literal `sk-…` or `$ENV_VAR`
4. **Fetch models** — `GET {baseUrl}/models`
5. **Select** — Space toggle, Ctrl+S apply (TUI); then the relay is written immediately

Each selected model gets defaults:

| Field | Default |
|---|---|
| `name` | **omitted** — `/model` shows the model **id** |
| `reasoning` | `true` |
| `input` | `text` + `image` |
| `contextWindow` | **272000** |
| `maxTokens` | 128000 |
| `thinkingLevelMap` | off…medium hidden; high / xhigh / max on |

### Customize models

Relay → **Models** → pick a model:

- **Display name** — optional label (for example `Luna`). Leave empty to show the id. Saved on confirm.
- **Thinking levels** — toggle each Pi level between **on** and **hidden** (`null`). Ctrl+S applies, then auto-saves the relay.

## Config shape

```json
{
  "version": 1,
  "relays": [
    {
      "id": "my-relay",
      "baseUrl": "https://relay.example/v1",
      "apiKey": "sk-…",
      "models": [
        {
          "id": "gpt-5.6-sol",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 272000,
          "maxTokens": 128000,
          "thinkingLevelMap": {
            "off": null,
            "minimal": null,
            "low": null,
            "medium": null,
            "high": "high",
            "xhigh": "xhigh",
            "max": "max"
          }
        },
        {
          "id": "gpt-5.6-luna",
          "name": "Luna",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 272000,
          "maxTokens": 128000
        }
      ]
    }
  ]
}
```

There is **no migration** from any older models manager config. Add relays with `/router add` (or edit `router.json` and `/router reload`).

## Files

| File | Role |
|---|---|
| `index.ts` | Async factory: load config, register providers, `/router` |
| `store.ts` | `router.json` read/write |
| `register.ts` | `registerProvider` / unregister |
| `stream.ts` | Wraps `openAIResponsesApi` + payload reshape |
| `probe.ts` | `GET …/models` |
| `presets.ts` | 272k defaults + thinking map helpers |
| `dialog.ts` | Selectors, multi-select, thinking editor (dirty Esc warn) |
| `ui.ts` | Command flows; auto-save on relay mutations |
| `constants.ts` | Command name, defaults, `router-codex` api tag |
| `types.ts` | Config types |

## Limits

- SSE only (no Codex WebSocket / zstd request body).
- Catalog probe expects OpenAI-style `{ data: [{ id }] }`.
- Empty model list → provider is not registered (nothing to select in `/model`).
- Body is Codex-oriented for transparent gateways; auth and URL stay Platform Responses (`sk-` + `/responses`).
- Same relay + same model: tool/reasoning multi-turn matches Codex-style Responses. Switching model or provider mid-session may normalize tool-call ids more strictly (upstream allow-list); not worked around here.
- Interactive `/router` needs a TUI (`ctx.hasUI`); otherwise you get a warning and no dialog.
- Catalog multi-select and thinking editor are apply-on-Ctrl+S screens; only those can be discarded with double Esc.

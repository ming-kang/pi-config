# `router` — Codex-style API relays

`/router` connects Pi to OpenAI-compatible API relays with a **Codex-shaped** Responses client (self-hosted gateways such as sub2api, CPA, or codex2api, or any similar proxy).

Configuration lives at `~/.pi/agent/pi-config/router.json`.

Providers are registered at extension load via `pi.registerProvider` (config form + `streamSimple`). They do **not** go through `models.json`.

This follows Pi’s documented custom-provider path ([providers.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md), [custom-provider.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md)): the stream wraps the built-in `openAIResponsesApi()` from `@earendil-works/pi-ai/compat` (same idea as the GitLab Duo example), then reshapes the request for Codex-style relays.

## Request shape

Relative to plain Platform Responses, the stream:

- keeps `store: false` and drops fields Codex upstreams often reject (`prompt_cache_retention`, `max_output_tokens`, …)
- prefers system text as `instructions` with `input` for conversation items
- sets `text.verbosity`, `parallel_tool_calls`, `tool_choice: auto`
- includes `reasoning.encrypted_content` when applicable
- uses relay Bearer `sk-…` auth (not ChatGPT OAuth JWT)
- hits `{baseUrl}/responses` via the OpenAI Responses client
- sets `originator: codex` and hyphenated `session-id` when a session id is present
- uses `compat.sessionAffinityFormat: "openai-nosession"` and `supportsLongCacheRetention: false`

## Usage

```text
/router          Browse relays
/router add      Add a relay
/router reload   Re-register from disk
/router <id>     Open a relay
```

### Add flow

1. **Name** — provider id (for example `my-relay`); appears as `my-relay/gpt-5.6-sol` in `/model`
2. **Base URL** — usually ends with `/v1`
3. **API key** — literal `sk-…` or `$ENV_VAR`
4. **Fetch models** — `GET {baseUrl}/models`
5. **Select** — Space toggle, Ctrl+S save (TUI)

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

Relay editor → **Models** → **Customize models**:

- **Display name** — optional label (for example `Luna`). Leave empty to show the id.
- **Thinking levels** — toggle each Pi level between **on** and **hidden** (`null`).

Save the relay afterward.

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

## Files

| File | Role |
|---|---|
| `index.ts` | Async factory: load config, register providers, `/router` |
| `store.ts` | `router.json` read/write |
| `register.ts` | `registerProvider` / unregister |
| `stream.ts` | Wraps `openAIResponsesApi` + payload reshape |
| `probe.ts` | `GET …/models` |
| `presets.ts` | 272k defaults + thinking map helpers |
| `dialog.ts` / `ui.ts` | TUI flows |

## Subagents

Registration uses the **config form** of `registerProvider` (not a native `createProvider` object), so the parent session’s `subagent` extension can replay providers into worker runtimes.

## Limits

- SSE only (no Codex WebSocket / zstd request body).
- Catalog probe expects OpenAI-style `{ data: [{ id }] }`.
- Empty model list → provider is not registered (nothing to select in `/model`).

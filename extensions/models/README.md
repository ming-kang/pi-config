# `models` — manage custom providers in `~/.pi/agent/models.json`

Replaces hand-editing the JSON file with a single-screen, menu-driven UI.
Adds, lists, edits, removes, reloads, and probes custom model providers
without leaving Pi.

## Commands

| Command | What it does |
|---|---|
| `/models` | Open the custom-provider list. Pick one to act on, or `+ Add new provider`. |
| `/models add` | Open an empty provider form. |
| `/models list` | Same as no-arg `/models`. |
| `/models edit <name>` | Open the provider form pre-filled with the existing entry. |
| `/models remove <name>` | Confirm, then delete the provider from `models.json`. |
| `/models reload` | Re-read `models.json` and update Pi's model registry without restarting. |
| `/models probe <name>` | Fetch `/v1/models` from the provider's base URL, multi-select which to register. |

Argument completion after `/models ` offers `add | list | edit | remove | reload | probe`.

## UI model

Single-screen menus, not linear wizards. All fields visible at once:

```
Custom Models                  ~/.pi/agent/models.json
─────────────────────────────────────────────────────
  CPA               anthropic-messages · 1 model
  openrouter        openai-completions  · 3 models
+ Add new provider
─────────────────────────────────────────────────────
↑↓ navigate · Enter open · Esc back
```

Provider form:

```
Provider · CPA                            [unsaved]
─────────────────────────────────────────────
▶ Provider ID       CPA
  API               Anthropic Messages
  Base URL          http://127.0.0.1:8317
  API Key           sk-c…piapi (16 chars)
  Headers           User-Agent: WindowsTerminal
  Models            1 model
  ─────────────────────────────────────────
  Discard changes
  Save & close
─────────────────────────────────────────────
↑↓ navigate · Enter/Space change · Esc cancel (discards changes)
```

Fields:
- **Provider ID** — letters/digits/`_`/`-`. Used as `<id>/<model>` in `/model`.
- **API** — pick from `OpenAI-compatible / OpenAI Responses / Anthropic Messages / Google Generative AI`.
- **Base URL** — full endpoint. Placeholder updates per API choice.
- **API Key** — saved verbatim into `models.json`. Literal (`sk-…`), `$ENV_VAR`, or `!command` — your choice.
- **Headers** — sub-editor with `+ Add header`, edit-in-place, backspace to delete.
- **Models** — sub-editor with `+ Add model`, edit-in-place, backspace to remove.

Press `Esc` to save (the common case) or pick `Discard changes` to cancel.

## Probe flow

`/models probe <name>` (or `Edit → Probe for new models`) hits `<baseUrl>/models`
and shows a checklist of model ids found there:

```
Probe results: openrouter
─────────────────────────────────────────────
  [x] anthropic/claude-3.5-sonnet
  [x] openai/gpt-4o
  [ ] meta-llama/llama-3.1-70b
─────────────────────────────────────────────
3/5 selected · Space toggle · Enter add selected · Esc cancel
```

Selected models are appended to the provider with sensible defaults
(text input, no reasoning). Edit the entry afterwards to refine.

Supported probe endpoints:
- OpenAI-compatible (`<baseUrl>/models`, Bearer auth).
- Ollama native fallback (port `:11434`) — `<baseUrl>/../api/tags`, no auth.
- Google Generative AI (`<baseUrl>/models?key=<key>`).
- Anthropic — no public list endpoint, falls back to manual entry.

5 second timeout. Failures are silent — the wizard simply returns to manual entry.

## Persistence

- Writes go straight to `~/.pi/agent/models.json` via atomic temp+rename.
- Pi's model registry refreshes automatically after each write; `/model` sees new
  providers/models without restart.
- Hand-edited fields the wizard doesn't model (`compat`, `thinkingLevelMap`,
  `oauth`, `modelOverrides`, …) are preserved untouched across wizard edits.

## What this extension does NOT do

- **`compat` flags** — there are ~25 of them across two APIs and most are
  provider-specific. Edit `~/.pi/agent/models.json` by hand for these.
- **`thinkingLevelMap`** — same reasoning. Hand-edit.
- **OAuth flows** — the API Key field is literal text only. For providers that
  require OAuth (Anthropic built-in, OpenAI Codex), use `/login <provider>`.
- **Overriding built-in providers** (e.g. set `anthropic.baseUrl` to a proxy).
  Edit `models.json` directly — the merge semantics are documented at
  `references/pi/packages/coding-agent/docs/models.md`.

## Files

- `index.ts` — command registration and dispatch.
- `constants.ts` — labels, API choice list, validation helpers.
- `store.ts` — atomic read/write of `models.json`.
- `probe.ts` — `/v1/models` fetcher for the three supported APIs.
- `dialog.ts` — top-level menus + sub-editor factories (Input prompt, Confirm, Probe checklist).
- `models-form.ts` — provider/model/headers form primitives (single-screen, menu-driven).
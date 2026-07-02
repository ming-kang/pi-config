# Fast Context

Fast Context is a Pi-native semantic code retrieval tool bundled in this `pi-config` package. It takes a task-level search query and a compact map of the current project, asks Devin's Fast Context backend to plan a small search, then executes that search locally to return relevant files and line ranges.

[Devin's docs](https://docs.devin.ai/desktop/context-awareness/fast-context) describe Fast Context as a specialized subagent powered by the `SWE-grep` model family. This extension uses the same reverse-engineered protocol surface, but stays Pi-native around it and does not expose model selection as a normal user workflow.

Unlike local-only grep, Fast Context understands intent: "where is authentication handled?" can return handlers, middleware, session code, and relevant call sites even when they do not share one exact token. Results are deliberately lightweight: candidate file paths, line ranges, and grep keywords. Pi should then use `read` and `grep` for exact code and evidence.

Fast Context sends your query and a hotspot repo map to Devin's hosted code-search backend over a reverse-engineered protocol; the backend plans a sequence of restricted search commands; this extension runs those commands locally. You bring your own Devin API key. Because the integration is unofficial, the backend can change or break it at any time without notice. Not affiliated with or endorsed by Pi or Devin.

Apart from that backend planning call, execution stays local: it reuses Pi's built-in ripgrep, respects `.gitignore`, ranks likely hotspot directories locally, and runs all path operations in a strict sandbox.

## Installation & Update

Fast Context is installed as part of `pi-config`:

```bash
pi install git:github.com/ming-kang/pi-config
# or from a local checkout during development:
pi install ./pi-config
```

Update the whole package:

```bash
pi update --extensions
pi update git:github.com/ming-kang/pi-config
```

## Configuring your API key

Run `/fast-context` to open the key configuration dialog:

- The dialog title shows whether a key is configured.
- Enter your API key and submit to save it.
- Submit empty to delete a saved key.
- Press Escape to cancel.

The key is stored persistently in `~/.pi/agent/pi-config/fast-context/config.json`, loaded on startup, and never passed to the model or written to session logs.

For headless/CI environments, set the `FAST_CONTEXT_KEY` environment variable instead. If not set, the tool will use the saved key from `config.json`.

Fast Context intentionally has no automatic credential discovery. Users configure a key manually through `/fast-context` or `FAST_CONTEXT_KEY`; the extension never reads Devin/Windsurf SQLite databases, IDE state, CLI credentials, or other local apps to recover a key.

Current Devin tokens look like `devin-session-token$<JWT>`. If you set that value through a shell or config file, quote or escape the `$`; otherwise variable expansion can silently truncate the key. Fast Context warns when it detects that shape, but it still does not attempt to recover the key automatically.

## Usage

Once you have set your key, Pi can call Fast Context when it needs a fast starting context for unfamiliar local code. Users do not normally call this tool by hand.

Good use cases:

- Understanding a large or unfamiliar repo before implementing a feature
- Finding where a cross-module behavior lives, such as auth, session restore, tool rendering, or config loading
- Tracing a bug flow when the relevant files are unknown
- Getting an initial reading list for architecture exploration or refactor planning

Poor use cases:

- Exact symbols, filenames, literals, or known paths: use `grep`, `find`, or `read`
- Small known scopes where local tools are faster
- Freshness-sensitive external facts: this only searches the local checkout
- Proof that something exists or does not exist: verify with local `grep` / `read`

Write queries as short natural-language problem statements, preferably in English, with domain terms when useful. Results include paths, line ranges, and grep keywords only. Treat returned files as candidate context, not proof.

In the TUI, you will see real-time progress: authentication, building the repo map, and each planning/execution round. Results display collapsed by default, showing file count and grep keywords, and expand to show the full result envelope.

### Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | required | Natural-language code retrieval query. Prefer English plus local domain terms; avoid bare exact symbols |
| `project_path` | string | cwd | Optional package/subtree to search within; must resolve inside cwd |
| `tree_depth` | int 0-6 | 3 | Repo-map depth. `0` chooses automatically from project size |
| `max_turns` | int 1-5 | 3 | Search rounds. Use 1-2 for quick orientation, 3 normally, 4-5 only for complex cross-module flows |
| `max_results` | int 1-30 | 10 | Maximum files to return. Use 3-8 for focused implementation work |
| `exclude_paths` | string[] | [] | Extra directories/files to exclude from the repo map and hotspot scoring, on top of defaults and simple `.gitignore` dirs |

## Security and Guarantees

The remote model plans commands, but execution is sandboxed locally. All security guarantees are enforced by this extension:

- **Path containment:** Every command path (`rg`, `readfile`, `tree`, `ls`, `glob`) is checked via `PathSandbox.toReal()` to ensure it stays within the current working directory. Checks are performed both on literal `..` sequences and after symlink resolution.
- **`project_path` is constrained:** It must resolve within cwd; searches cannot escape the working directory.
- **Key storage:** Saved only to `~/.pi/agent/pi-config/fast-context/config.json` with mode `0600`; never logged in session transcripts or passed as a tool parameter.
- **No local credential extraction:** The extension does not read IDE databases, CLI credentials, or other local app state to recover a key.
- **TLS not downgraded:** Network errors never trigger a fallback to insecure TLS modes.
- **Respects `.gitignore`:** The Pi grep backend is gitignore-aware; the repo map also merges simple ignore patterns.

## Known Trade-offs

- **Remote-dependent:** Each search involves multiple network rounds. Quality depends on the repo map and backend model decisions.
- **Semantic, not exact:** Fast Context can return near matches for symbol-like queries. Use local `grep` for exact existence, definitions, and literal strings.
- **Hotspot repo map:** The default map sends a shallow whole-repo tree plus deeper subtrees for locally ranked hotspot directories. Set `FC_REPO_MAP_MODE=classic` to use the older adaptive flat tree.
- **Grep keywords are hints:** Returned keywords are useful follow-up searches, not proof that a file is relevant.
- **Lightweight results:** The tool returns pointers, not code. Use Pi's `read` tool for selected ranges.

## Environment Variables

| Variable | Default | Description |
|:-:|---|---|
| `FAST_CONTEXT_KEY` | - | API key at startup, useful for headless/CI |
| `WS_MODEL` | `MODEL_SWE_1_6_FAST` | Backend protocol model id escape hatch. Leave unset unless the upstream protocol changes or you are debugging the wire |
| `WS_APP_VER` | `1.48.2` | Devin/Windsurf protocol metadata: app version |
| `WS_LS_VER` | `1.9544.35` | Devin/Windsurf protocol metadata: language server version |
| `FC_MAX_COMMANDS` | `8` | Max parallel commands per round |
| `FC_TIMEOUT_MS` | `30000` | Stream request timeout in ms |
| `FC_RESULT_MAX_LINES` | `50` | Max lines per command output |
| `FC_LINE_MAX_CHARS` | `250` | Max chars per line |
| `FC_REPO_MAP_MODE` | `hotspot` | `hotspot` for shallow base + ranked subtrees, or `classic` for the old flat adaptive tree |
| `FC_HOTSPOT_BASE_DEPTH` | `1` | Depth of the shallow whole-repo tree in hotspot mode |
| `FC_HOTSPOT_TOP_K` | `4` | Preferred number of hotspot directories to drill into |
| `FC_HOTSPOT_TREE_DEPTH` | `2` | Depth of each hotspot subtree |
| `FC_HOTSPOT_MAX_BYTES` | `122880` | Byte budget for the assembled hotspot repo map |

## Architecture

```text
extensions/fast-context/
  index.ts              Extension entry: register tool, command, hooks
  constants.ts          Tool/command names, copy text
  schema.ts             Parameter schema (typebox)
  state.ts              Key state: load/save, in-memory cache
  storage.ts            Persist key to ~/.pi/agent/pi-config/fast-context/config.json
  commands.ts           /fast-context command for setting/clearing key
  execute.ts            Pi-side orchestration: project_path scope, result envelope
  render.ts             Tool render: call, partial, collapsed, expanded states
  render-format.ts      Fast Context-specific collapsed summary and envelope coloring
  grep-backend.ts       Pi grep wrapper, reusing Pi's ripgrep
  search.ts             Search loop and lightweight result formatting
  repo-map.ts           Classic/hotspot repo-map assembly
  directory-scorer.ts   Local hotspot scoring with an injected grep probe
  executor.ts           Restricted command execution, every path sandboxed
  tree.ts               Native directory-tree renderer
  excludes.ts           Canonical noise-dir list shared by tree + scorer
  sandbox.ts            Path containment security core
  client.ts             Auth, JWT, metadata, streaming, parsing
  protocol.ts           Protobuf encoding/decoding, Connect-RPC framing
```

Zero runtime dependencies: all peer dependencies resolve to Pi's bundled versions. File I/O uses `node:fs`; compression uses `node:zlib`; rendering primitives come from `../tools-view/shared.ts`.

## Verification

Run the focused pure selftests after touching the related area:

```bash
node extensions/fast-context/sandbox.selftest.ts
node extensions/fast-context/executor.selftest.ts
node extensions/fast-context/protocol.selftest.ts
node extensions/fast-context/directory-scorer.selftest.ts
node extensions/fast-context/repo-map.selftest.ts
node extensions/fast-context/key-format.selftest.ts
```

Changes in `client.ts` or `protocol.ts` also require a live search and `<ANSWER>` round-trip with a real key; selftests do not validate the wire.

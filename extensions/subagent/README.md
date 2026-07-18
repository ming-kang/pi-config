# subagent — background Pi workers

Adds a model-callable `subagent` tool backed by isolated in-memory Pi `AgentSession` instances. Workers run in the background, surface in a persistent footer widget with live progress, stream into a keyboard-driven manager overlay, and send a bounded completion message back to the parent conversation.

The interaction model follows Claude Code's background-agent UX as closely as Pi's public extension API allows, with some ideas borrowed from Grok Build's unified tasks pane (running-first ordering, single-key stop, auto-appearing list).

## Built-in profiles and inheritance

The built-in profiles are:

| Profile | Behavior | Default tools |
|---|---|---|
| `general` | General implementation worker; may edit files | Pi defaults (`read`, `bash`, `edit`, `write`) |
| `explorer` | Read-only codebase reconnaissance | `read`, `grep`, `find`, `ls` |

Model and thinking resolution is deterministic:

1. Explicit values on the individual `spawn` task.
2. Saved profile overrides configured through `/agents settings`.
3. `model` / `thinkingLevel` in a Markdown agent definition.
4. `inherit`: the parent session's current model and thinking level at spawn time.

Built-in profiles have no fixed model or thinking level, so their untouched default is `inherit`. Explicitly selecting `inherit` in `/agents settings` also overrides a Markdown agent's fixed setting.

`/agents settings [profile]` opens the profile settings menu. It can save an explicit model, an explicit thinking level, force either field to `inherit`, or clear the saved override and return to the agent definition. Settings are stored outside the repo at `~/.pi/agent/pi-config/subagent.json`; no credentials are written. Preferences are keyed by profile name only, so a user-level and a project-level definition with the same name share one saved override. `/agents limits` configures session-local concurrency/retention, and `/agents clear [id|all]` disposes terminal records.

## Background control tool

The `subagent` tool exposes these actions:

| Action | Purpose |
|---|---|
| `spawn` | Enqueue one `task` or a `tasks` batch and return stable ids immediately |
| `read` | Without `id`, list retained workers; with `id`, return one bounded snapshot |
| `send` | Attach to queued work, steer/follow up a running worker, continue a completed conversation, or fresh-rerun with `fresh: true`; failed/stopped workers rerun fresh automatically |
| `stop` | Abort a running worker or remove a queued worker |

`spawn` accepts `agent`, `model`, `thinkingLevel`, `tools`, `cwd`, and `label` per task, plus optional spawn-level `maxConcurrency` / `maxAgents` overrides. Use `model: "inherit"` or `thinkingLevel: "inherit"` to force the parent setting for that invocation. An explicit empty `tools` list creates a model-only worker with no tools. The default limits are 3 concurrent and 16 retained agents; hard limits are 8 and 32. Excess tasks remain queued and start automatically when a slot opens. Before a spawn fails at `maxAgents`, the controller automatically reclaims the oldest eligible terminal records, preferring viewed successful/stopped work and protecting active workers, unsettled batch members, and unread failures.

## TUI

Two surfaces, no redundancy: the footer widget is the passive live list, and one focused transcript overlay is where all interaction happens. The design goal is a minimal key set — inside the overlay only universal keys apply (Enter, Esc, Tab, arrows, ctrl+c), and the hint line teaches exactly the keys that are currently usable.

### Footer widget (always visible while workers exist)

A below-editor widget appears automatically on the first spawn and disappears when the last record is cleared. Rows keep a stable order — pending/active workers first, finished ones sink below, spawn order within each group — so a row moves at most once, when it finishes, and never trades places because a neighbor produced output more recently. The panel's Tab cycle uses the same order. Each row shows a pulse spinner (running), status icon, id, label, agent profile, a semantic current activity such as `Reading code` or `Running verification` (wide terminals), and right-aligned `elapsed · ↓ tokens`. Completed-but-unviewed workers carry a `*` mark. The spinner and elapsed times animate only while a worker is active. At most 5 rows are shown, with a `… +N more (/agents)` overflow line. Until the panel is opened for the first time in a session, a one-time `/agents to view` onboarding line is appended; it disappears the moment the panel is first opened.

The footer widget is the single source of live status, so the extension no longer publishes a separate `ctx.ui.setStatus()` summary into the bundled `statusline` extension — that slot is intentionally left empty pending a future redesign.

### Transcript overlay

- `/agents` opens the most relevant worker (unread first, then running, then most recently updated); `/agents <id>` targets a specific worker, and an unknown id shows a one-line usage hint. Arguments tab-complete worker ids and the `settings`, `limits`, and `clear` subcommands (including profiles/terminal ids where applicable). The extension registers no global shortcuts. The collapsed spawn result in the main transcript also names `/agents`.
- `Tab` cycles between workers (`shift+Tab` reverses); the hint line shows `Tab next (n/total)` whenever more than one worker exists.
- `↑`/`↓` scroll by line, `PgUp`/`PgDn` by half page, `Home`/`End` jump to top/tail. The view follows the tail until scrolled, then shows `▾ N newer lines · End to follow`. Mouse wheel scrolling cannot work here: Pi renders into the normal terminal screen without mouse tracking, so the wheel always scrolls the terminal's own scrollback.
- The header is one line (status, label, id, state) plus a metadata line (profile, model, elapsed, tool uses, tokens, cost) that is dropped on short terminals. While running, a live status line above the input shows the current tool activity, including `Thinking...` while a reasoning model works pre-response and explicit retry start/end transitions.
- Tool events render as a bounded `Activity` section with status icons and compact semantic rows such as `Read controller.ts`, `Search "completionGroup"`, `Edit schema.ts · 2 changes`, and `Run git diff --check`; short result summaries appear beneath the corresponding row. User instructions, retry/compaction notices, and errors remain in the chronological conversation updates.
- A terminal worker renders its latest assistant answer separately under `Result` as Markdown with the same theme as the main session (headings, code blocks with syntax highlighting, lists, inline code), reusing Pi's `Markdown` component and `getMarkdownTheme()`. The streaming tail stays plain text until the message completes, since half-written fences and tables re-render unstably. Extremely large panel results are bounded with an explicit omission notice; model-facing completion and `read` retain their smaller documented budgets.
- `ctrl+c` follows terminal convention: it stops the worker being viewed if it is active, and closes the overlay otherwise. `Esc` always closes.

The overlay picks its geometry from the terminal size at open time: near-full width below 100 columns, 62% up to 170 columns, and a fixed 104 columns on wider terminals so transcript lines stay readable; percent-based sizes keep tracking live resizes.

### Instruction input

The input line is always focused, and Enter always performs the single action the mode label announces:

| State | Mode label | Enter behavior |
|---|---|---|
| running | `[send]` | delivered to the worker after its current tool batch |
| queued/starting | `[on start]` | attaches the message before the run starts |
| completed | `[continue]` | continues the existing conversation |
| failed/stopped | `[rerun]` | reruns fresh — empty input repeats the task, typed text replaces it |

Pressing Enter with an empty input (outside `[rerun]`) shows a short explanation instead of doing nothing. Steer-vs-follow-up delivery is a model-side concept only (`send` action `delivery`); the human UI always steers. Human housekeeping uses `/agents clear [id|all]` and `/agents limits` rather than model tool actions.

### Main-transcript rendering

Tool calls use a compact private renderer because Pi's generic custom-tool fallback prints the entire retained snapshot. Collapsed results show the CC stats phrasing (`sa-01 completed · label · 5 tool uses · ↓12.3k tokens`); `ctrl+o` expands the full model-visible result.

Pi's public extension Component API exposes keyboard focus for overlays and passive widgets but no mouse events or footer hit-testing, so the widget is informational and the transcript lives in a focused overlay rather than a split pane.

## Agent definitions

In addition to the built-ins, the extension discovers Markdown definitions from:

- `~/.pi/agent/agents/*.md` (`agentScope: "user"`, the default)
- the nearest `.pi/agents/*.md` (`agentScope: "project"` or `"both"`)

Format:

```markdown
---
name: scout
description: Fast read-only repository reconnaissance
tools: read, grep, find, ls
model: provider/model-id
thinkingLevel: low
---

Additional system instructions for this profile.
```

Project-local definitions are repository-controlled prompts. Interactive calls confirm before executing them by default; without an interactive UI the tool returns `no_ui` unless the caller explicitly sets `confirmProjectAgents: false` for a trusted repository.

## Completion and lifecycle

Each worker uses `SessionManager.inMemory()` and disables child extension loading, preventing recursive `subagent` registration. All workers share one extension-owned `ModelRuntime` (created lazily on the first spawn, which may add a one-time model-catalog refresh). Before each spawn, provider configurations dynamically registered in the parent session (`pi.registerProvider`) are replayed into that runtime, and parent-side unregistrations are mirrored, so custom/proxy models stay usable inside workers. Two limitations: providers registered as native pi-ai `Provider` objects are not exposed for replay by the current API surface, and runtime-only api keys injected via `setRuntimeApiKey` exist solely in the parent runtime's memory — such providers fall back to on-disk auth. Workers inherit user settings: the resource loader and the session share one `SettingsManager.create(cwd)` per working directory (read-only use), so retry and compaction behavior follow your configuration; skills stay enabled. A single spawn sends its completion or failure to the parent with `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`; workers spawned in one batch retain independent ids but produce one combined parent follow-up after every initial member settles. Completion messages are capped at 24,000 characters. The raw custom message is hidden from the transcript to avoid duplicating the parent model's user-facing summary; the TUI notification and queued parent turn remain. `read` is capped at 32,000 characters; the live in-memory timeline is also bounded.

Active workers are session-process resources. `/reload`, `/new`, `/resume`, and session shutdown abort and dispose them. `/tree` navigation keeps them alive at the session level, so a later completion is delivered to whichever branch is active then. Workers share their requested cwd; do not assign overlapping edits unless they are deliberately coordinated. Worktree isolation is not currently implemented.

## Files

- `index.ts` — tool/command registration and lifecycle hooks
- `controller.ts` — scheduling, AgentSession lifecycle, parent notifications, tool actions, and widget lifecycle
- `activity.ts` — semantic, bounded summaries for tool calls and results
- `panel.ts` — manager overlay: activity/conversation/result view with the state-aware instruction input
- `widget.ts` — persistent below-editor live worker list
- `render.ts` — compact tool call/result UI with Ctrl+O expansion
- `format.ts` — shared spinner frames, status icons, duration/token/stat formatting
- `agents.ts` — built-in profiles and Markdown discovery
- `config.ts` — user profile model/thinking preferences
- `schema.ts` / `types.ts` / `constants.ts` — model-facing contract and local types/defaults

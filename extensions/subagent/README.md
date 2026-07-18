# subagent — background Pi workers

Adds a model-callable `subagent` tool backed by isolated in-memory Pi
`AgentSession` instances. Workers run in the background, surface in a
persistent footer widget with live progress, stream into a keyboard-driven
manager overlay, and send a bounded completion message back to the parent
conversation.

The interaction model follows Claude Code's background-agent UX as closely as
Pi's public extension API allows, with some ideas borrowed from Grok Build's
unified tasks pane (running-first ordering, single-key stop, auto-appearing
list).

## Built-in profiles and inheritance

The built-in profiles are:

| Profile | Behavior | Default tools |
|---|---|---|
| `general` | General implementation worker; may edit files | Pi defaults (`read`, `bash`, `edit`, `write`) |
| `explorer` | Read-only codebase reconnaissance | `read`, `grep`, `find`, `ls` |
| `planner` | Read-only implementation planning | `read`, `grep`, `find`, `ls` |
| `reviewer` | Read-only correctness/regression review | `read`, `grep`, `find`, `ls` |

Model and thinking resolution is deterministic:

1. Explicit values on the individual `spawn` task.
2. Saved profile overrides configured through `/subagent`.
3. `model` / `thinkingLevel` in a Markdown agent definition.
4. `inherit`: the parent session's current model and thinking level at spawn
   time.

Built-in profiles have no fixed model or thinking level, so their untouched
default is `inherit`. Explicitly selecting `inherit` in `/subagent` also
overrides a Markdown agent's fixed setting.

`/subagent [profile]` opens the settings menu. It can save an explicit model,
an explicit thinking level, force either field to `inherit`, or clear the saved
override and return to the agent definition. Settings are stored outside the
repo at `~/.pi/agent/pi-config/subagent.json`; no credentials are written.

## Background control tool

The `subagent` tool exposes these actions:

| Action | Purpose |
|---|---|
| `spawn` | Enqueue one `task` or a `tasks` batch and return stable ids immediately |
| `list` | Show running, queued, and retained terminal workers |
| `read` | Return a bounded retained snapshot for one id |
| `send` | `steer` a running worker, queue a `followUp`, or continue a completed conversation |
| `restart` | Start the same id with a fresh isolated context |
| `stop` | Abort a running worker or remove a queued worker |
| `clear` | Dispose and remove terminal records |
| `configure` | Set session-local `maxConcurrency` and/or `maxAgents` |

`spawn` accepts `agent`, `model`, `thinkingLevel`, `tools`, `cwd`, `label`,
and `maxTurns` per task. Use `model: "inherit"` or `thinkingLevel: "inherit"`
to force the parent setting for that invocation. An explicit empty `tools`
list creates a model-only worker with no tools. `maxTurns` is a safety cap:
when a run reaches it, the worker is stopped but reported as completed with a
turn-limit note so the parent can decide whether to continue it. The default
limits are 3 concurrent and 16 retained agents; hard limits are 8 and 32.
Excess tasks remain queued and start automatically when a slot opens.

## TUI

Two surfaces, no redundancy: the footer widget is the passive live list, and
one focused transcript overlay is where all interaction happens.

### Footer widget (always visible while workers exist)

A below-editor widget appears automatically on the first spawn and disappears
when the last record is cleared. Each row shows a pulse spinner (running),
status icon, id, label, agent profile, the current tool activity (wide
terminals), and right-aligned `elapsed · ↓ tokens`. Completed-but-unviewed
workers carry a `*` mark. The spinner and elapsed times animate only while a
worker is active. At most 5 rows are shown, with a `… +N more (alt+o)`
overflow line.

`ctx.ui.setStatus()` still publishes a compact `N running · M queued · K done`
summary so the bundled `statusline` extension shows counts without a
cross-extension import.

### Transcript overlay

- `alt+o` opens the most relevant worker (unread first, then running, then
  most recently updated). `/subagents [id]` and `ctrl+alt+a` do the same,
  optionally targeting an id. The collapsed spawn result in the main
  transcript also names `alt+o`.
- `Tab` / `shift+Tab` cycle between workers; the header shows `n/total ⇥`.
- `↑`/`↓` scroll by line, `PgUp`/`PgDn` by half page. The view follows the
  tail until scrolled, then shows `▾ N newer lines · ↓/PgDn to follow`.
  Mouse wheel scrolling cannot work here: Pi renders into the normal
  terminal screen without mouse tracking, so the wheel always scrolls the
  terminal's own scrollback.
- The header is two lines: status icon/spinner, label, id, status, position;
  then agent profile, model, elapsed, tool uses, tokens, cost. While running,
  a live status line above the input shows the current tool activity.
- `Esc` or `ctrl+c` closes the overlay.

### Instruction input

The input line is always focused and its mode follows the worker state:

| State | Mode label | Enter behavior |
|---|---|---|
| running | `[steer]` / `[follow-up]` (toggle with `ctrl+t`) | steer delivers after the current tool batch; follow-up waits until work settles |
| queued/starting | `[on start]` | attaches the message before the run starts |
| completed | `[continue]` | continues the existing conversation |
| failed/stopped | `[restart]` | restarts fresh; the input becomes the new task |

`ctrl+enter` is a shortcut for an immediate follow-up on terminals that can
distinguish it; `ctrl+t` works everywhere. `ctrl+r` restarts and `ctrl+x`
stops the worker being viewed. Clearing finished records is a model-side
action (`subagent` action `clear`).

### Main-transcript rendering

Tool calls use a compact private renderer because Pi's generic custom-tool
fallback prints the entire retained snapshot. Collapsed results show the CC
stats phrasing (`sa-01 completed · label · 5 tool uses · ↓12.3k tokens`);
`ctrl+o` expands the full model-visible result.

Pi's public extension Component API exposes keyboard focus for overlays and
passive widgets but no mouse events or footer hit-testing, so the widget is
informational and the transcript lives in a focused overlay rather than a
split pane.

## Agent definitions

In addition to the built-ins, the extension discovers Markdown definitions
from:

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

Project-local definitions are repository-controlled prompts. Interactive calls
confirm before executing them by default; without an interactive UI the tool
returns `no_ui` unless the caller explicitly sets
`confirmProjectAgents: false` for a trusted repository.

## Completion and lifecycle

Each worker uses `SessionManager.inMemory()` and disables child extension
loading, preventing recursive `subagent` registration. It reuses the parent
model registry so runtime credentials and custom model registrations remain
available. Completion or failure is
sent to the parent with `pi.sendMessage(..., { triggerTurn: true, deliverAs:
"followUp" })`, capped at 24,000 characters. The raw custom message is hidden
from the transcript to avoid duplicating the parent model's user-facing
summary; the TUI notification and queued parent turn remain. `read` is capped
at 32,000 characters; the live in-memory timeline is also bounded.

Active workers are session-process resources. `/reload`, `/new`, `/resume`, and
session shutdown abort and dispose them. `/tree` navigation keeps them alive at
the session level, so a later completion is delivered to whichever branch is
active then. Workers share their requested cwd; do not assign overlapping edits
unless they are deliberately coordinated. Worktree isolation is not currently
implemented.

## Files

- `index.ts` — tool/command/shortcut registration and lifecycle hooks
- `controller.ts` — scheduling, AgentSession lifecycle, parent notifications,
  tool actions, and widget lifecycle
- `panel.ts` — manager overlay: list view and transcript view with the
  state-aware instruction input
- `widget.ts` — persistent below-editor live worker list
- `render.ts` — compact tool call/result UI with Ctrl+O expansion
- `format.ts` — shared spinner frames, status icons, duration/token/stat
  formatting
- `agents.ts` — built-in profiles and Markdown discovery
- `config.ts` — user profile model/thinking preferences
- `schema.ts` / `types.ts` / `constants.ts` — model-facing contract and local
  types/defaults

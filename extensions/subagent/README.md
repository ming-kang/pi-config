# subagent — background Pi workers

Adds a model-callable `subagent` tool backed by isolated in-memory Pi
`AgentSession` instances. Workers run in the background, appear in the package
statusline, stream into a right-side TUI overlay, and send a bounded completion
message back to the parent conversation.

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

`spawn` accepts `agent`, `model`, `thinkingLevel`, `tools`, `cwd`, and `label`
per task. Use `model: "inherit"` or `thinkingLevel: "inherit"` to force the
parent setting for that invocation. An explicit empty `tools` list creates a
model-only worker with no tools. The default limits are 3 concurrent and 16
retained agents; hard limits are 8 and 32. Excess tasks remain queued and start
automatically when a slot opens.

## TUI

- Status is published with `ctx.ui.setStatus()`, so the bundled `statusline`
  shows running, queued, and unread-completion counts without a cross-extension
  import.
- Tool calls use a compact private renderer because Pi's generic custom-tool
  fallback prints the entire retained snapshot. `Ctrl+O` expands the full
  model-visible result on demand.
- `/subagents [id]` or `Ctrl+Alt+A` opens the manager. The shortcut avoids
  `Ctrl+Shift+A`, which Windows Terminal commonly reserves for Select All.
- Arrow keys select a worker; Enter opens its transcript.
- In the detail view, Enter sends a steering instruction and Ctrl+Enter queues
  a follow-up. PageUp/PageDown scroll, Ctrl+R restarts, Ctrl+X stops, Escape
  returns to the list, and Ctrl+C closes the overlay.
- The panel is anchored at `top-right` and capped at 72% terminal height so the
  parent editor and statusline remain visible. It uses the active Pi theme and
  updates while workers stream tool activity and assistant text.

Pi's public extension Component API currently exposes keyboard focus but no
mouse events or footer hit-testing. The statusline therefore cannot be clicked,
and the panel is an experimental overlay rather than a permanent split pane.

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
  and tool actions
- `panel.ts` — keyboard-focused right-side manager and transcript input
- `render.ts` — compact tool call/result UI with Ctrl+O expansion
- `agents.ts` — built-in profiles and Markdown discovery
- `config.ts` — user profile model/thinking preferences
- `schema.ts` / `types.ts` / `constants.ts` — model-facing contract and local
  types/defaults

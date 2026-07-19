# subagent — background Pi workers

Adds a model-callable `subagent` tool backed by isolated in-memory Pi `AgentSession` instances. Workers run in the background, announce with a readable statusline chip, stream into `/agents` side panel, and send a bounded completion follow-up to the parent.

Background by default needs no user intervention: no footer list, no idle animation.

**Security note:** workers share the parent process credentials and OS permissions. Tool allowlists and cwd bounds reduce accidents; they are **not** a sandbox. For untrusted repositories, run Pi inside a container (see Pi's security docs).

## Built-in profiles and inheritance

| Profile | Behavior | Default tools | Defaults |
|---|---|---|---|
| `general` | General implementation worker; may edit files | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` | model/thinking inherit |
| `explorer` | Read-only codebase reconnaissance | `read`, `grep`, `find`, `ls` (no bash) | thinking `low`; no AGENTS.md injection |

Tool capability comes **only** from the profile (or Markdown definition). The model cannot pass a `tools` override to escalate privileges.

Model and thinking resolution is deterministic:

1. Explicit values on the individual `spawn` task.
2. Saved profile overrides configured through `/agents settings`.
3. `model` / `thinkingLevel` in a Markdown agent definition.
4. `inherit`: the parent session's current model and thinking level at spawn time.

Built-in `general` has no fixed model/thinking, so its untouched default is `inherit`. `explorer` defaults thinking to `low` unless overridden. Explicitly selecting `inherit` in `/agents settings` also overrides a Markdown agent's fixed setting.

`/agents settings [profile]` opens the profile settings menu. It can save an explicit model, an explicit thinking level, force either field to `inherit`, or clear the saved override and return to the agent definition. Settings are stored outside the repo at `~/.pi/agent/pi-config/subagent.json`; no credentials are written. Preferences are keyed by profile name only, so a user-level and a project-level definition with the same name share one saved override. `/agents limits` configures session-local concurrency/retention, and `/agents clear [id|all]` disposes terminal records.

## Background control tool

The `subagent` tool exposes these actions:

| Action | Purpose |
|---|---|
| `spawn` | Enqueue one `task` or a `tasks` batch and return stable ids immediately |
| `read` | Without `id`, compact list; with `id`, bounded result snapshot (not full transcript) |
| `send` | Attach to queued work, steer a running worker, continue a completed conversation, or fresh-rerun with `fresh: true`; failed/stopped workers rerun fresh automatically |
| `stop` | Abort a running worker or remove a queued worker (**notifies the parent** with any partial output) |

### Model-facing spawn fields

| Field | Notes |
|---|---|
| `task` / `tasks` | Required (exactly one form). Brief the worker fully — it has no parent conversation context. |
| `agent` | Profile name; default `general`. Use `explorer` for read-only recon. |
| `label` | Short 3–8 word summary for TUI/notifications (strongly recommended). |
| `model` / `thinkingLevel` | Optional; prefer omit. `"inherit"` forces the parent setting. |
| `cwd` | Optional path **relative to / under** the parent session cwd (escape outside that tree is rejected). |
| `agentScope` | Default `user`. Use `project`/`both` only when you intentionally need `.pi/agents` definitions (interactive confirm required; cannot be disabled by the model). |

Deployment limits (`maxConcurrency` / `maxAgents`) are **not** tool parameters — use `/agents limits`. Defaults: 3 concurrent, 16 retained (hard caps 8 / 32). Excess tasks queue automatically. Before a spawn fails at `maxAgents`, the controller reclaims the oldest eligible terminal records (protecting active workers, unsettled batch members, and unread failures).

## TUI

Always-on chrome is only a **statusline chip**. Open **`/agents`** for detail (transcript, steer, stop).

### Worker identity

| Layer | Format | Example |
|---|---|---|
| **id** (tool wire) | `a` + 8 hex | `a7c3e91f` |
| **type** (primary UI) | profile | Explorer / General |
| **label** | optional task summary | secondary only |

### Statusline chip

While workers exist, `ctx.ui.setStatus` fills the statusline middle slot (line 2 with the bundled `statusline` extension):

| Chip | Meaning |
|---|---|
| `3 explorer running` | three explorers active |
| `2 running, 1 queued` | mixed activity |
| `2 done, unread` | finished; open `/agents` to review |

No arrow codes. Narrow terminals may drop the middle slot first so CTX/usage stay readable. **No** below-editor multi-line list.

### Transcript overlay

- Geometry: right-center side panel; near-full width only on narrow terminals.
- `/agents` opens the most relevant worker; `/agents <id>` targets one. Tab-complete ids and `settings` / `limits` / `clear`.
- **Order is fixed by spawn time** — finishing does not reorder Tab list.
- `Tab` cycles; multi-worker tab strip is **type-first** with static status glyphs.
- Header: **Explorer** / **General** + short id + status. Meta drops cost/model first when narrow.
- Braille spinner only while panel is open and the selected worker is active; otherwise static glyphs.
- Live activity line shows tool text without an extra spinner.
- Tool events render as a bounded `Activity` section with status icons and compact semantic rows such as `Read controller.ts`, `Search "completionGroup"`, `Edit schema.ts · 2 changes`, and `Run git diff --check`; short result summaries appear beneath the corresponding row. User instructions, retry/compaction notices, and errors remain in the chronological conversation updates.
- A terminal worker renders its latest assistant answer separately under `Result` as Markdown with the same theme as the main session (headings, code blocks with syntax highlighting, lists, inline code), reusing Pi's `Markdown` component and `getMarkdownTheme()`. The streaming tail stays plain text until the message completes, since half-written fences and tables re-render unstably. Extremely large panel results are bounded with an explicit omission notice; model-facing completion and `read` retain their smaller documented budgets.
- `ctrl+c` follows terminal convention: it stops the worker being viewed if it is active, and closes the overlay otherwise. `Esc` always closes.

The overlay picks its geometry from the terminal size at open time: near-full width below 100 columns, 62% up to 170 columns, and a fixed 104 columns on wider terminals so transcript lines stay readable; percent-based sizes keep tracking live resizes.

### Instruction input

The input line is always focused, and Enter always performs the single action the mode label announces:

| State | Mode label | Enter behavior |
|---|---|---|
| running | `[send]` | steered to the worker after its current tool batch |
| queued/starting | `[on start]` | attaches the message before the run starts |
| completed | `[continue]` | continues the existing conversation |
| failed/stopped | `[rerun]` | reruns fresh — empty input repeats the task, typed text replaces it |

Pressing Enter with an empty input (outside `[rerun]`) shows a short explanation instead of doing nothing. Human housekeeping uses `/agents clear [id|all]` and `/agents limits` rather than model tool actions.

### Main-transcript rendering

Tool calls use a compact private renderer. Collapsed results prefer type + status (`a7c3e91f · completed · explorer`); `ctrl+o` expands the full result.

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

Project-local definitions are repository-controlled prompts. Interactive calls **always** confirm before executing them; without an interactive UI the tool returns `no_ui`. The model cannot disable confirmation.

## Completion and lifecycle

Each worker uses `SessionManager.inMemory()` and disables child extension loading, preventing recursive `subagent` registration. Skills and prompt templates are not loaded into workers (smaller prompts, smaller injection surface). All workers share one extension-owned `ModelRuntime` (created lazily on the first spawn, which may add a one-time model-catalog refresh). Before each spawn, provider configurations dynamically registered in the parent session (`pi.registerProvider`) are replayed into that runtime, and parent-side unregistrations are mirrored, so custom/proxy models stay usable inside workers. Two limitations: providers registered as native pi-ai `Provider` objects are not exposed for replay by the current API surface, and runtime-only api keys injected via `setRuntimeApiKey` exist solely in the parent runtime's memory — such providers fall back to on-disk auth. Workers inherit user settings: the resource loader and the session share one `SettingsManager.create(cwd)` per working directory (read-only use), so retry and compaction behavior follow your configuration. Worker system prompts are a slim role role (not the full default pi assistant template); `general` still receives project context files (AGENTS.md / CLAUDE.md), while `explorer` skips them and can read those files on demand.

A single spawn sends its completion, failure, or **stop** to the parent with `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`; workers spawned in one batch retain independent ids but produce one combined parent follow-up after every initial member settles. Completion messages are capped at 16,000 characters; batch notifications reserve a bounded section for every member before dividing the remaining result budget, so later workers and the synthesis instruction are never lost to whole-message truncation. Model-facing `read` snapshots are capped at 8,000 characters (status + output + short recent tools — not the full timeline). The raw custom message is hidden from the transcript to avoid duplicating the parent model's user-facing summary; the TUI notification and queued parent turn remain. The live in-memory timeline for the panel is also bounded.

Active workers are session-process resources. `/reload`, `/new`, `/resume`, and session shutdown abort and dispose them. `/tree` navigation keeps them alive at the session level, so a later completion is delivered to whichever branch is active then. Workers share their requested cwd (must stay under the parent session cwd); do not assign overlapping edits unless they are deliberately coordinated. Worktree isolation is not currently implemented.

## Files

- `index.ts` — tool/command registration and lifecycle hooks
- `controller.ts` — scheduling, lifecycle, notifications, statusline chip
- `activity.ts` — semantic tool activity summaries
- `panel.ts` — `/agents` side panel
- `render.ts` — compact tool call/result UI
- `format.ts` — ids, type labels, statusline copy, fixed sort
- `agents.ts` — built-in profiles and Markdown discovery
- `config.ts` — profile preferences
- `schema.ts` / `types.ts` / `constants.ts` — contracts and defaults

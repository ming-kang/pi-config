# subagent — background Pi workers

Adds a model-callable `subagent` tool backed by isolated in-memory Pi `AgentSession` instances. Workers run in the background, show a compact **statusline chip**, open a full **interactive fleet panel** with `Alt+O` (transcript, steer, stop), and send a bounded completion follow-up to the parent.

Inspired in part by [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) fleet inspection (`/subagents-fleet` / inspector shortcut): status always visible, detail on demand.

`/agents` opens **settings only** (profiles, limits, clear, stop-all).

**Security note:** workers share the parent process credentials and OS permissions. Tool allowlists and cwd bounds reduce accidents; they are **not** a sandbox.

## Built-in profiles

| Profile | Behavior | Default tools | Defaults |
|---|---|---|---|
| `general` | Implementation worker; may edit | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` | model/thinking inherit |
| `explorer` | Read-only recon | `read`, `grep`, `find`, `ls` | thinking `low`; no AGENTS.md injection |

Tool capability comes only from the profile / Markdown definition. Model resolution: spawn override → saved `/agents` profile preference → agent definition → parent inherit.

## Tool

Default action is **`spawn`** when `prompt`/`task`/`tasks` is present.

| Action | Purpose |
|---|---|
| `spawn` | Enqueue work; returns ids immediately |
| `read` | List or bounded snapshot by id |
| `send` | Steer / continue / `fresh` rerun |
| `stop` | Abort (notifies parent with partial output) |

Spawn fields: `prompt` (or `task`), `description` (UI label), `agent`, optional `model`/`thinking`, `tasks[]` batch, `agentScope`.

Completion arrives as a parent follow-up — do not poll.

## TUI

### Statusline chip

While workers exist, `ctx.ui.setStatus` fills the statusline middle slot (with the bundled `statusline` extension). The chip is pre-colored by state (accent while live, warning when unread, success when done, error on failure):

| Chip | Meaning |
|---|---|
| `2 explorer · Alt+O` | explorers active (accent) |
| `1 running · 1 queued · Alt+O` | mixed activity |
| `2 done · unread · Alt+O` | finished; open panel to review |

No always-on floating card (avoids scroll / layout fights).

### `Alt+O` — fleet panel (interactive)

Capturing overlay (**centered** card — ~60% height on tall terminals, not a full-screen dump). Title rides in the top border. Multi-worker fleets use a chip rail labeled by spawn `description`.

Body stays short:

1. **meta** — id · task label · stats (one dim line; no multi-line brief)  
2. **tools** — last 6 tool lines only (`… +N tools` for the rest); no success footnotes  
3. **reply** — streaming Markdown while live; final Markdown when done (intermediate plan chatter dropped)  
4. **status + input** — Pi Loader braille spinner + mode word + `Input` (`send >` / …)

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Cycle workers (spawn order) |
| `↑↓` / `PgUp`/`PgDn` / `Home`/`End` | Scroll body |
| `Enter` | Context action: send / attach on start / continue / rerun |
| `ctrl+c` | Stop active worker (or close if idle) |
| `Esc` | Close panel |

Paths use `~` for the home directory.

### `/agents` settings

| Input | Action |
|---|---|
| `/agents` | Root settings menu |
| `/agents settings [profile]` | Model / thinking overrides |
| `/agents limits` | Concurrency / retention |
| `/agents clear [id\|all]` | Clear terminal records |

## Files

- `index.ts` — tool, `/agents`, `Alt+O`, lifecycle
- `controller.ts` — scheduling, sessions, notifications, statusline, panel host
- `panel.ts` — interactive fleet overlay
- `activity.ts` / `format.ts` / `render.ts` — activity, paths (`~`), tool UI
- `agents.ts` / `schema.ts` / `config.ts` / `constants.ts` / `types.ts`

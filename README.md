# Pi Configuration

This Pi package contains commonly used extensions and themes, maintained for personal use.

## Extensions

| Extension | What it does |
|:-:|---|
| [`question`](extensions/question/README.md) | `question` tool — multiple-choice prompts to the user, including multi-select and custom "Other" answers |
| [`statusline`](extensions/statusline/README.md) | Compact color-coded footer (model · effort · ctx% · cwd · branch · tokens · cost) |
| [`tools-view`](extensions/tools-view/README.md) | Compact rendering for built-in tools (read/bash/edit/write) and **central style hub** — all extensions import rendering primitives from `tools-view/shared.ts` |
| [`advisor`](extensions/advisor/README.md) | `advisor` tool + `/advisor` command — one-shot review from a configured reviewer model via Pi's own model registry and provider auth |
| [`rewind`](extensions/rewind/README.md) | Per-edit file backups; restore via `/tree`, settings & storage via `/rewind` |
| [`read-before-edit`](extensions/read-before-edit/README.md) | Blocks edit/write of a file that wasn't read first (or changed since read) |
| [`todo`](extensions/todo/README.md) | Conversation-backed task list tool with `/todos` and a live above-editor overlay |

Each extension's behavior and design notes live in its own README, linked above.

## Install / Update

Install from GitHub:

```bash
pi install git:github.com/ming-kang/pi-config
# or https form:
pi install https://github.com/ming-kang/pi-config
```

Update:

```bash
pi update --extensions                          # update all installed packages
pi update git:github.com/ming-kang/pi-config    # update only this one
```

Installing without a ref (no `@v1.0.0`) tracks the default branch, so `pi update` keeps everyone in sync with the latest changes. Auto-discovered resources can be reloaded in a running session with `/reload`.

## Development

Working on this package? Read [`AGENTS.md`](AGENTS.md) first — it documents the design conventions (centralized rendering, extension structure, per-extension decisions) that keep the extensions consistent.

To try local changes without installing, disable installed extensions and load this checkout for the session only:

```bash
pi -ne -e ./pi-config
```

`-ne` skips already-installed extensions so they don't shadow your working copy; `-e ./pi-config` loads this repo in place. This is the fastest way to verify a change — no install, no copy.

To install a local checkout for everyday use instead:

```bash
pi install ./pi-config
# or project-scoped (this directory only):
pi install -l ./pi-config
```

## License

[MIT](LICENSE)

# Pi Configuration

This Pi package contains commonly used extensions and themes, maintained for personal use.

## Extensions

| Extension | What it does |
|:-:|---|
| [`question`](extensions/question/README.md) | `question` tool — multiple-choice prompts to the user, including multi-select and custom "Other" answers |
| [`statusline`](extensions/statusline/README.md) | Fixed two-line left/right footer: model·effort | cwd·branch; CTX | tokens·cache·cost |
| [`deepwiki`](extensions/deepwiki/README.md) | `deepwiki` tool — query DeepWiki repository docs for GitHub repos without adding generic MCP support to Pi |
| [`rewind`](extensions/rewind/README.md) | Per-edit file backups; restore via `/tree`, settings & storage via `/rewind` |
| [`read-before-edit`](extensions/read-before-edit/README.md) | Blocks edit/write of a file that wasn't read first (or changed since read) |
| [`todo`](extensions/todo/README.md) | Conversation-backed task list tool with `/todos` and a live above-editor overlay |
| [`subagent`](extensions/subagent/README.md) | Isolated background workers with profile inheritance, statusline progress, completion feedback, and a right-side control panel |

Each extension's behavior and design notes live in its own README, linked above.

## Themes

| Theme | What it does |
|:-:|---|
| [`ice-cream-dark`](themes/README.md) | Dark pastel Pi theme used with the native UI and statusline |
| [`ice-cream-light`](themes/README.md) | Light counterpart — same semantic mapping, light palette |

Theme details and conventions live in [`themes/README.md`](themes/README.md).

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

Working on this package? Read [`AGENTS.md`](AGENTS.md) first — it documents the self-contained extension boundaries and per-extension decisions that keep the package maintainable.

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

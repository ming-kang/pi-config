# Pi Configuration

This Pi package contains commonly used extensions and themes, maintained for personal use.

## Structure

```
pi-config/
  extensions/        # .ts / .js extensions (auto-discovered)
    shared/          # cross-extension helper modules (not loaded as an extension)
  themes/            # .json themes (auto-discovered)
  package.json       # Pi manifest (pi.extensions, pi.themes)
```

Pi discovers resources from the `pi` manifest in `package.json`, with the `extensions/` and `themes/` directories as a fallback.

## Extensions

| Extension | What it does |
|---|---|
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

Or install from a local checkout (Pi loads it in place, no copy):

```bash
pi install ./pi-config
# or project-scoped:
pi install -l ./pi-config
```

Update:

```bash
pi update --extensions                          # update all installed packages
pi update git:github.com/ming-kang/pi-config    # update only this one
```

Installing without a ref (no `@v1.0.0`) tracks the default branch, so `pi update` keeps everyone in sync with the latest changes. Auto-discovered resources can be reloaded in a running session with `/reload`.

## Loading only part of this package

Pi installs the whole repository, but loading is selectable. In `settings.json`:

```json
{
	"packages": [
		{
			"source": "git:github.com/ming-kang/pi-config",
			"themes": ["themes/ice-cream.json"],
			"extensions": []
		}
	]
}
```

- Omit a key → load all of that type.
- `[]` → load none of that type.
- Glob and `!exclusions`, `+path` / `-path` overrides are supported.

Or use `pi config` to enable/disable individual resources after install.

## License

MIT

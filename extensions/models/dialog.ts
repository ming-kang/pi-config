/**
 * models — dialog
 *
 * UI dialog factories consumed by `index.ts`. Three flavors:
 *
 * 1. Top-level menus (`createProvidersMenu`, `createProviderActionsMenu`)
 *    — SelectList-based, single-screen pickers.
 *
 * 2. Sub-editors (`createInputPrompt`, `createConfirm`) — opened as
 *    overlays by other forms. Each returns a Container whose `done`
 *    callback receives `{ saved?: T; cancelled?: true }`.
 *
 * 3. Probe checklist (`createProbeChecklist`) — multi-select for adding
 *    probed models. Returns `{ kind: "save", selectedIds }` on confirm.
 *
 * Layout: every dialog wraps its content in a bordered frame with title +
 * footer hint so the user always sees where they are and how to exit.
 */

import { DynamicBorder, getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { HINTS, truncate } from "./constants.ts";
import type { ProviderEntry } from "./store.ts";

// ============================================================================
// Frame helper
// ============================================================================

function frame(
	theme: Theme,
	title: string,
	hint: string,
	body: (container: Container) => void,
): Container {
	const container = new Container();
	container.addChild(new DynamicBorder());
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	container.addChild(new Spacer(1));
	body(container);
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", `  ${hint}`), 0, 0));
	container.addChild(new DynamicBorder());
	return container;
}

// ============================================================================
// 1. Providers menu — top-level list
// ============================================================================

const ADD_NEW_SENTINEL = "__add_new__";

export type ProvidersMenuResult =
	| { kind: "pick"; providerId: string }
	| { kind: "add" }
	| { kind: "cancel" };

export function createProvidersMenu(
	providers: Array<{ id: string; entry: ProviderEntry }>,
): (tui: TUI, theme: Theme, _kb: unknown, done: (result: ProvidersMenuResult) => void) => Container {
	return (_tui, theme, _kb, done) => {
		const items: SelectItem[] = providers.map((p) => {
			const api = p.entry.api ?? "?";
			const modelCount = Array.isArray(p.entry.models) ? p.entry.models.length : 0;
			const baseUrl = p.entry.baseUrl ?? "(no baseUrl)";
			return {
				value: p.id,
				label: p.id,
				description: `${api} · ${modelCount} model${modelCount === 1 ? "" : "s"} · ${truncate(baseUrl, 48)}`,
			};
		});
		items.push({
			value: ADD_NEW_SENTINEL,
			label: theme.fg("success", "+ Add new provider"),
			description: "Define a brand-new custom provider",
		});

		const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
		list.onSelect = (item) => {
			if (item.value === ADD_NEW_SENTINEL) done({ kind: "add" });
			else done({ kind: "pick", providerId: item.value });
		};
		list.onCancel = () => done({ kind: "cancel" });

		return frame(theme, "Custom Models  ·  ~/.pi/agent/models.json", HINTS.menu, (c) => {
			if (providers.length === 0) {
				c.addChild(
					new Text(theme.fg("muted", "  No custom providers yet — pick \"+ Add new provider\"."), 0, 0),
				);
				c.addChild(new Spacer(1));
			}
			c.addChild(list);
		});
	};
}

// ============================================================================
// 2. Provider action menu — Edit / Probe / Remove / Back
// ============================================================================

export type ProviderAction = "edit" | "probe" | "remove" | "back";

export function createProviderActionsMenu(
	providerId: string,
	entry: ProviderEntry,
): (tui: TUI, theme: Theme, _kb: unknown, done: (action: ProviderAction | undefined) => void) => Container {
	return (_tui, theme, _kb, done) => {
		const modelCount = Array.isArray(entry.models) ? entry.models.length : 0;
		const items: SelectItem[] = [
			{
				value: "edit",
				label: "Edit fields",
				description: "Provider fields + headers + models (single-screen form)",
			},
			{
				value: "probe",
				label: "Probe /v1/models for new models",
				description: `Fetch the model catalog from ${truncate(entry.baseUrl ?? "(no baseUrl)", 40)}`,
			},
			{
				value: "remove",
				label: theme.fg("error", "Remove provider"),
				description: `Delete "${providerId}" from models.json`,
			},
			{ value: "back", label: "Back", description: "Return to provider list" },
		];

		const list = new SelectList(items, items.length, getSelectListTheme());
		list.onSelect = (item) => done(item.value as ProviderAction);
		list.onCancel = () => done("back");

		const subtitle = `${entry.api ?? "?"} · ${modelCount} model${modelCount === 1 ? "" : "s"} · ${truncate(
			entry.baseUrl ?? "(no baseUrl)",
			50,
		)}`;

		return frame(theme, providerId, `${subtitle}  ·  ${HINTS.menu}`, (c) => {
			c.addChild(list);
		});
	};
}

// ============================================================================
// 3. Input prompt — single-line text editor with optional validation
// ============================================================================

export interface InputPromptOptions {
	title: string;
	initial?: string;
	placeholder?: string;
	validate?: (value: string) => string | undefined;
}

export type InputPromptResult = { saved?: string; cancelled?: true };

export function createInputPrompt(
	opts: InputPromptOptions,
): (tui: TUI, theme: Theme, _kb: unknown, done: (result: InputPromptResult) => void) => Container {
	return (_tui, theme, _kb, done) => {
		const input = new Input();
		input.setValue(opts.initial ?? "");
		const errorText = new Text("", 0, 0);

		const submit = () => {
			const value = input.getValue();
			if (opts.validate) {
				const err = opts.validate(value);
				if (err) {
					errorText.setText(theme.fg("error", `  ${err}`));
					return;
				}
			}
			done({ saved: value });
		};

		input.onSubmit = () => submit();
		input.onEscape = () => done({ cancelled: true });

		const wrap = new Container();
		wrap.addChild(new DynamicBorder());
		wrap.addChild(new Text(theme.fg("accent", theme.bold(opts.title)), 1, 0));
		wrap.addChild(new Spacer(1));
		if (opts.placeholder) {
			wrap.addChild(new Text(theme.fg("muted", `  e.g., ${opts.placeholder}`), 0, 0));
		}
		wrap.addChild(new Spacer(1));
		wrap.addChild(input);
		wrap.addChild(errorText);
		wrap.addChild(new Spacer(1));
		wrap.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to cancel"), 0, 0));
		wrap.addChild(new DynamicBorder());

		wrap.handleInput = (data: string) => {
			errorText.setText("");
			input.handleInput(data);
		};
		return wrap;
	};
}

// ============================================================================
// 4. Confirm — yes/no picker
// ============================================================================

export type ConfirmResult = "yes" | "no";

export function createConfirm(
	title: string,
	message: string,
): (tui: TUI, theme: Theme, _kb: unknown, done: (result: ConfirmResult) => void) => Container {
	return (_tui, theme, _kb, done) => {
		const list = new SelectList(
			[
				{ value: "yes", label: theme.fg("warning", "Yes") },
				{ value: "no", label: "No" },
			],
			2,
			getSelectListTheme(),
		);
		list.onSelect = (item) => done(item.value as ConfirmResult);
		list.onCancel = () => done("no");

		return frame(theme, title, "Enter to choose · Esc = No", (c) => {
			c.addChild(new Text(theme.fg("text", `  ${message}`), 0, 0));
			c.addChild(new Spacer(1));
			c.addChild(list);
		});
	};
}

// ============================================================================
// 5. Probe checklist — multi-select probed model ids
// ============================================================================

export type ProbeChecklistResult =
	| { kind: "save"; selectedIds: string[] }
	| { kind: "cancel" };

export function createProbeChecklist(
	providerLabel: string,
	models: Array<{ id: string; name?: string }>,
): (tui: TUI, theme: Theme, _kb: unknown, done: (result: ProbeChecklistResult) => void) => Container {
	return (_tui, theme, _kb, done) => {
		const selected = new Set<string>(models.map((m) => m.id));
		const rows = models.map(() => new Text("", 0, 0));
		const footer = new Text("", 0, 0);
		let index = 0;

		const drawRow = (i: number) => {
			const item = models[i];
			if (!item) return;
			const isSelected = i === index;
			const checked = selected.has(item.id);
			const cursor = isSelected ? theme.fg("accent", "▶ ") : "  ";
			const box = checked ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
			const labelText = isSelected ? theme.fg("accent", item.id) : theme.fg("text", item.id);
			const desc = item.name ? theme.fg("muted", `  ${item.name}`) : "";
			rows[i]!.setText(`${cursor}${box} ${labelText}${desc}`);
		};

		const drawAll = () => {
			for (let i = 0; i < models.length; i++) drawRow(i);
			footer.setText(
				theme.fg("dim", `  ${selected.size}/${models.length} selected · ${HINTS.probeCheck}`),
			);
		};

		drawAll();

		const inner = new Container();
		for (const r of rows) inner.addChild(r);
		inner.addChild(new Spacer(1));
		inner.addChild(footer);

		const container = frame(theme, `Probe results: ${providerLabel}`, HINTS.probeCheck, (c) => {
			c.addChild(inner);
		});

		container.handleInput = (data: string) => {
			if (matchesKey(data, "up") || data === "\x1b[A") {
				index = index === 0 ? models.length - 1 : index - 1;
				drawAll();
				return;
			}
			if (matchesKey(data, "down") || data === "\x1b[B") {
				index = index === models.length - 1 ? 0 : index + 1;
				drawAll();
				return;
			}
			if (data === " ") {
				const item = models[index];
				if (item) {
					if (selected.has(item.id)) selected.delete(item.id);
					else selected.add(item.id);
					drawAll();
				}
				return;
			}
			if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
				const ids = models.map((m) => m.id).filter((id) => selected.has(id));
				done({ kind: "save", selectedIds: ids });
				return;
			}
			if (matchesKey(data, "escape") || data === "\x1b") {
				done({ kind: "cancel" });
				return;
			}
		};

		return container;
	};
}
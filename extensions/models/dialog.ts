/** Small private UI primitives for the models manager. */

import { DynamicBorder, keyHint, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	type KeybindingsManager,
	matchesKey,
	Spacer,
	Text,
	TruncatedText,
	truncateToWidth,
	type TUI,
} from "@earendil-works/pi-tui";
import { truncate } from "./constants.ts";

export interface TextInputOptions {
	title: string;
	initial?: string;
	placeholder?: string;
	validate?: (value: string) => string | undefined;
}

export function createTextInput(
	opts: TextInputOptions,
): (tui: TUI, theme: Theme, _kb: unknown, done: (result: string | undefined) => void) => Container {
	return (tui, theme, _kb, done) => {
		const input = new Input();
		if (opts.initial) input.handleInput(opts.initial);
		const errorText = new Text("", 0, 0);
		const container = new Container() as Container & {
			handleInput: (data: string) => void;
			focused: boolean;
		};

		container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold(opts.title)), 1, 0));
		if (opts.placeholder) container.addChild(new Text(theme.fg("muted", `  e.g. ${opts.placeholder}`), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(input);
		container.addChild(errorText);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "  Enter save · Esc cancel"), 0, 0));
		container.addChild(new DynamicBorder((text) => theme.fg("border", text)));

		Object.defineProperty(container, "focused", {
			get: () => input.focused,
			set: (focused: boolean) => {
				input.focused = focused;
			},
		});

		input.onSubmit = (value) => {
			const error = opts.validate?.(value);
			if (error) {
				errorText.setText(theme.fg("error", `  ${error}`));
				tui.requestRender();
				return;
			}
			done(value);
		};
		input.onEscape = () => done(undefined);
		container.handleInput = (data: string) => {
			errorText.setText("");
			input.handleInput(data);
		};
		return container;
	};
}

export interface SearchableSelectorItem<T extends string> {
	value: T;
	label: string;
	description?: string;
	searchText?: string;
}

export interface SearchableSelectorOptions<T extends string> {
	title: string;
	subtitle?: string;
	items: readonly SearchableSelectorItem<T>[];
	initialQuery?: string;
	maxVisible?: number;
	emptyMessage?: string;
	/** Optional Ctrl+S destination for workspace-style selectors. */
	saveValue?: T;
}

/**
 * A browse-first fuzzy selector. The filter is deliberately invisible until
 * the user starts typing: ordinary menus should feel like menus, not forms.
 */
export function createSearchableSelector<T extends string>(
	opts: SearchableSelectorOptions<T>,
): (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T | undefined) => void,
) => Container {
	return (tui, theme, keybindings, done) => {
		const allItems = [...opts.items];
		let filteredItems = allItems;
		let selectedIndex = 0;
		const maxVisible = Math.max(1, opts.maxVisible ?? 9);
		const input = new Input();
		const search = new Container();
		const list = new Container();
		const footer = new Text("", 1, 0);
		const container = new Container() as Container & {
			handleInput: (data: string) => void;
			focused: boolean;
		};

		const refresh = () => {
			search.clear();
			if (input.getValue()) {
				search.addChild(input);
				search.addChild(new Spacer(1));
			}
			list.clear();
			const start = Math.max(
				0,
				Math.min(selectedIndex - Math.floor(maxVisible / 2), filteredItems.length - maxVisible),
			);
			const end = Math.min(start + maxVisible, filteredItems.length);
			for (let index = start; index < end; index++) {
				const item = filteredItems[index];
				if (!item) continue;
				const active = index === selectedIndex;
				const prefix = active ? theme.fg("accent", "→ ") : "  ";
				const label = theme.fg(active ? "accent" : "text", item.label);
				const description = item.description ? theme.fg("muted", `  ${item.description}`) : "";
				list.addChild(new TruncatedText(prefix + label + description, 1, 0));
			}
			if (filteredItems.length === 0) {
				list.addChild(new Text(theme.fg("muted", `  ${opts.emptyMessage ?? "No matching items"}`), 1, 0));
			} else if (start > 0 || end < filteredItems.length) {
				list.addChild(
					new Text(theme.fg("muted", `  (${selectedIndex + 1}/${filteredItems.length})`), 1, 0),
				);
			}
			const hints = [
				rawKeyHint("type", "filter"),
				rawKeyHint("↑↓", "navigate"),
				keyHint("tui.select.confirm", "select"),
			];
			if (opts.saveValue !== undefined) hints.push(keyHint("app.models.save", "save"));
			hints.push(keyHint("tui.select.cancel", input.getValue() ? "clear filter" : "back"));
			footer.setText(hints.join("  "));
			container.invalidate();
			tui.requestRender();
		};

		const applyFilter = (query: string) => {
			filteredItems = query
				? fuzzyFilter(
						allItems,
						query,
						(item) => item.searchText ?? `${item.label} ${item.description ?? ""} ${item.value}`,
					)
				: allItems;
			selectedIndex = 0;
			refresh();
		};

		container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
		container.addChild(new Spacer(1));
		container.addChild(new TruncatedText(theme.fg("accent", theme.bold(opts.title)), 1, 0));
		if (opts.subtitle) container.addChild(new TruncatedText(theme.fg("muted", opts.subtitle), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(search);
		container.addChild(list);
		container.addChild(new Spacer(1));
		container.addChild(footer);
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder((text) => theme.fg("border", text)));

		Object.defineProperty(container, "focused", {
			get: () => input.focused,
			set: (focused: boolean) => {
				input.focused = focused;
			},
		});

		container.handleInput = (data: string) => {
			if (opts.saveValue !== undefined && keybindings.matches(data, "app.models.save")) {
				done(opts.saveValue);
				return;
			}
			if (keybindings.matches(data, "tui.select.up")) {
				if (filteredItems.length > 0) {
					selectedIndex = selectedIndex === 0 ? filteredItems.length - 1 : selectedIndex - 1;
					refresh();
				}
				return;
			}
			if (keybindings.matches(data, "tui.select.down")) {
				if (filteredItems.length > 0) {
					selectedIndex = selectedIndex === filteredItems.length - 1 ? 0 : selectedIndex + 1;
					refresh();
				}
				return;
			}
			if (keybindings.matches(data, "tui.select.pageUp")) {
				selectedIndex = Math.max(0, selectedIndex - maxVisible);
				refresh();
				return;
			}
			if (keybindings.matches(data, "tui.select.pageDown")) {
				selectedIndex = Math.min(Math.max(0, filteredItems.length - 1), selectedIndex + maxVisible);
				refresh();
				return;
			}
			if (keybindings.matches(data, "tui.select.confirm")) {
				const item = filteredItems[selectedIndex];
				if (item) done(item.value);
				return;
			}
			if (keybindings.matches(data, "tui.select.cancel")) {
				if (input.getValue()) {
					input.setValue("");
					applyFilter("");
					return;
				}
				done(undefined);
				return;
			}
			input.handleInput(data);
			applyFilter(input.getValue());
		};

		if (opts.initialQuery) input.handleInput(opts.initialQuery);
		applyFilter(opts.initialQuery ?? "");
		return container;
	};
}

export interface SearchableChecklistItem {
	value: string;
	label: string;
	searchText?: string;
}

export interface SearchableChecklistOptions {
	title: string;
	items: readonly SearchableChecklistItem[];
	initialSelected?: readonly string[];
	confirmLabel?: string;
	emptyMessage?: string;
}

export type SearchableChecklistResult =
	| { kind: "save"; selectedIds: string[] }
	| { kind: "cancel" };

/**
 * A multi-select counterpart to the browse-first selector. It keeps the
 * current filter out of the way until it is useful and never loses selections
 * that happen to be filtered out.
 */
export function createSearchableChecklist(
	opts: SearchableChecklistOptions,
): (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: SearchableChecklistResult) => void,
) => Container {
	return (tui, theme, keybindings, done) => {
		const items = [...opts.items];
		const selected = new Set(opts.initialSelected ?? []);
		let filteredItems = items;
		let index = 0;
		let offset = 0;
		let searching = false;
		let focused = false;
		const viewport = 10;
		const input = new Input();
		const topBorder = new DynamicBorder((text) => theme.fg("border", text));
		const bottomBorder = new DynamicBorder((text) => theme.fg("border", text));
		const enableAllKey = keybindings.getKeys("app.models.enableAll").join("/") || "ctrl+a";
		const clearAllKey = keybindings.getKeys("app.models.clearAll").join("/") || "ctrl+x";
		const saveKey = keybindings.getKeys("app.models.save").join("/") || "ctrl+s";
		const container = new Container() as Container & {
			render: (width: number) => string[];
			handleInput: (data: string) => void;
			focused: boolean;
		};

		const refresh = () => {
			container.invalidate();
			tui.requestRender();
		};

		const keepVisible = () => {
			if (index < offset) offset = index;
			if (index >= offset + viewport) offset = index - viewport + 1;
		};

		const applyFilter = () => {
			const query = input.getValue();
			filteredItems = query
				? fuzzyFilter(items, query, (item) => item.searchText ?? `${item.label} ${item.value}`)
				: items;
			index = 0;
			offset = 0;
			refresh();
		};

		container.render = (width: number): string[] => {
			const lines = [
				...topBorder.render(width),
				"",
				truncateToWidth(theme.fg("accent", theme.bold(opts.title)), width),
				theme.fg("muted", `  ${selected.size}/${items.length} selected · ${filteredItems.length} shown`),
				"",
			];
			if (searching) {
				lines.push(theme.fg("muted", "  Filter models"));
				lines.push(...input.render(Math.max(1, width - 2)).map((line) => ` ${line}`), "");
			}
			const end = Math.min(filteredItems.length, offset + viewport);
			for (let row = offset; row < end; row++) {
				const item = filteredItems[row]!;
				const active = row === index;
				const cursor = active ? theme.fg("accent", "▶") : " ";
				const box = selected.has(item.value) ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
				const text = truncate(item.label, Math.max(12, width - 9));
				lines.push(
					truncateToWidth(`${cursor} ${box} ${active ? theme.fg("accent", text) : theme.fg("text", text)}`, width),
				);
			}
			if (filteredItems.length === 0) {
				lines.push(theme.fg("muted", `  ${opts.emptyMessage ?? "No matching items"}`));
			} else if (filteredItems.length > viewport) {
				lines.push(theme.fg("dim", `  showing ${offset + 1}–${end} of ${filteredItems.length}`));
			}
			lines.push("");
			lines.push(
				truncateToWidth(
					theme.fg("dim", `  ↑↓ move · Enter/Space toggle · ${enableAllKey} all · ${clearAllKey} clear`),
					width,
				),
			);
			lines.push(
				truncateToWidth(
					theme.fg(
						"dim",
						`  / filter · ${saveKey} ${opts.confirmLabel ?? "save"} · Esc ${searching ? (input.getValue() ? "clear filter" : "close filter") : "cancel"}`,
					),
					width,
				),
			);
			lines.push("", ...bottomBorder.render(width));
			return lines;
		};

		container.handleInput = (data: string) => {
			if (!searching && matchesKey(data, "/")) {
				searching = true;
				input.focused = focused;
				refresh();
				return;
			}
			if (keybindings.matches(data, "tui.select.up")) {
				if (filteredItems.length === 0) return;
				index = index === 0 ? filteredItems.length - 1 : index - 1;
				keepVisible();
				refresh();
				return;
			}
			if (keybindings.matches(data, "tui.select.down")) {
				if (filteredItems.length === 0) return;
				index = index === filteredItems.length - 1 ? 0 : index + 1;
				keepVisible();
				refresh();
				return;
			}
			if (keybindings.matches(data, "tui.select.pageUp")) {
				index = Math.max(0, index - viewport);
				keepVisible();
				refresh();
				return;
			}
			if (keybindings.matches(data, "tui.select.pageDown")) {
				index = Math.min(Math.max(0, filteredItems.length - 1), index + viewport);
				keepVisible();
				refresh();
				return;
			}
			if (matchesKey(data, "space") || keybindings.matches(data, "tui.select.confirm")) {
				const item = filteredItems[index];
				if (item) {
					if (selected.has(item.value)) selected.delete(item.value);
					else selected.add(item.value);
					refresh();
				}
				return;
			}
			if (keybindings.matches(data, "app.models.enableAll")) {
				const targets = input.getValue() ? filteredItems : items;
				for (const item of targets) selected.add(item.value);
				refresh();
				return;
			}
			if (keybindings.matches(data, "app.models.clearAll")) {
				const targets = input.getValue() ? filteredItems : items;
				for (const item of targets) selected.delete(item.value);
				refresh();
				return;
			}
			if (keybindings.matches(data, "app.models.save")) {
				done({ kind: "save", selectedIds: items.map((item) => item.value).filter((value) => selected.has(value)) });
				return;
			}
			if (keybindings.matches(data, "tui.select.cancel")) {
				if (input.getValue()) {
					input.setValue("");
					applyFilter();
					return;
				}
				if (searching) {
					searching = false;
					input.focused = false;
					refresh();
					return;
				}
				done({ kind: "cancel" });
				return;
			}
			if (searching) {
				input.handleInput(data);
				applyFilter();
			}
		};

		Object.defineProperty(container, "focused", {
			get: () => focused,
			set: (value: boolean) => {
				focused = value;
				input.focused = value && searching;
			},
		});

		return container;
	};
}

export type ProbeChecklistResult = SearchableChecklistResult;

export function createProbeChecklist(
	providerLabel: string,
	models: Array<{ id: string; name?: string }>,
): (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: ProbeChecklistResult) => void,
) => Container {
	return createSearchableChecklist({
		title: `Select models to add · ${providerLabel}`,
		items: models.map((model) => ({
			value: model.id,
			label: model.name && model.name !== model.id ? `${model.id} — ${model.name}` : model.id,
			searchText: `${model.id} ${model.name ?? ""}`,
		})),
		// A remote catalog can be huge. Importing is an explicit selection, not
		// an opt-out of every model the endpoint happens to expose.
		initialSelected: [],
		confirmLabel: "add",
		emptyMessage: "No matching models",
	});
}

export interface ModelWorkspaceItem {
	id: string;
	label: string;
	searchText?: string;
}

export type ModelWorkspaceResult =
	| { kind: "edit"; id: string; selectedIds: string[] }
	| { kind: "actions" | "add" | "discover" | "bulk" | "remove"; selectedIds: string[] }
	| { kind: "save"; selectedIds: string[] }
	| { kind: "back"; selectedIds: string[] };

/**
 * Provider-local model management. Unlike a checklist, Enter edits the
 * current model and Space builds an explicit selection for bulk actions.
 * The search Input is mounted only after the user starts filtering.
 */
export function createModelWorkspace(
	title: string,
	items: readonly ModelWorkspaceItem[],
	initialSelected: readonly string[],
	dirty: boolean,
): (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: ModelWorkspaceResult) => void,
) => Container {
	return (tui, theme, keybindings, done) => {
		const allItems = [...items];
		const selected = new Set(initialSelected);
		let filteredItems = allItems;
		let index = 0;
		let offset = 0;
		let searching = false;
		let focused = false;
		const viewport = 10;
		const input = new Input();
		const topBorder = new DynamicBorder((text) => theme.fg("border", text));
		const bottomBorder = new DynamicBorder((text) => theme.fg("border", text));
		const enableAllKey = keybindings.getKeys("app.models.enableAll").join("/") || "ctrl+a";
		const clearAllKey = keybindings.getKeys("app.models.clearAll").join("/") || "ctrl+x";
		const saveKey = keybindings.getKeys("app.models.save").join("/") || "ctrl+s";
		const container = new Container() as Container & {
			render: (width: number) => string[];
			handleInput: (data: string) => void;
			focused: boolean;
		};

		const selectedIds = () => allItems.map((item) => item.id).filter((id) => selected.has(id));
		const refresh = () => {
			container.invalidate();
			tui.requestRender();
		};
		const keepVisible = () => {
			if (index < offset) offset = index;
			if (index >= offset + viewport) offset = index - viewport + 1;
		};
		const applyFilter = () => {
			const query = input.getValue();
			filteredItems = query
				? fuzzyFilter(allItems, query, (item) => item.searchText ?? `${item.label} ${item.id}`)
				: allItems;
			index = 0;
			offset = 0;
			refresh();
		};

		container.render = (width: number): string[] => {
			const lines = [...topBorder.render(width), "", truncateToWidth(theme.fg("accent", theme.bold(title)), width)];
			lines.push(
				theme.fg(
					"muted",
					`  ${allItems.length} configured · ${selected.size} selected${dirty ? " · unsaved changes" : ""}`,
				),
				"",
			);
			if (searching) {
				lines.push(theme.fg("muted", "  Filter configured models"));
				lines.push(...input.render(Math.max(1, width - 2)).map((line) => ` ${line}`), "");
			}
			const end = Math.min(filteredItems.length, offset + viewport);
			for (let row = offset; row < end; row++) {
				const item = filteredItems[row]!;
				const active = row === index;
				const cursor = active ? theme.fg("accent", "▶") : " ";
				const box = selected.has(item.id) ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
				const label = truncate(item.label, Math.max(12, width - 9));
				lines.push(
					truncateToWidth(`${cursor} ${box} ${active ? theme.fg("accent", label) : theme.fg("text", label)}`, width),
				);
			}
			if (allItems.length === 0) {
				lines.push(theme.fg("muted", "  No models configured."));
				lines.push(theme.fg("dim", "  Press a to add model IDs or f to fetch the server catalog."));
			} else if (filteredItems.length === 0) {
				lines.push(theme.fg("muted", "  No matching models"));
			} else if (filteredItems.length > viewport) {
				lines.push(theme.fg("dim", `  showing ${offset + 1}–${end} of ${filteredItems.length}`));
			}
			lines.push("");
			lines.push(
				truncateToWidth(
					theme.fg("dim", "  Enter edit · Space select · a add · f fetch · / filter · Tab more"),
					width,
				),
			);
			const selectionHints = selected.size > 0 ? ` · e bulk edit · d remove · ${clearAllKey} clear` : "";
			lines.push(
				truncateToWidth(
					theme.fg(
						"dim",
						`  ${enableAllKey} select all${selectionHints} · ${saveKey} save · Esc ${searching ? (input.getValue() ? "clear filter" : "close filter") : "back"}`,
					),
					width,
				),
			);
			lines.push("", ...bottomBorder.render(width));
			return lines;
		};

		container.handleInput = (data: string) => {
			if (!searching) {
				if (matchesKey(data, "/")) {
					searching = true;
					input.focused = focused;
					refresh();
					return;
				}
				if (matchesKey(data, "a")) return done({ kind: "add", selectedIds: selectedIds() });
				if (matchesKey(data, "f")) return done({ kind: "discover", selectedIds: selectedIds() });
				if (selected.size > 0 && matchesKey(data, "e")) return done({ kind: "bulk", selectedIds: selectedIds() });
				if (selected.size > 0 && matchesKey(data, "d")) return done({ kind: "remove", selectedIds: selectedIds() });
			}
			if (keybindings.matches(data, "tui.select.up")) {
				if (filteredItems.length === 0) return;
				index = index === 0 ? filteredItems.length - 1 : index - 1;
				keepVisible();
				refresh();
				return;
			}
			if (keybindings.matches(data, "tui.select.down")) {
				if (filteredItems.length === 0) return;
				index = index === filteredItems.length - 1 ? 0 : index + 1;
				keepVisible();
				refresh();
				return;
			}
			if (keybindings.matches(data, "tui.select.pageUp")) {
				index = Math.max(0, index - viewport);
				keepVisible();
				refresh();
				return;
			}
			if (keybindings.matches(data, "tui.select.pageDown")) {
				index = Math.min(Math.max(0, filteredItems.length - 1), index + viewport);
				keepVisible();
				refresh();
				return;
			}
			if (matchesKey(data, "space")) {
				const item = filteredItems[index];
				if (item) {
					if (selected.has(item.id)) selected.delete(item.id);
					else selected.add(item.id);
					refresh();
				}
				return;
			}
			if (keybindings.matches(data, "tui.input.tab")) {
				done({ kind: "actions", selectedIds: selectedIds() });
				return;
			}
			if (keybindings.matches(data, "app.models.enableAll")) {
				for (const item of input.getValue() ? filteredItems : allItems) selected.add(item.id);
				refresh();
				return;
			}
			if (keybindings.matches(data, "app.models.clearAll")) {
				for (const item of input.getValue() ? filteredItems : allItems) selected.delete(item.id);
				refresh();
				return;
			}
			if (keybindings.matches(data, "app.models.save")) {
				done({ kind: "save", selectedIds: selectedIds() });
				return;
			}
			if (keybindings.matches(data, "tui.select.confirm")) {
				const item = filteredItems[index];
				if (item) done({ kind: "edit", id: item.id, selectedIds: selectedIds() });
				return;
			}
			if (keybindings.matches(data, "tui.select.cancel")) {
				if (input.getValue()) {
					input.setValue("");
					applyFilter();
					return;
				}
				if (searching) {
					searching = false;
					input.focused = false;
					refresh();
					return;
				}
				done({ kind: "back", selectedIds: selectedIds() });
				return;
			}
			if (searching) {
				input.handleInput(data);
				applyFilter();
			}
		};

		Object.defineProperty(container, "focused", {
			get: () => focused,
			set: (value: boolean) => {
				focused = value;
				input.focused = value && searching;
			},
		});
		return container;
	};
}

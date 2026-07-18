/** Small private UI primitives for the models manager. */

import { DynamicBorder, keyHint, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	type KeybindingsManager,
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
	items: readonly SearchableSelectorItem<T>[];
	initialQuery?: string;
	maxVisible?: number;
	emptyMessage?: string;
}

/** Login-style fuzzy selector for provider and model lists that can grow without bound. */
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
		const list = new Container();
		const container = new Container() as Container & {
			handleInput: (data: string) => void;
			focused: boolean;
		};

		const refresh = () => {
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
		container.addChild(new Spacer(1));
		container.addChild(input);
		container.addChild(new Spacer(1));
		container.addChild(list);
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "back"),
				1,
				0,
			),
		);
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder((text) => theme.fg("border", text)));

		Object.defineProperty(container, "focused", {
			get: () => input.focused,
			set: (focused: boolean) => {
				input.focused = focused;
			},
		});

		container.handleInput = (data: string) => {
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

export type ProbeChecklistResult =
	| { kind: "save"; selectedIds: string[] }
	| { kind: "cancel" };

export function createProbeChecklist(
	providerLabel: string,
	models: Array<{ id: string; name?: string }>,
): (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: ProbeChecklistResult) => void,
) => Container {
	return (tui, theme, keybindings, done) => {
		const selected = new Set(models.map((model) => model.id));
		let filteredModels = models;
		let index = 0;
		let offset = 0;
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
			filteredModels = query
				? fuzzyFilter(models, query, (model) => `${model.id} ${model.name ?? ""}`)
				: models;
			index = 0;
			offset = 0;
			refresh();
		};

		container.render = (width: number): string[] => {
			const lines = [
				...topBorder.render(width),
				"",
				truncateToWidth(theme.fg("accent", theme.bold(`Select models to add · ${providerLabel}`)), width),
				"",
			];
			lines.push(...input.render(Math.max(1, width - 2)).map((line) => ` ${line}`), "");
			const end = Math.min(filteredModels.length, offset + viewport);
			for (let row = offset; row < end; row++) {
				const model = filteredModels[row]!;
				const active = row === index;
				const cursor = active ? theme.fg("accent", "▶") : " ";
				const box = selected.has(model.id) ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
				const detail = model.name && model.name !== model.id ? ` — ${model.name}` : "";
				const text = truncate(`${model.id}${detail}`, Math.max(12, width - 9));
				lines.push(
					truncateToWidth(`${cursor} ${box} ${active ? theme.fg("accent", text) : theme.fg("text", text)}`, width),
				);
			}
			if (filteredModels.length === 0) {
				lines.push(theme.fg("muted", "  No matching models"));
			} else if (filteredModels.length > viewport) {
				lines.push(theme.fg("dim", `  showing ${offset + 1}–${end} of ${filteredModels.length}`));
			}
			lines.push("");
			lines.push(
				truncateToWidth(
					theme.fg(
						"dim",
						`  ${selected.size}/${models.length} selected · ${filteredModels.length} shown · ↑↓ move · Space toggle · ${enableAllKey} all · ${clearAllKey} clear · Enter/${saveKey} add · Esc cancel`,
					),
					width,
				),
			);
			lines.push("", ...bottomBorder.render(width));
			return lines;
		};

		container.handleInput = (data: string) => {
			if (keybindings.matches(data, "tui.select.up")) {
				if (filteredModels.length === 0) return;
				index = index === 0 ? filteredModels.length - 1 : index - 1;
				keepVisible();
				refresh();
				return;
			}
			if (keybindings.matches(data, "tui.select.down")) {
				if (filteredModels.length === 0) return;
				index = index === filteredModels.length - 1 ? 0 : index + 1;
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
				index = Math.min(Math.max(0, filteredModels.length - 1), index + viewport);
				keepVisible();
				refresh();
				return;
			}
			if (data === " ") {
				const model = filteredModels[index];
				if (model) {
					if (selected.has(model.id)) selected.delete(model.id);
					else selected.add(model.id);
					refresh();
				}
				return;
			}
			if (keybindings.matches(data, "app.models.enableAll")) {
				const targets = input.getValue() ? filteredModels : models;
				for (const model of targets) selected.add(model.id);
				refresh();
				return;
			}
			if (keybindings.matches(data, "app.models.clearAll")) {
				const targets = input.getValue() ? filteredModels : models;
				for (const model of targets) selected.delete(model.id);
				refresh();
				return;
			}
			if (keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "app.models.save")) {
				done({ kind: "save", selectedIds: models.map((model) => model.id).filter((id) => selected.has(id)) });
				return;
			}
			if (keybindings.matches(data, "tui.select.cancel")) {
				done({ kind: "cancel" });
				return;
			}
			input.handleInput(data);
			applyFilter();
		};

		Object.defineProperty(container, "focused", {
			get: () => input.focused,
			set: (focused: boolean) => {
				input.focused = focused;
			},
		});

		return container;
	};
}

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
	visibleWidth,
	type TUI,
} from "@earendil-works/pi-tui";
import { DEFAULTS, truncate } from "./constants.ts";
import type { ModelsDevReference } from "./models-dev.ts";

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
		container.addChild(new Text(theme.fg("dim", "  Enter accept · Esc cancel"), 0, 0));
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

export interface LimitsEditorOptions {
	title: string;
	providerId?: string;
	contextWindow?: number;
	maxTokens?: number;
	/** An optional public-catalog lookup. It is display-only and never mutates inputs. */
	reference?: Promise<ModelsDevReference | undefined>;
}

export interface LimitsEditorResult {
	contextWindow?: number;
	maxTokens?: number;
}

/**
 * Two related limits deserve one editing surface. On wide terminals, the
 * public-catalog reference sits beside the inputs; on narrow ones it falls
 * below them. The reference intentionally has no "apply" action.
 */
export function createLimitsEditor(
	opts: LimitsEditorOptions,
): (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: LimitsEditorResult | undefined) => void,
) => Container {
	return (tui, theme, keybindings, done) => {
		const contextInput = new Input();
		const outputInput = new Input();
		contextInput.setValue(formatTokenLimit(opts.contextWindow));
		outputInput.setValue(formatTokenLimit(opts.maxTokens));
		let active: "context" | "output" = "context";
		let focused = false;
		let closed = false;
		let error: string | undefined;
		let reference: ModelsDevReference | undefined;
		let referenceState: "loading" | "ready" | "unavailable" = opts.reference ? "loading" : "ready";
		const topBorder = new DynamicBorder((text) => theme.fg("border", text));
		const bottomBorder = new DynamicBorder((text) => theme.fg("border", text));
		const container = new Container() as Container & {
			render: (width: number) => string[];
			handleInput: (data: string) => void;
			focused: boolean;
		};

		const syncFocus = () => {
			contextInput.focused = focused && active === "context";
			outputInput.focused = focused && active === "output";
		};
		const refresh = () => {
			container.invalidate();
			tui.requestRender();
		};
		const finish = (result: LimitsEditorResult | undefined) => {
			if (closed) return;
			closed = true;
			done(result);
		};
		const apply = () => {
			const context = parseTokenLimit(contextInput.getValue());
			const output = parseTokenLimit(outputInput.getValue());
			if (context.error || output.error) {
				error = context.error ? `Context window: ${context.error}` : `Maximum output tokens: ${output.error}`;
				refresh();
				return;
			}
			finish({ contextWindow: context.value, maxTokens: output.value });
		};
		const setActive = (field: "context" | "output") => {
			active = field;
			error = undefined;
			syncFocus();
			refresh();
		};

		contextInput.onSubmit = apply;
		outputInput.onSubmit = apply;
		if (opts.reference) {
			void opts.reference.then(
				(value) => {
					if (closed) return;
					reference = value;
					referenceState = "ready";
					refresh();
				},
				() => {
					if (closed) return;
					referenceState = "unavailable";
					refresh();
				},
			);
		}

		const inputLines = (width: number): string[] => {
			const inputWidth = Math.max(12, width - 4);
			const field = (label: string, input: Input, selected: boolean, fallback: number): string[] => [
				theme.fg(selected ? "accent" : "text", `  ${label}`),
				`  ${selected ? theme.fg("accent", "›") : " "} ${truncateToWidth(input.render(inputWidth)[0] ?? "", inputWidth)}`,
				theme.fg("dim", `    Empty uses Pi fallback · ${formatTokenLimit(fallback)}`),
			];
			const lines = [
				...field("Context window", contextInput, active === "context", DEFAULTS.contextWindow),
				"",
				...field("Maximum output tokens", outputInput, active === "output", DEFAULTS.maxTokens),
			];
			if (error) lines.push("", theme.fg("error", `  ${error}`));
			return lines.map((line) => truncateToWidth(line, width));
		};
		const referenceLines = (width: number): string[] => {
			const lines: string[] = [theme.fg("muted", "  models.dev · Reference only"), ""];
			if (referenceState === "loading") {
				lines.push(theme.fg("dim", "  Looking up a reference…"));
			} else if (referenceState === "unavailable") {
				lines.push(theme.fg("muted", "  Reference unavailable."));
				lines.push(theme.fg("dim", "  Limits still work normally."));
			} else if (!reference) {
				lines.push(theme.fg("muted", "  No reliable model match found."));
				lines.push(theme.fg("dim", "  Limits depend on this Provider route."));
			} else {
				lines.push(theme.fg("text", `  ${reference.providerName} / ${reference.modelName}`));
				if (reference.modelName !== reference.modelId) lines.push(theme.fg("muted", `  ${reference.modelId}`));
				lines.push(theme.fg("muted", `  ${reference.match === "exact" ? "Exact model ID" : "Similar model ID"}`), "");
				lines.push(
					theme.fg("muted", `  Context      ${reference.contextWindow ? formatTokenLimit(reference.contextWindow) : "Not listed"}`),
					theme.fg("muted", `  Max output   ${reference.maxTokens ? formatTokenLimit(reference.maxTokens) : "Not listed"}`),
					"",
					theme.fg("warning", "  May differ for this Provider"),
					theme.fg("warning", "  or gateway."),
				);
			}
			return lines.map((line) => truncateToWidth(line, width));
		};

		container.render = (width: number): string[] => {
			const lines = [...topBorder.render(width), "", truncateToWidth(theme.fg("accent", theme.bold(opts.title)), width)];
			if (opts.providerId) lines.push(truncateToWidth(theme.fg("muted", `  Provider · ${opts.providerId}`), width));
			lines.push("");

			if (width >= 96) {
				const divider = theme.fg("border", " │ ");
				const leftWidth = Math.max(38, Math.floor((width - 3) * 0.58));
				const rightWidth = Math.max(24, width - leftWidth - 3);
				const left = inputLines(leftWidth);
				const right = referenceLines(rightWidth);
				const rowCount = Math.max(left.length, right.length);
				for (let index = 0; index < rowCount; index++) {
					lines.push(`${padToWidth(left[index] ?? "", leftWidth)}${divider}${padToWidth(right[index] ?? "", rightWidth)}`);
				}
			} else {
				lines.push(...inputLines(width), "", ...referenceLines(width));
			}

			lines.push(
				"",
				truncateToWidth(
					theme.fg(
						"dim",
						`  ${keyHint("tui.input.tab", "next field")} · ${keyHint("tui.input.submit", "apply")} · ${keyHint("tui.select.cancel", "cancel")}`,
					),
					width,
				),
				"",
				...bottomBorder.render(width),
			);
			return lines;
		};
		container.handleInput = (data: string) => {
			if (keybindings.matches(data, "tui.input.tab")) {
				setActive(active === "context" ? "output" : "context");
				return;
			}
			if (keybindings.matches(data, "tui.select.cancel")) {
				finish(undefined);
				return;
			}
			error = undefined;
			(active === "context" ? contextInput : outputInput).handleInput(data);
			if (!closed) refresh();
		};
		Object.defineProperty(container, "focused", {
			get: () => focused,
			set: (value: boolean) => {
				focused = value;
				syncFocus();
			},
		});
		return container;
	};
}

export function formatTokenLimit(value: number | undefined): string {
	if (value === undefined) return "";
	if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`;
	if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`;
	return value.toLocaleString("en-US");
}

export function parseTokenLimit(value: string): { value?: number; error?: string } {
	const normalized = value.trim().replace(/[,_\s]/g, "");
	if (!normalized) return {};
	const match = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(normalized);
	if (!match) return { error: "Use a positive number such as 272K or 128000." };
	const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
	const parsed = Number(match[1]) * multiplier;
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return { error: "Use a positive whole number of tokens." };
	return { value: parsed };
}

function padToWidth(value: string, width: number): string {
	const truncated = truncateToWidth(value, width);
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
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
	/** Restores the cursor when a parent menu is reopened. */
	initialValue?: T;
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
		let selectedIndex = Math.max(0, allItems.findIndex((item) => item.value === opts.initialValue));
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

		const applyFilter = (query: string, preferredValue?: T) => {
			filteredItems = query
				? fuzzyFilter(
						allItems,
						query,
						(item) => item.searchText ?? `${item.label} ${item.description ?? ""} ${item.value}`,
					)
				: allItems;
			const preferredIndex = preferredValue
				? filteredItems.findIndex((item) => item.value === preferredValue)
				: -1;
			selectedIndex = preferredIndex >= 0 ? preferredIndex : 0;
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
					const currentValue = filteredItems[selectedIndex]?.value;
					input.setValue("");
					applyFilter("", currentValue);
					return;
				}
				done(undefined);
				return;
			}
			input.handleInput(data);
			applyFilter(input.getValue());
		};

		if (opts.initialQuery) input.handleInput(opts.initialQuery);
		applyFilter(opts.initialQuery ?? "", opts.initialValue);
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

		const applyFilter = (preferredValue?: string) => {
			const query = input.getValue();
			filteredItems = query
				? fuzzyFilter(items, query, (item) => item.searchText ?? `${item.label} ${item.value}`)
				: items;
			const preferredIndex = preferredValue
				? filteredItems.findIndex((item) => item.value === preferredValue)
				: -1;
			index = preferredIndex >= 0 ? preferredIndex : 0;
			offset = Math.max(0, index - viewport + 1);
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
					const currentValue = filteredItems[index]?.value;
					input.setValue("");
					applyFilter(currentValue);
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
		title: `Add fetched models · ${providerLabel}`,
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

interface ModelWorkspaceState {
	selectedIds: string[];
	cursorId?: string;
}

export type ModelWorkspaceResult =
	| ({ kind: "edit"; id: string } & ModelWorkspaceState)
	| ({ kind: "actions" | "add" | "discover" | "bulk" | "remove" } & ModelWorkspaceState)
	| ({ kind: "save" | "back" } & ModelWorkspaceState);

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
	initialCursorId?: string,
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
		let index = Math.max(0, allItems.findIndex((item) => item.id === initialCursorId));
		let offset = Math.max(0, index - 9);
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
		const cursorId = () => filteredItems[index]?.id ?? initialCursorId;
		const state = (): ModelWorkspaceState => ({ selectedIds: selectedIds(), cursorId: cursorId() });
		const refresh = () => {
			container.invalidate();
			tui.requestRender();
		};
		const keepVisible = () => {
			if (index < offset) offset = index;
			if (index >= offset + viewport) offset = index - viewport + 1;
		};
		const applyFilter = (preferredId?: string) => {
			const query = input.getValue();
			filteredItems = query
				? fuzzyFilter(allItems, query, (item) => item.searchText ?? `${item.label} ${item.id}`)
				: allItems;
			const preferredIndex = preferredId
				? filteredItems.findIndex((item) => item.id === preferredId)
				: -1;
			index = preferredIndex >= 0 ? preferredIndex : 0;
			offset = Math.max(0, index - viewport + 1);
			refresh();
		};

		container.render = (width: number): string[] => {
			const lines = [...topBorder.render(width), "", truncateToWidth(theme.fg("accent", theme.bold(title)), width)];
			lines.push(
				theme.fg(
					"muted",
					`  ${allItems.length} configured · ${selected.size} selected${dirty ? " · Unsaved changes" : ""}`,
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
				lines.push(theme.fg("muted", "  No models configured. Press a to add · f to fetch."));
			} else if (filteredItems.length === 0) {
				lines.push(theme.fg("muted", "  No matching models"));
			} else if (filteredItems.length > viewport) {
				lines.push(theme.fg("dim", `  showing ${offset + 1}–${end} of ${filteredItems.length}`));
			}
			lines.push("");
			lines.push(
				truncateToWidth(
					theme.fg("dim", "  Enter edit · Space select · a add · f fetch · / filter · Tab actions"),
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
				if (matchesKey(data, "a")) return done({ kind: "add", ...state() });
				if (matchesKey(data, "f")) return done({ kind: "discover", ...state() });
				if (selected.size > 0 && matchesKey(data, "e")) return done({ kind: "bulk", ...state() });
				if (selected.size > 0 && matchesKey(data, "d")) return done({ kind: "remove", ...state() });
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
				done({ kind: "actions", ...state() });
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
				done({ kind: "save", ...state() });
				return;
			}
			if (keybindings.matches(data, "tui.select.confirm")) {
				const item = filteredItems[index];
				if (item) done({ kind: "edit", id: item.id, ...state() });
				return;
			}
			if (keybindings.matches(data, "tui.select.cancel")) {
				if (input.getValue()) {
					const currentId = cursorId();
					input.setValue("");
					applyFilter(currentId);
					return;
				}
				if (searching) {
					searching = false;
					input.focused = false;
					refresh();
					return;
				}
				done({ kind: "back", ...state() });
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

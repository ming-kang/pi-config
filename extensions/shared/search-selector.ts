import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, truncateToWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { ruleBorder } from "./dialog-primitives.ts";
import { WidthCachedRender } from "./render-cache.ts";

export interface SearchSelectorItem<TChoice> {
	key: string;
	choice: TChoice;
	label: string;
	searchText: string;
	detail?: string;
	current?: boolean;
	selectionLabel?: string;
}

export interface SearchSelectorOptions {
	helpText?: string;
	noMatchesText?: string;
	maxVisibleItems?: number;
}

export class SearchSelectorComponent<TChoice> implements Component, Focusable {
	private searchInput = new Input();
	private filteredItems: SearchSelectorItem<TChoice>[];
	private selectedIndex = 0;
	private readonly maxVisibleItems: number;
	private readonly helpText: string;
	private readonly noMatchesText: string;
	private _focused = false;
	// Width-keyed render cache: drops the previous output on any keystroke or
	// state change. Mirrors question/dialog's cache (see render-cache.ts).
	private cache = new WidthCachedRender();

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
		this.cache.invalidate();
	}

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly title: string,
		private readonly items: SearchSelectorItem<TChoice>[],
		private readonly done: (choice: TChoice | undefined) => void,
		options: SearchSelectorOptions = {},
	) {
		this.filteredItems = items;
		this.maxVisibleItems = options.maxVisibleItems ?? 8;
		this.helpText = options.helpText ?? "Type to search • Enter to select • Esc to cancel • ↑↓ to move";
		this.noMatchesText = options.noMatchesText ?? "No matches";
	}

	invalidate(): void {
		this.cache.invalidate();
	}

	handleInput(data: string): void {
		// Any keystroke may change the input cursor, filter, or selection —
		// drop the render cache so the next render recomputes.
		this.cache.invalidate();
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.input.submit") || data === "\n") {
			this.commitSelection();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}

		this.searchInput.handleInput(data);
		this.applyFilter(this.searchInput.getValue());
	}

	render(width: number): string[] {
		return this.cache.get(width, (w) => this.compute(w));
	}

	private compute(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const lines: string[] = [];
		const titleLine = ` ${this.theme.fg("accent", this.theme.bold(this.title))}`;
		const helpLine = ` ${this.theme.fg("muted", this.helpText)}`;

		lines.push(ruleBorder(this.theme, renderWidth));
		lines.push(truncateToWidth(titleLine, renderWidth, ""));
		lines.push(truncateToWidth(helpLine, renderWidth, ""));
		lines.push("");
		lines.push(...this.searchInput.render(renderWidth));
		lines.push("");

		if (this.filteredItems.length === 0) {
			lines.push(truncateToWidth(`  ${this.theme.fg("warning", this.noMatchesText)}`, renderWidth, ""));
		} else {
			const startIndex = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(this.maxVisibleItems / 2), this.filteredItems.length - this.maxVisibleItems),
			);
			const endIndex = Math.min(startIndex + this.maxVisibleItems, this.filteredItems.length);

			for (let index = startIndex; index < endIndex; index++) {
				const item = this.filteredItems[index];
				if (!item) continue;
				lines.push(truncateToWidth(this.renderItem(item, index === this.selectedIndex, renderWidth), renderWidth, ""));
			}

			if (startIndex > 0 || endIndex < this.filteredItems.length) {
				lines.push(
					truncateToWidth(
						`  ${this.theme.fg("muted", `(${this.selectedIndex + 1}/${this.filteredItems.length})`)}`,
						renderWidth,
						"",
					),
				);
			}
		}

		const selected = this.filteredItems[this.selectedIndex];
		if (selected?.detail) {
			lines.push("");
			lines.push(truncateToWidth(`  ${this.theme.fg("muted", selected.detail)}`, renderWidth, ""));
		}

		lines.push(ruleBorder(this.theme, renderWidth));
		return lines;
	}

	private renderItem(item: SearchSelectorItem<TChoice>, isSelected: boolean, width: number): string {
		const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
		const labelColor = isSelected ? "accent" : item.current ? "success" : "text";
		const label = this.theme.fg(labelColor, item.label);
		const detail = item.detail ? this.theme.fg("muted", ` [${item.detail}]`) : "";
		const currentMark = item.current ? this.theme.fg("success", " ✓") : "";
		const line = `${prefix}${label}${detail}${currentMark}`;
		return isSelected
			? this.theme.bg("selectedBg", truncateToWidth(line, width, "", true))
			: truncateToWidth(line, width, "");
	}

	private applyFilter(query: string): void {
		const selected = this.filteredItems[this.selectedIndex];
		const selectedKey = selected?.key;
		const trimmed = query.trim();
		this.filteredItems = trimmed ? fuzzyFilter(this.items, trimmed, (item) => item.searchText) : this.items;
		const nextIndex = selectedKey ? this.filteredItems.findIndex((item) => item.key === selectedKey) : -1;
		this.selectedIndex = nextIndex >= 0 ? nextIndex : 0;
		this.tui.requestRender();
	}

	private moveSelection(delta: number): void {
		if (this.filteredItems.length === 0) return;
		const nextIndex = this.selectedIndex + delta;
		this.selectedIndex = (nextIndex + this.filteredItems.length) % this.filteredItems.length;
		this.tui.requestRender();
	}

	private commitSelection(): void {
		const selected = this.filteredItems[this.selectedIndex];
		if (!selected) return;
		this.done(selected.choice);
	}

	private cancel(): void {
		this.done(undefined);
	}
}

/**
 * dialog-primitives.ts — low-level render primitives for custom TUI dialogs.
 *
 * `question/dialog.ts` and `shared/search-selector.ts` both hand-roll the same
 * building blocks: an accent `─` rule border, ANSI-aware wrapped text with a
 * hanging prefix, and a focused/selected row padded to full width with the
 * `selectedBg` background. This module factors those three out so the two
 * dialogs share one implementation. Higher-level dialog semantics (multi-step
 * state, option markers, search filtering) stay in each dialog — these are
 * pure render helpers.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/**
 * A full-width accent rule line: `theme.fg("accent", "─".repeat(width))`.
 * The exact top/bottom border both dialogs already draw.
 */
export function ruleBorder(theme: Theme, width: number, color: ThemeColor = "accent"): string {
	return theme.fg(color, "─".repeat(Math.max(0, width)));
}

/**
 * Wrap `text` (which may contain ANSI codes) to `width`, prefixing the first
 * line with `prefix` and continuation lines with spaces equal to the prefix's
 * visible width. Pushes the resulting lines into `out`.
 *
 * Mirrors `addWrappedWithPrefix` in `question/dialog.ts`. If the prefix itself
 * is wider than `width`, the prefix + text is wrapped at `width` as a fallback
 * (no hanging indent possible).
 */
export function wrapWithPrefix(prefix: string, text: string, width: number, out: string[]): void {
	const prefixWidth = visibleWidth(prefix);
	if (prefixWidth >= width) {
		for (const line of wrapTextWithAnsi(prefix + text, width)) out.push(line);
		return;
	}
	const wrapped = wrapTextWithAnsi(text, width - prefixWidth);
	const continuation = " ".repeat(prefixWidth);
	for (let i = 0; i < wrapped.length; i++) {
		out.push(`${i === 0 ? prefix : continuation}${wrapped[i]}`);
	}
}

/**
 * Render a focused/selected row: `${prefix}${text}` truncated to `width`, and
 * when `selected`, padded to full width and given the `selectedBg` background so
 * the highlight bar spans the whole row (not just the text). Unselected rows are
 * returned bare (the caller/TUI clears the rest of the line).
 *
 * `selectedBgKey` defaults to `"selectedBg"`. Exposed so a dialog could use a
 * different background key if needed; both current call sites use the default.
 */
export function focusedRow(
	prefix: string,
	text: string,
	theme: Theme,
	width: number,
	selected: boolean,
	selectedBgKey: ThemeColor = "selectedBg",
): string {
	const line = `${prefix}${text}`;
	return selected
		? theme.bg(selectedBgKey, truncateToWidth(line, width, "", true))
		: truncateToWidth(line, width, "");
}

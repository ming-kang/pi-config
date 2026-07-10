/**
 * dialog-primitives.ts — low-level render primitives for custom TUI dialogs.
 *
 * `question/dialog.ts` needs the same building blocks as any future custom
 * dialog: an accent `─` rule border and ANSI-aware wrapped text with a hanging
 * prefix. Higher-level dialog semantics (multi-step state, option markers)
 * stay in each dialog — these are pure render helpers.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/**
 * A full-width accent rule line: `theme.fg("accent", "─".repeat(width))`.
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

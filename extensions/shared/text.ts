/**
 * text.ts — shared small text helpers.
 *
 * Consolidates two patterns that were duplicated across extensions:
 *   - `firstLine(text, fallback)` — the `text.split("\n")[0] || fallback` idiom
 *     used by 5 collapsed-error renderers (advisor, todo, tools-view read/edit/write).
 *   - `truncateText(text, max, opts?)` — a thin wrapper over pi-tui's
 *     `truncateToWidth`/string slicing, replacing 3 local `truncate` defs
 *     (deepwiki x2, rewind x1). Default ellipsis is `...` (SPEC F6: pi-config's
 *     canonical ellipsis, matching `truncateToWidth`'s default).
 *
 * Pure string logic, no theme/UI.
 */

/**
 * Return the first line of `text`, or `fallback` if the first line is empty
 * (falsy) or the text is empty. Matches the existing
 * `text.split("\n")[0] || fallback` sites, so an empty first line falls through
 * to the fallback (intentional `||`, not `??`).
 */
export function firstLine(text: string, fallback: string): string {
	return text.split("\n")[0] || fallback;
}

export interface TruncateTextOptions {
	/** Truncate at a word boundary when possible (last space before the cut). */
	word?: boolean;
	/** Ellipsis to append when truncated. Defaults to `...` (SPEC F6). */
	ellipsis?: string;
}

/**
 * Truncate `text` to at most `max` visible characters, appending the ellipsis
 * when truncation occurs. With `word: true`, cuts at the last space within the
 * prefix (falling back to a hard cut if no space is found early enough).
 *
 * Replaces deepwiki's `truncate` (max=120) and `truncateAtWord`, and rewind's
 * `truncate` (whitespace-collapsed). Callers pass their own `max`.
 */
export function truncateText(text: string, max: number, opts: TruncateTextOptions = {}): string {
	const ellipsis = opts.ellipsis ?? "...";
	if (text.length <= max) return text;
	const ellipsisLen = ellipsis.length;
	if (ellipsisLen >= max) return ellipsis.slice(0, max);

	const prefix = text.slice(0, max - ellipsisLen);
	if (opts.word) {
		const lastSpace = prefix.lastIndexOf(" ");
		// Only honor a word boundary if it leaves a reasonable amount of text;
		// otherwise a hard cut is more honest than a tiny stub + ellipsis.
		if (lastSpace >= Math.floor(max * 0.4)) {
			return `${prefix.slice(0, lastSpace)}${ellipsis}`;
		}
	}
	return `${prefix}${ellipsis}`;
}

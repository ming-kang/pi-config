/**
 * contents.ts — page-boundary truncation for deepwiki `contents` responses.
 *
 * Zero-import pure module so `node scratch/<x>.ts` can drive it directly (this
 * repo has no node_modules; bare-package imports would fail to resolve there).
 * client.ts imports PAGE_HEADER_RE from here, so page-title extraction and
 * truncation chunking share one definition and cannot drift apart.
 *
 * Model-facing output must stay bounded: a full generated wiki can reach
 * hundreds of KB. Past CONTENTS_CHAR_BUDGET the text is cut at "# Page:"
 * boundaries — whole pages are kept in order, at least the beginning of the
 * first page always survives — and a trailing notice states what was omitted
 * and how to get it (call again with action "question").
 *
 * Determinism matters: callDeepWiki caches the FULL response and the caller
 * re-truncates on every call, so cached and fresh calls must produce
 * byte-identical text. Pure function + constant budget guarantees that.
 */

/** Page-header line of a DeepWiki contents response ("# Page: <title>"). */
export const PAGE_HEADER_RE = /^#\s+Page:\s+(.+)$/;

export const CONTENTS_CHAR_BUDGET = 120_000;

/** Cap for omitted page titles inside the notice — the notice itself is bounded. */
const OMITTED_TITLES_MAX = 20;

export interface ContentsTruncation {
	/** Truncated body plus trailing notice; equals the input when not truncated. */
	text: string;
	truncated: boolean;
	/** Page chunks found in the full text (0 = no "# Page:" markers). */
	totalPages: number;
	/** Pages fully or partially shown (a mid-page cut still counts its page). */
	shownPages: number;
	/** Body characters dropped by the cut (the notice is not counted). */
	truncatedChars: number;
}

interface PageChunk {
	title: string;
	start: number;
}

/** Locate every page-header line as a character offset into the full text. */
function pageOffsets(text: string): PageChunk[] {
	const re = new RegExp(PAGE_HEADER_RE.source, "gm");
	const chunks: PageChunk[] = [];
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		chunks.push({ title: match[1]!.trim(), start: match.index });
	}
	return chunks;
}

/**
 * Hard-cut `text` to at most `budget` chars, preferring the last newline within
 * the budget so the cut lands between lines. A newline too close to the start
 * (< 40% of the budget) is ignored — a hard cut keeps more content than a tiny
 * stub, mirroring shared/text.ts's word-boundary heuristic.
 */
function cutAtLineBoundary(text: string, budget: number): string {
	if (text.length <= budget) return text;
	const slice = text.slice(0, budget);
	const lastNewline = slice.lastIndexOf("\n");
	return lastNewline >= Math.floor(budget * 0.4) ? slice.slice(0, lastNewline) : slice;
}

function buildNotice(opts: {
	shownPages: number;
	totalPages: number;
	keptChars: number;
	fullChars: number;
	omittedTitles: string[];
	partialLastPage: boolean;
}): string {
	const pagesPart =
		opts.totalPages > 0 ? `showing ${opts.shownPages} of ${opts.totalPages} pages` : "showing the beginning";
	const lines = [`[DeepWiki contents truncated — ${pagesPart} (${opts.keptChars} of ${opts.fullChars} chars).`];
	if (opts.partialLastPage) lines.push("The last shown page is itself truncated.");
	if (opts.omittedTitles.length > 0) {
		const shown = opts.omittedTitles.slice(0, OMITTED_TITLES_MAX).join("; ");
		const more = opts.omittedTitles.length - OMITTED_TITLES_MAX;
		lines.push(`Omitted pages: ${shown}${more > 0 ? ` … +${more} more` : ""}.`);
	}
	const target = opts.totalPages > 0 ? "material from the omitted pages" : "specific topics";
	lines.push(`For ${target}, call deepwiki again with action "question" and a focused question.]`);
	return lines.join("\n");
}

/**
 * Truncate a contents response to `budget` chars at page boundaries and append
 * an omission notice. Below budget the input is returned untouched.
 */
export function truncateContentsByPages(text: string, budget = CONTENTS_CHAR_BUDGET): ContentsTruncation {
	const chunks = pageOffsets(text);
	const totalPages = chunks.length;

	if (text.length <= budget) {
		return { text, truncated: false, totalPages, shownPages: totalPages, truncatedChars: 0 };
	}

	let kept: string;
	let shownPages: number;
	let partialLastPage = false;

	if (totalPages === 0) {
		// No page markers: treat the whole text as one block and cut at a line.
		kept = cutAtLineBoundary(text, budget);
		shownPages = 0;
	} else {
		// Accumulate the preamble (anything before the first marker) plus whole
		// pages, in order, while they fit.
		const preambleEnd = chunks[0]!.start;
		shownPages = 0;
		let end = preambleEnd;
		for (let i = 0; i < chunks.length; i++) {
			const pageEnd = i + 1 < chunks.length ? chunks[i + 1]!.start : text.length;
			if (pageEnd > budget) break;
			end = pageEnd;
			shownPages++;
		}
		if (shownPages === 0) {
			// Even the first page does not fit: cut inside it so at least the
			// document head and the first page's opening survive.
			kept = cutAtLineBoundary(text, budget);
			shownPages = 1;
			partialLastPage = true;
		} else {
			kept = text.slice(0, end);
		}
	}

	const omittedTitles = chunks.slice(shownPages).map((chunk) => chunk.title);
	const notice = buildNotice({
		shownPages,
		totalPages,
		keptChars: kept.length,
		fullChars: text.length,
		omittedTitles,
		partialLastPage,
	});

	return {
		text: `${kept}\n\n${notice}`,
		truncated: true,
		totalPages,
		shownPages,
		truncatedChars: text.length - kept.length,
	};
}

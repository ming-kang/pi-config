/**
 * budget.ts — char-budget estimation and packet trimming for the advisor.
 *
 * Zero-import pure module so `node scratch/<x>.ts` can drive it directly (this
 * repo has no node_modules; bare-package imports would fail to resolve there).
 *
 * The advisor packet is one-shot: by default the selected session context is
 * sent verbatim. These helpers add the fuse — estimate how many characters fit
 * the reviewer's context window, and when the packet exceeds that, water-fill
 * trim only the tool-result segments (user/executor messages carry the intent
 * and conclusions; tool results are the bulk).
 */

/** Conservative window when the model registry has no usable contextWindow. */
export const FALLBACK_CONTEXT_TOKENS = 32_000;
/** Conservative output reserve when the model has no usable maxTokens. */
export const FALLBACK_OUTPUT_RESERVE_TOKENS = 8_192;
/**
 * Chars per token for the input estimate. Tool output (code, paths, logs)
 * runs ~3-3.5 chars/token; 3 underestimates the fit and thus over-reserves,
 * which is the safe direction. CJK-heavy context can still under-count tokens,
 * but that failure mode is the same provider error the try/catch already
 * handles — just rarer than with no fuse at all.
 */
export const BUDGET_CHARS_PER_TOKEN = 3;
export const BUDGET_SAFETY = 0.9;
/** Floor against pathological registry data (e.g. maxTokens == contextWindow). */
export const MIN_CHAR_BUDGET = 20_000;

/** Reserved headroom for the in-packet truncation notice. */
const NOTICE_ALLOWANCE = 400;
/** Below this many chars per trimmable segment, trimming cannot help. */
const MIN_SEGMENT_CHARS = 64;
/** Per-segment budget assumed for the inline marker when computing the keep. */
const MARKER_BUDGET = 32;

export const TRIM_MARKER = (droppedChars: number): string => `\n[... truncated ${droppedChars} chars]`;

/**
 * Estimate the packet char budget for a reviewer model. The output reserve
 * must match what the request will actually ask for: completeSimple is called
 * without a maxTokens override, so providers request the model's own default —
 * deliberately not shrunk here, that would cut into reasoning budgets.
 */
export function advisorCharBudget(contextWindow: number | undefined, maxTokens: number | undefined): number {
	const window = contextWindow && contextWindow > 0 ? contextWindow : FALLBACK_CONTEXT_TOKENS;
	const reserve = maxTokens && maxTokens > 0 ? maxTokens : FALLBACK_OUTPUT_RESERVE_TOKENS;
	const usableTokens = Math.max(0, window - reserve);
	return Math.max(MIN_CHAR_BUDGET, Math.floor(usableTokens * BUDGET_CHARS_PER_TOKEN * BUDGET_SAFETY));
}

export interface PacketSegment {
	text: string;
	/** Only tool-result segments are trimmable; user/executor text never is. */
	trimmable: boolean;
}

export interface TrimResult {
	/** Segment texts in input order; untouched when nothing was trimmed. */
	texts: string[];
	trimmedSegments: number;
	trimmedChars: number;
	/** True when the packet cannot fit even with all trimmable segments cut. */
	overBudget: boolean;
}

/**
 * Fit segments into `budget`. `fixedChars` is everything outside the segments
 * (brief, headers, joins); untrimmable segments count against the budget but
 * are never modified. Water-fill: short trimmable segments survive whole,
 * segments above the common cap are head-truncated (their "### N. Tool Result"
 * headers live at the start) with an inline marker reporting the dropped chars.
 */
export function trimPacketSegments(segments: PacketSegment[], fixedChars: number, budget: number): TrimResult {
	const texts = segments.map((segment) => segment.text);
	const trimmableIdx: number[] = [];
	let untrimmableChars = 0;
	for (let i = 0; i < segments.length; i++) {
		if (segments[i]!.trimmable) trimmableIdx.push(i);
		else untrimmableChars += texts[i]!.length;
	}
	const trimmableChars = trimmableIdx.reduce((sum, i) => sum + texts[i]!.length, 0);

	if (fixedChars + untrimmableChars + trimmableChars <= budget) {
		return { texts, trimmedSegments: 0, trimmedChars: 0, overBudget: false };
	}

	const toolBudget = budget - fixedChars - untrimmableChars - NOTICE_ALLOWANCE;
	if (trimmableIdx.length === 0 || toolBudget < trimmableIdx.length * MIN_SEGMENT_CHARS) {
		return { texts, trimmedSegments: 0, trimmedChars: 0, overBudget: true };
	}

	// Water-fill: scan lengths ascending; segments at or below the running even
	// share are kept whole, the rest are capped at that share. The share is
	// monotonically non-decreasing, so the first iteration's floor
	// (toolBudget / n >= MIN_SEGMENT_CHARS) bounds the final cap from below.
	const lens = trimmableIdx.map((i) => texts[i]!.length).sort((a, b) => a - b);
	let remaining = toolBudget;
	let cap = Number.POSITIVE_INFINITY;
	for (let k = 0; k < lens.length; k++) {
		const even = Math.floor(remaining / (lens.length - k));
		if (lens[k]! <= even) {
			remaining -= lens[k]!;
		} else {
			cap = even;
			break;
		}
	}
	if (!Number.isFinite(cap)) {
		// All segments fit toolBudget — the overshoot is entirely in the fixed
		// part, which trimming cannot fix.
		return { texts, trimmedSegments: 0, trimmedChars: 0, overBudget: true };
	}

	let trimmedSegments = 0;
	let trimmedChars = 0;
	for (const i of trimmableIdx) {
		const len = texts[i]!.length;
		if (len <= cap) continue;
		const keep = Math.max(1, cap - MARKER_BUDGET);
		const dropped = len - keep;
		texts[i] = texts[i]!.slice(0, keep) + TRIM_MARKER(dropped);
		trimmedSegments++;
		trimmedChars += dropped;
	}
	return { texts, trimmedSegments, trimmedChars, overBudget: false };
}

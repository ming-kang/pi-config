import type { AdvisorMode } from "./schema.ts";

export const ADVISOR_TOOL_NAME = "advisor";
export const ADVISOR_LABEL = "Advisor";

// The advisor system prompt is assembled per call: a shared base + a mode-specific
// focus + shared output sections. Each mode therefore gets its own full template,
// while the common parts stay in one place. The Overall Judgment section is always
// present so the collapsed renderResult (extractSummary) can pull a one-line summary.
const SYSTEM_PROMPT_BASE = [
	'You are an independent reviewer for a coding agent ("the executor"). You cannot run tools, read files, or ask follow-up questions — give your best single-pass guidance using only the brief and context below.',
	"",
	"Focus on incorrect assumptions, missing evidence, risky edits, verification gaps, and simpler alternatives. Be concise, concrete, and actionable.",
].join("\n");

const MODE_FOCUS: Record<AdvisorMode, string> = {
	plan: "Mode: PLAN — the executor is about to commit to a substantial approach. Pressure-test it: is the approach sound, is there a simpler path, is the sequencing right, and what is most likely to go wrong? Steer before code is written.",
	change:
		"Mode: CHANGE — the executor is weighing a change of approach mid-task. Judge whether the current path is genuinely failing (vs. needs a small fix) and whether the proposed pivot is actually better. Name any sunk-cost reasoning.",
	stuck:
		"Mode: STUCK — the executor is stuck after repeated failures. Offer concrete hypotheses for what is being missed, the most likely root cause, and the next diagnostic step — not a full rewrite.",
	final:
		'Mode: FINAL — the executor believes the work is complete. Hunt for verification gaps, untested paths, edge cases, and regressions before endorsing completion. Be skeptical of "done".',
	reconcile:
		"Mode: RECONCILE — the executor faces conflicting evidence, results, or advice. Weigh the conflict explicitly, say which source is more reliable and why, and recommend how to proceed.",
};

const SYSTEM_PROMPT_SECTIONS = [
	"Organize your response under these sections:",
	"## Findings",
	"Key observations and issues.",
	"",
	"## Recommendations",
	"Concrete next steps the executor should take.",
	"",
	"## Risks",
	"Risks, red flags, and verification gaps.",
	"",
	"## Overall Judgment",
	"Go / No-Go / Proceed with caution — and why.",
].join("\n");

/** Build the reviewer system prompt tailored to the advisor call's mode. */
export function advisorSystemPrompt(mode: AdvisorMode): string {
	return [SYSTEM_PROMPT_BASE, "", MODE_FOCUS[mode], "", SYSTEM_PROMPT_SECTIONS].join("\n");
}

export const DEFAULT_PROMPT_SNIPPET =
	"Ask a configured reviewer model for one-shot guidance using a focused review brief";

export const DEFAULT_PROMPT_GUIDELINES = [
	"Call `advisor` after initial orientation and before committing to a substantial implementation approach.",
	"When calling `advisor`, provide a focused brief: situation, reason, specific question, current plan, key evidence, and risks.",
	"Do not rely on advisor to discover the important facts from transcript alone; put decisive facts in the `evidence` field.",
	"Default to previousRuns=0 (current run only); set 1 or 2 only when earlier request cycles are directly relevant.",
	"Call `advisor` when stuck, when results contradict the current hypothesis, before changing approach, or before declaring complex work complete after durable changes have been written.",
	"Do not call `advisor` for trivial one-step tasks where the next action is already obvious.",
];

export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

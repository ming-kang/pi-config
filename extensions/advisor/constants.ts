import type { AdvisorMode } from "./schema.ts";

export const ADVISOR_TOOL_NAME = "advisor";
export const ADVISOR_LABEL = "Advisor";

export const ADVISOR_DESCRIPTION =
	"Request a one-shot review from an independent reviewer model at a high-leverage checkpoint. Modes: plan (pressure-test an approach before committing), change (judge a mid-task pivot), stuck (fresh hypotheses after repeated failures), final (hunt verification gaps before declaring done), reconcile (weigh conflicting evidence or advice). The reviewer cannot run tools or ask follow-ups — it sees only your brief plus bounded session context, so put every decisive fact in the brief: situation, reason, one concrete question, currentPlan, evidence, risks. Not for trivial tasks or facts local read/grep/tests can verify directly.";

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
	"One-shot independent review at planning, pivot, stuck, reconcile, or final-verification checkpoints";

export const DEFAULT_PROMPT_GUIDELINES = [
	"Call `advisor` at high-leverage checkpoints of complex, risky, or ambiguous work: before committing to a substantial approach, before pivoting, when stuck after repeated failures, when evidence conflicts, and before declaring non-trivial work done.",
	"Do not call `advisor` for trivial one-step tasks, obvious next actions, or facts that local read/grep/test tools can verify directly.",
	"Put decisive facts in the `advisor` brief itself (evidence, risks, currentPlan) — the reviewer cannot run tools or ask follow-up questions.",
];

export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

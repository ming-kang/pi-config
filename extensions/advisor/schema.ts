import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const ADVISOR_MODES = ["plan", "change", "stuck", "final", "reconcile"] as const;

const AdvisorModeSchema = StringEnum(ADVISOR_MODES, {
	description:
		"Advisor review mode: plan before committing to an approach, change before pivoting, stuck after repeated failures, final before declaring complex work done, and reconcile for conflicting evidence or advice.",
});

export const AdvisorParamsSchema = Type.Object({
	mode: AdvisorModeSchema,
	situation: Type.String({
		description: "Brief current task state: what the user asked, what has been found or changed, and where execution stands now.",
	}),
	reason: Type.String({
		description: "Explain why an independent review is useful now, such as complexity, risk, contradiction, stuck state, pivot, or final check.",
	}),
	question: Type.String({
		description: "Specific judgment or decision requested from advisor. Ask one concrete review question, not a broad invitation to comment.",
	}),
	currentPlan: Type.Optional(
		Type.String({
			description: "The executor's intended next step or approach for advisor to challenge, confirm, or refine.",
		}),
	),
	evidence: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Key facts already verified by the executor: files/paths, command results, observations, constraints, or user requirements. Prefer decisive evidence over transcript summaries.",
		}),
	),
	risks: Type.Optional(
		Type.Array(Type.String(), {
			description: "Known risks, uncertainties, tradeoffs, edge cases, failure modes, or verification gaps advisor should check.",
		}),
	),
	previousRuns: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: 2,
			description:
				"Number of previous user-request cycles to include before the current run. Use 0 by default; use 1 or 2 only when earlier cycles directly affect this review.",
		}),
	),
});

export type AdvisorParams = Static<typeof AdvisorParamsSchema>;
export type AdvisorMode = (typeof ADVISOR_MODES)[number];

/** Clamp the requested previous-run count to the supported 0–2 range (default 0). */
export function clampPreviousRuns(value: number | undefined): number {
	return Math.max(0, Math.min(2, value ?? 0));
}

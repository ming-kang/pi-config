import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const ADVISOR_MODES = ["plan", "change", "stuck", "final", "reconcile"] as const;

const AdvisorModeSchema = StringEnum(ADVISOR_MODES, {
		description:
			"Why advisor is being called: plan before a substantial approach, change before changing approach, stuck for repeated failures, final before declaring complex work done, reconcile for conflicting evidence or advice.",
});

export const AdvisorParamsSchema = Type.Object({
	mode: AdvisorModeSchema,
	situation: Type.String({
		description: "Briefly state what is happening now and where the task stands.",
	}),
	reason: Type.String({
		description: "Explain why advisor is useful at this point.",
	}),
	question: Type.String({
		description: "The specific judgment or decision requested from advisor.",
	}),
	currentPlan: Type.Optional(
		Type.String({
			description: "The executor's intended next step or approach, if there is one.",
		}),
	),
	evidence: Type.Optional(
		Type.Array(Type.String(), {
			description: "Key facts, observations, files, command results, or constraints already known to the executor.",
		}),
	),
	risks: Type.Optional(
		Type.Array(Type.String(), {
			description: "Known risks, uncertainties, tradeoffs, or failure modes advisor should check.",
		}),
	),
	previousRuns: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: 2,
			description:
				"How many previous user-request cycles to include before the current run. 0 (default) = current run only; 1 or 2 also include that many prior runs.",
		}),
	),
});

export type AdvisorParams = Static<typeof AdvisorParamsSchema>;
export type AdvisorMode = (typeof ADVISOR_MODES)[number];

/** Clamp the requested previous-run count to the supported 0–2 range (default 0). */
export function clampPreviousRuns(value: number | undefined): number {
	return Math.max(0, Math.min(2, value ?? 0));
}

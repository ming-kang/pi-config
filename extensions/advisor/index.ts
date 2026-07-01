/**
 * advisor — Pi-native reviewer side-call.
 *
 * The advisor tool forwards the current resolved session context to a
 * separately configured reviewer model via Pi's own model registry and
 * provider auth. It intentionally gives the reviewer no tools.
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildStandardRenderer } from "../tools-view/shared.ts";
import { firstLine } from "../shared/text.ts";

import {
	ADVISOR_LABEL,
	ADVISOR_TOOL_NAME,
	DEFAULT_PROMPT_GUIDELINES,
	DEFAULT_PROMPT_SNIPPET,
} from "./constants.ts";
import { executeAdvisor, type AdvisorDetails } from "./execute.ts";
import { registerAdvisorCommand } from "./command.ts";
import { modelKey } from "./config.ts";
import { getAdvisorEffort, getAdvisorModel, reconcileAdvisorTool, restoreAdvisorState } from "./restore.ts";
import { AdvisorParamsSchema } from "./schema.ts";

function stripBold(text: string): string {
	return text.replace(/\*\*/g, "");
}

function extractSummary(text: string): string {
	const lines = text.split("\n");

	// Prefer the Overall Judgment line — it's the most informative signal.
	const judgmentIdx = lines.findIndex((l) => /^##\s*Overall\s+Judgment/i.test(l));
	if (judgmentIdx >= 0) {
		const after = lines
			.slice(judgmentIdx + 1)
			.find((l) => l.trim().length > 0 && !l.startsWith("##"));
		if (after) return stripBold(after).trim();
	}

	// Fallback: first non-empty content line (not a heading).
	const firstContent = lines.find((l) => l.trim().length > 0 && !/^##/.test(l));
	if (firstContent) return stripBold(firstContent).trim();

	// Last resort: first non-empty line.
	const first = lines.find((l) => l.trim().length > 0);
	if (!first) return "Advisor response";
	return stripBold(first.replace(/^###?\s+/, "")).trim();
}

const ADVISOR_RENDERER = buildStandardRenderer<AdvisorDetails>({
	name: "Advisor",
	callSuffix: (_args, _theme) => {
		const advisor = getAdvisorModel();
		const effort = getAdvisorEffort();
		return advisor ? `${modelKey(advisor)}${effort ? ` · ${effort}` : ""}` : "";
	},
	partialLabel: (details, _theme) => ` Consulting ${details?.advisorModel ?? ""}...`,
	errorMessage: (text, _details) => firstLine(text, "advisor call failed"),
	collapsedLine: (text, _details, _theme) => extractSummary(text),
});

export default function advisor(pi: ExtensionAPI): void {
	pi.registerTool({
		name: ADVISOR_TOOL_NAME,
		label: ADVISOR_LABEL,
		description:
			"Ask a configured reviewer model for one-shot guidance. Provide a focused review brief; the extension attaches bounded session context.",
		promptSnippet: DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: DEFAULT_PROMPT_GUIDELINES,
		parameters: AdvisorParamsSchema,
		renderShell: "self",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeAdvisor(params, ctx, signal, onUpdate);
		},

		renderCall: ADVISOR_RENDERER.renderCall,
		renderResult: ADVISOR_RENDERER.renderResult,
	});

	registerAdvisorCommand(pi);

	pi.on("session_start", async (_event, ctx) => {
		restoreAdvisorState(pi, ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		reconcileAdvisorTool(pi, ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		reconcileAdvisorTool(pi, ctx);
	});
}

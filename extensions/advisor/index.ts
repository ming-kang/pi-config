/**
 * advisor — Pi-native reviewer side-call.
 *
 * The advisor tool forwards the current resolved session context to a
 * separately configured reviewer model via Pi's own model registry and
 * provider auth. It intentionally gives the reviewer no tools.
 */
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

import { activeDotLine, callLine, errLine, resultLine } from "../tools-view/shared.ts";

import {
	ADVISOR_LABEL,
	ADVISOR_TOOL_NAME,
	DEFAULT_PROMPT_GUIDELINES,
	DEFAULT_PROMPT_SNIPPET,
} from "./constants.ts";
import { executeAdvisor, type AdvisorDetails } from "./execute.ts";
import { registerAdvisorCommand } from "./command.ts";
import { modelKey } from "./config.ts";
import { reconcileAdvisorTool } from "./reconcile.ts";
import { restoreAdvisorState } from "./restore.ts";
import { AdvisorParamsSchema } from "./schema.ts";
import { getAdvisorEffort, getAdvisorModel } from "./state.ts";

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

		renderCall(_args, theme) {
			const advisor = getAdvisorModel();
			const effort = getAdvisorEffort();
			const suffix = advisor ? `${modelKey(advisor)}${effort ? ` · ${effort}` : ""}` : "";
			return new Text(callLine("Advisor", suffix, theme), 0, 0);
		},

		renderResult(result, options, theme, ctx) {
			const details = result.details as AdvisorDetails | undefined;
			const block = result.content.find((part) => part.type === "text");
			const text = block?.type === "text" ? block.text : "";

			if (options.isPartial) {
				const modelInfo = details?.advisorModel ?? "";
				return new Text(activeDotLine("Advisor", ` Consulting ${modelInfo}…`, theme), 0, 0);
			}

			if (ctx.isError || details?.errorMessage) {
				const msg = text.split("\n")[0] || "advisor call failed";
				return new Text(errLine(msg, theme), 0, 0);
			}

			if (!options.expanded) {
				return new Text(resultLine(theme.fg("accent", extractSummary(text)), theme), 0, 0);
			}

			const container = new Container();
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(text, 1, 0, getMarkdownTheme()));
			return container;
		},
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

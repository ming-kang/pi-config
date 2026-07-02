/**
 * question — ask the user structured questions during execution.
 *
 * This is a Pi-native AskUserQuestion-style tool. It keeps the UI lightweight
 * while returning a structured result envelope the model can reliably consume.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { createQuestionDialog } from "./dialog.ts";
import { cancelResult, errorResult, successResult, answerScalar } from "./results.ts";
import { QuestionParams, validateQuestions } from "./schema.ts";
import type { DialogResult, Question, QuestionToolDetails } from "./types.ts";
import { callLine, errorResultLine, firstText, resultLine, resultPrefix } from "../tools-view/shared.ts";
import {
	QUESTION_DESCRIPTION,
	QUESTION_LABEL,
	QUESTION_PROMPT_GUIDELINES,
	QUESTION_PROMPT_SNIPPET,
	QUESTION_TOOL_NAME,
} from "./constants.ts";

export default function question(pi: ExtensionAPI) {
	pi.registerTool({
		name: QUESTION_TOOL_NAME,
		label: QUESTION_LABEL,
		description: QUESTION_DESCRIPTION,
		promptSnippet: QUESTION_PROMPT_SNIPPET,
		promptGuidelines: QUESTION_PROMPT_GUIDELINES,
		parameters: QuestionParams,
		renderShell: "self",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions = params.questions as Question[];
			if (!ctx.hasUI) return errorResult("no_ui", "question tool requires an interactive UI");

			const validation = validateQuestions(questions);
			if (!validation.ok) return errorResult(validation.error, validation.message);

			const result = await ctx.ui.custom<DialogResult>(createQuestionDialog(questions));
			if (result.cancelled) return cancelResult(result.answers);
			return successResult(result.answers);
		},

		renderCall(args, theme) {
			const qs = Array.isArray(args.questions) ? args.questions : [];
			let suffix: string;
			if (qs.length === 1) {
				const q = qs[0] as Partial<Question>;
				suffix = theme.fg("muted", String(q.question ?? "..."));
			} else {
				suffix = theme.fg("muted", `${qs.length} questions`);
			}
			return new Text(callLine("Question", suffix, theme), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as QuestionToolDetails | undefined;

			if (details?.error) {
				const msg = firstText(result) || `Error: ${details.error}`;
				return new Text(errorResultLine(msg, false, theme), 0, 0);
			}

			if (details?.cancelled) {
				return new Text(resultLine("Cancelled", theme, "warning"), 0, 0);
			}

			if (!details || details.answers.length === 0) {
				return new Text(resultLine("No answer", theme, "muted"), 0, 0);
			}

			if (details.answers.length === 1) {
				const answer = details.answers[0];
				const value = answerScalar(answer);
				let text = resultPrefix(theme) + theme.fg("success", "✓ ") + theme.fg("accent", value);
				if (answer.notes?.length) {
					text += ` ${theme.fg("success", "+notes")}`;
				}
				return new Text(text, 0, 0);
			}

			let text = resultLine(`✓ answered (${details.answers.length})`, theme, "success");
			for (const answer of details.answers) {
				const suffix = answer.notes?.length ? ` ${theme.fg("success", "+notes")}` : "";
				text += `\n  ${theme.fg("muted", `${answer.header}: `)}${theme.fg("accent", answerScalar(answer))}${suffix}`;
			}
			return new Text(text, 0, 0);
		},
	});
}

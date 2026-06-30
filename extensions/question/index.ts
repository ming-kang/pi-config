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
import { callLine, errorResultLine, resultLine } from "../tools-view/shared.ts";

export default function question(pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		description:
			"Ask the user one or more multiple-choice questions to gather preferences, clarify ambiguity, or let them choose a direction. Each question has 2-4 options; the user can always pick 'Type something.' to type a custom answer. Use only when you genuinely need a user decision.",
		promptSnippet: "Ask the user multiple-choice questions when you need a decision or preference",
		promptGuidelines: [
			"Use question only when you genuinely need user input to proceed; do not use it for trivial single-step tasks or informational queries.",
			"Each question needs a unique question text, a short header chip, and 2-4 options with distinct labels.",
			"Do not author reserved option labels: Other, Type something., Chat about this, or Next.",
			"Users can press Tab to attach notes to a concrete focused option or type a custom answer on 'Type something.', Left/Right to switch questions, Space to toggle multi-select options, and Enter to submit.",
			"Use preview for concrete artifacts like code snippets or layout mockups that users need to visually compare.",
		],
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
				const text = result.content[0];
				const msg = text?.type === "text" ? text.text : `Error: ${details.error}`;
				return new Text(errorResultLine(msg, false, theme), 0, 0);
			}

			if (details?.cancelled) {
				return new Text(resultLine(theme.fg("warning", "Cancelled"), theme), 0, 0);
			}

			if (!details || details.answers.length === 0) {
				return new Text(resultLine(theme.fg("muted", "No answer"), theme), 0, 0);
			}

			if (details.answers.length === 1) {
				const answer = details.answers[0];
				const value = answerScalar(answer);
				let text = resultLine(theme.fg("success", "✓ ") + theme.fg("accent", value), theme);
				if (answer.notes?.length) {
					text += ` ${theme.fg("success", "+notes")}`;
				}
				return new Text(text, 0, 0);
			}

			let text = resultLine(theme.fg("success", `✓ answered (${details.answers.length})`), theme);
			for (const answer of details.answers) {
				const suffix = answer.notes?.length ? ` ${theme.fg("success", "+notes")}` : "";
				text += `\n  ${theme.fg("muted", `${answer.header}: `)}${theme.fg("accent", answerScalar(answer))}${suffix}`;
			}
			return new Text(text, 0, 0);
		},
	});
}

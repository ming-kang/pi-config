import { Type } from "typebox";
import type { Question, QuestionOption, QuestionToolError } from "./types.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_QUESTIONS = 4;
const RESERVED_LABELS = ["Other", "Type something.", "Chat about this", "Next"] as const;

const OptionSchema = Type.Object({
	label: Type.String({
		description:
			"Short user-facing option label (1-5 words), distinct within the question. Reserved labels ('Other', 'Type something.', 'Chat about this', 'Next') are rejected — the UI adds the custom-answer path itself.",
	}),
	description: Type.Optional(
		Type.String({ description: "One concise sentence explaining the option's meaning, consequence, or tradeoff." }),
	),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional markdown preview shown only for focused single-select options; use for concrete snippets, layouts, copy, or config comparisons.",
		}),
	),
});

const QuestionSchema = Type.Object({
	question: Type.String({
		description: "One clear, specific decision or preference question. Ask only what is needed to proceed.",
	}),
	header: Type.String({ description: "Very short decision label shown as a chip (max ~12 chars), e.g. 'Auth method'." }),
	options: Type.Array(OptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description: "Mutually distinct options for this decision; do not include reserved custom-answer labels.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			description:
				"Allow selecting multiple options only when choices can be combined. Defaults to false for mutually exclusive decisions.",
		}),
	),
});

export const QuestionParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: "Related decisions to ask now (1-4); ask only what is needed to unblock progress.",
	}),
});

export function validateQuestions(
	questions: Question[],
): { ok: true } | { ok: false; error: QuestionToolError; message: string } {
	if (questions.length === 0) return { ok: false, error: "no_questions", message: "At least one question is required" };
	if (questions.length > MAX_QUESTIONS) {
		return { ok: false, error: "too_many_questions", message: `At most ${MAX_QUESTIONS} questions are allowed` };
	}

	const seenQuestions = new Set<string>();
	for (const q of questions) {
		if (seenQuestions.has(q.question)) {
			return { ok: false, error: "duplicate_question", message: "Question text must be unique" };
		}
		seenQuestions.add(q.question);

		if (q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
			return {
				ok: false,
				error: "empty_options",
				message: `Each question requires ${MIN_OPTIONS}-${MAX_OPTIONS} options`,
			};
		}

		const seenLabels = new Set<string>();
		for (const option of q.options as QuestionOption[]) {
			if ((RESERVED_LABELS as readonly string[]).includes(option.label)) {
				return {
					ok: false,
					error: "reserved_label",
					message: `Option label is reserved (${RESERVED_LABELS.join(", ")})`,
				};
			}
			if (seenLabels.has(option.label)) {
				return { ok: false, error: "duplicate_option_label", message: "Option labels must be unique within a question" };
			}
			seenLabels.add(option.label);
		}
	}

	return { ok: true };
}

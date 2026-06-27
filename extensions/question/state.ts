import type { AnswerNote, CustomAnswer, DialogResult, DisplayOption, Question, QuestionAnswer, QuestionState } from "./types.ts";
import { OTHER_OPTION } from "./types.ts";

export function newQuestionState(): QuestionState {
	return {
		optionIndex: 0,
		multiSelected: new Set(),
		notesByOption: new Map(),
	};
}

export function selectedCustomAnswer(state: QuestionState): CustomAnswer | undefined {
	return state.customAnswer?.selected ? state.customAnswer : undefined;
}

export function hasMultiAnswer(state: QuestionState): boolean {
	return state.multiSelected.size > 0 || selectedCustomAnswer(state) !== undefined;
}

export function hasAnswer(state: QuestionState): boolean {
	return Boolean(state.singleAnswer) || hasMultiAnswer(state);
}

export function displayOptions(question: Question): DisplayOption[] {
	return [
		...question.options.map((option, optionIndex) => ({ ...option, kind: "option" as const, optionIndex })),
		OTHER_OPTION,
	];
}

function noteEntries(state: QuestionState, allowedOptions: readonly string[]): AnswerNote[] | undefined {
	const allowed = new Set(allowedOptions);
	const entries = [...state.notesByOption.entries()]
		.filter(([option]) => allowed.has(option))
		.filter(([, text]) => text.trim().length > 0)
		.map(([option, text]) => ({ option, text: text.trim() }));
	return entries.length ? entries : undefined;
}

function firstUnanswered(states: QuestionState[]): number | undefined {
	for (let i = 0; i < states.length; i++) {
		const state = states[i];
		if (!hasAnswer(state)) return i;
	}
	return undefined;
}

export function orderedAnswers(questions: Question[], states: QuestionState[]): QuestionAnswer[] {
	const answers: QuestionAnswer[] = [];
	for (let i = 0; i < questions.length; i++) {
		const question = questions[i];
		const state = states[i];
		if (state.singleAnswer) {
			const notes =
				state.singleAnswer.kind === "option" && state.singleAnswer.answer
					? noteEntries(state, [state.singleAnswer.answer])
					: undefined;
			answers.push(notes ? { ...state.singleAnswer, notes } : state.singleAnswer);
			continue;
		}

		if (question.multiSelect && hasMultiAnswer(state)) {
			const selected: string[] = [];
			for (const idx of [...state.multiSelected].sort((a, b) => a - b)) {
				const option = question.options[idx];
				if (option) selected.push(option.label);
			}
			const custom = selectedCustomAnswer(state);
			if (custom) selected.push(custom.text);
			const notes = noteEntries(state, selected);
			answers.push({
				questionIndex: i,
				question: question.question,
				header: question.header,
				kind: "multi",
				answer: null,
				selected,
				...(notes ? { notes } : {}),
			});
		}
	}
	return answers;
}

export function nextQuestion(current: number, count: number): number {
	return count === 0 ? 0 : (current + 1) % count;
}

export function previousQuestion(current: number, count: number): number {
	return count === 0 ? 0 : (current - 1 + count) % count;
}

export function submitIfComplete(
	done: (result: DialogResult) => void,
	questions: Question[],
	states: QuestionState[],
	currentIdx: number,
): void {
	const missing = firstUnanswered(states);
	if (missing === undefined) {
		done({ answers: orderedAnswers(questions, states), cancelled: false });
		return;
	}
	states[currentIdx].warning =
		missing === currentIdx
			? "Answer this question before submitting."
			: "Answer the remaining question(s), then press Enter to submit.";
}

/**
 * constants.ts — question tool identity + prompt copy.
 *
 * Name/label/description/promptSnippet/promptGuidelines live here so
 * `index.ts` only assembles the tool, matching the advisor/constants.ts
 * pattern. Prompt copy is the model-facing contract; keep it stable.
 */

export const QUESTION_TOOL_NAME = "question";
export const QUESTION_LABEL = "Question";

export const QUESTION_DESCRIPTION =
	"Ask the user one or more multiple-choice questions to gather preferences, clarify ambiguity, or let them choose a direction. Each question has 2-4 options; the user can always pick 'Type something.' to type a custom answer. Use only when you genuinely need a user decision.";

export const QUESTION_PROMPT_SNIPPET =
	"Ask the user multiple-choice questions when you need a decision or preference";

export const QUESTION_PROMPT_GUIDELINES = [
	"Use question only when you genuinely need user input to proceed; do not use it for trivial single-step tasks or informational queries.",
	"Each question needs a unique question text, a short header chip, and 2-4 options with distinct labels.",
	"Do not author reserved option labels: Other, Type something., Chat about this, or Next.",
	"Users can press Tab to attach notes to a concrete focused option or type a custom answer on 'Type something.', Left/Right to switch questions, Space to toggle multi-select options, and Enter to submit.",
	"Use preview for concrete artifacts like code snippets or layout mockups that users need to visually compare.",
];

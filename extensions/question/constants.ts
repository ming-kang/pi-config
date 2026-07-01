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
	"Ask the user one to four structured multiple-choice questions when a real user decision, preference, or missing requirement blocks progress. Each question has 2-4 model-authored options plus an automatic custom-answer path. Use previews only for concrete alternatives the user should visually compare. Do not use this for facts you can inspect, infer with high confidence, or verify with tools.";

export const QUESTION_PROMPT_SNIPPET =
	"Ask structured multiple-choice questions when a user decision, preference, or missing requirement blocks progress";

export const QUESTION_PROMPT_GUIDELINES = [
	"Use `question` only when a real user decision, preference, or missing requirement blocks progress; do not use it for facts you can inspect, infer with high confidence, or verify with tools.",
	"Prefer making a reasonable default choice yourself for low-risk details; ask the user only for consequential ambiguity, product direction, credentials/permissions, destructive choices, or subjective preferences.",
	"Batch related independent decisions into one `question` call with 1-4 questions, but do not combine unrelated topics or ask more than needed to unblock the next step.",
	"Write each `question` as one concrete decision with a short header and 2-4 mutually distinct options; avoid vague labels like 'Option A' or bare 'Yes/No' without explaining consequences.",
	"Do not author reserved option labels: Other, Type something., Chat about this, or Next; the UI provides a custom-answer path automatically.",
	"Use multiSelect only when multiple options can validly be chosen together; use single-select for mutually exclusive directions.",
	"Use preview only for concrete artifacts like code snippets, UI layouts, copy variants, or config examples that users need to visually compare.",
];

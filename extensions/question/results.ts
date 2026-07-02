import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { QuestionAnswer, QuestionToolDetails, QuestionToolError } from "./types.ts";

const DECLINE_MESSAGE = "User declined to answer questions";
const ENVELOPE_PREFIX = "User has answered your questions:";
const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

function buildToolResult(text: string, details: QuestionToolDetails): AgentToolResult<QuestionToolDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

export function errorResult(
	error: QuestionToolError,
	message: string,
): AgentToolResult<QuestionToolDetails> {
	// An error is not a user decision: `cancelled` stays false so the envelope
	// distinguishes "the user declined" from "the call itself was invalid".
	return buildToolResult(`Error: ${message}`, { answers: [], cancelled: false, error });
}

export function answerScalar(answer: QuestionAnswer): string {
	if (answer.kind === "multi") return answer.selected?.length ? answer.selected.join(", ") : "(no input)";
	return answer.answer && answer.answer.length > 0 ? answer.answer : "(no input)";
}

function answerSegment(answer: QuestionAnswer): string {
	const parts = [`"${answer.question}"="${answerScalar(answer)}"`];
	if (answer.preview) parts.push(`selected preview: ${answer.preview}`);
	if (answer.notes?.length) {
		parts.push(`user notes: ${answer.notes.map((note) => `${note.option}: ${note.text}`).join("; ")}`);
	}
	return `${parts.join(". ")}.`;
}

export function successResult(answers: QuestionAnswer[]): AgentToolResult<QuestionToolDetails> {
	if (answers.length === 0) return buildToolResult(DECLINE_MESSAGE, { answers: [], cancelled: true });
	return buildToolResult(`${ENVELOPE_PREFIX} ${answers.map(answerSegment).join(" ")} ${ENVELOPE_SUFFIX}`, {
		answers,
		cancelled: false,
	});
}

export function cancelResult(answers: QuestionAnswer[] = []): AgentToolResult<QuestionToolDetails> {
	return buildToolResult(DECLINE_MESSAGE, { answers, cancelled: true });
}

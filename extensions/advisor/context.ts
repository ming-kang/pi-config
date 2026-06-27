import type {
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

import { ADVISOR_TOOL_NAME } from "./constants.ts";
import type { AdvisorParams } from "./schema.ts";

function stripInflightAdvisorCall(messages: Message[]): Message[] {
	if (messages.length === 0) return messages;
	const last = messages[messages.length - 1];
	if (last.role !== "assistant") return messages;

	const filtered = last.content.filter((part) => !(part.type === "toolCall" && part.name === ADVISOR_TOOL_NAME));
	if (filtered.length === last.content.length) return messages;
	if (filtered.length === 0) return messages.slice(0, -1);
	return [...messages.slice(0, -1), { ...last, content: filtered }];
}

/**
 * Flatten message content to plain text. Images become a compact placeholder.
 * Deliberately no truncation: the advisor is a one-shot call, so it gets the full
 * selected context (scope is bounded by previousRuns, not by per-message caps).
 */
function flattenContent(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.map((part) => (part.type === "text" ? part.text : `[image: ${part.mimeType}, ${part.data.length} base64 chars]`))
		.join("\n");
}

function assistantContent(message: AssistantMessage): string {
	return message.content
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "thinking") return "[hidden thinking]";
			return `Tool call: ${part.name}\nArguments: ${JSON.stringify(part.arguments, null, 2)}`;
		})
		.join("\n\n");
}

function toolResultContent(message: ToolResultMessage): string {
	const status = message.isError ? "error" : "ok";
	return [`Tool: ${message.toolName}`, `Status: ${status}`, "", flattenContent(message.content)].join("\n");
}

function formatMessage(message: Message, index: number): string {
	const ordinal = index + 1;
	if (message.role === "user") {
		return [`### ${ordinal}. User`, "", flattenContent(message.content)].join("\n");
	}
	if (message.role === "assistant") {
		return [`### ${ordinal}. Executor`, "", assistantContent(message)].join("\n");
	}
	// Label prior advisor results so the reviewer treats them as earlier guidance
	// from itself, not as executor work.
	if (message.toolName === ADVISOR_TOOL_NAME) {
		return [
			`### ${ordinal}. Previous advisor guidance`,
			"",
			"[Guidance from an earlier advisor call in this session — not executor work.]",
			"",
			flattenContent(message.content),
		].join("\n");
	}
	return [`### ${ordinal}. Tool Result`, "", toolResultContent(message)].join("\n");
}

type SessionMessage = Parameters<typeof convertToLlm>[0][number];

function findRunStartIndexes(messages: SessionMessage[]): number[] {
	const indexes: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === "user") indexes.push(i);
	}
	return indexes;
}

/** Select the current run plus `previousRuns` earlier user-request cycles. */
function selectSessionMessages(messages: SessionMessage[], previousRuns: number): SessionMessage[] {
	const runStarts = findRunStartIndexes(messages);
	if (runStarts.length === 0) return messages;
	const startRunIndex = Math.max(0, runStarts.length - 1 - previousRuns);
	return messages.slice(runStarts[startRunIndex]);
}

function listSection(title: string, items: string[] | undefined): string[] {
	if (!items || items.length === 0) return [];
	return [`## ${title}`, "", ...items.map((item) => `- ${item}`), ""];
}

export function buildAdvisorReviewRequest(params: AdvisorParams): string {
	return [
		"# Advisor Review Request",
		"",
		"## Executor Brief",
		"",
		"### Situation",
		params.situation,
		"",
		"### Reason for advisor",
		params.reason,
		"",
		"### Question",
		params.question,
		"",
		...(params.currentPlan ? ["### Current plan", params.currentPlan, ""] : []),
		...listSection("Key evidence", params.evidence),
		...listSection("Known risks", params.risks),
		...(params.evidence?.length || params.risks?.length
			? [
					"> The evidence above was summarized by the executor. Raw session context follows below for cross-reference. When they conflict, trust the raw context over the executor's summary.",
					"",
			  ]
			: []),
	].join("\n");
}

export function buildAdvisorContextText(
	sessionMessages: Parameters<typeof convertToLlm>[0],
	previousRuns: number,
): string {
	const llmMessages = stripInflightAdvisorCall(convertToLlm(selectSessionMessages(sessionMessages, previousRuns)));
	if (llmMessages.length === 0) {
		return "## Related Context\n\nNo session context available.";
	}

	return ["## Related Context", "", ...llmMessages.map((message, index) => formatMessage(message, index))].join("\n");
}

export function buildAdvisorMessage(
	params: AdvisorParams,
	sessionMessages: Parameters<typeof convertToLlm>[0],
	previousRuns: number,
): UserMessage {
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: [buildAdvisorReviewRequest(params), buildAdvisorContextText(sessionMessages, previousRuns)].join("\n\n"),
			},
		],
		timestamp: Date.now(),
	};
}

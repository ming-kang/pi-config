import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

import { callDeepWiki } from "./client.ts";
import type { DeepWikiAction, DeepWikiParams } from "./schema.ts";

export interface DeepWikiDetails {
	action: DeepWikiAction;
	repoName: string;
	question?: string;
	toolName?: string;
	outputLength?: number;
	errorMessage?: string;
}

function buildResult(params: DeepWikiParams, text: string, extra: Partial<DeepWikiDetails> = {}): AgentToolResult<DeepWikiDetails> {
	return {
		content: [{ type: "text", text }],
		details: {
			action: params.action,
			repoName: params.repoName,
			...(params.question ? { question: params.question } : {}),
			...extra,
		},
	};
}

export async function executeDeepWiki(
	params: DeepWikiParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<DeepWikiDetails> | undefined,
): Promise<AgentToolResult<DeepWikiDetails>> {
	const repoName = params.repoName.trim();
	const normalizedParams = { ...params, repoName };

	onUpdate?.(buildResult(normalizedParams, `Querying DeepWiki for ${repoName}...`));

	try {
		const response = await callDeepWiki(normalizedParams, signal);
		return buildResult(normalizedParams, response.text, {
			toolName: response.toolName,
			outputLength: response.outputLength,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return buildResult(normalizedParams, `DeepWiki call failed: ${message}`, { errorMessage: message });
	}
}

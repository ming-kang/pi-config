import type {
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";

import { callDeepWiki, type DeepWikiResponse } from "./client.ts";
import { normalizeDeepWikiParams, type DeepWikiAction, type DeepWikiParams } from "./schema.ts";

export interface DeepWikiDetails {
	action: DeepWikiAction;
	repoName: string;
	repoNames?: string[];
	question?: string;
	toolName?: string;
	outputLength?: number;
	cacheHit?: boolean;
	pageCount?: number;
	pageTitles?: string[];
	/** Legacy fields kept so older session entries still render. */
	sectionCount?: number;
	sectionTitles?: string[];
	errorMessage?: string;
}

function buildResult(
	params: DeepWikiParams,
	text: string,
	extra: Partial<DeepWikiDetails> = {},
): AgentToolResult<DeepWikiDetails> {
	const repoNames = Array.isArray(params.repoName) ? params.repoName : [params.repoName];
	return {
		content: [{ type: "text", text }],
		details: {
			action: params.action,
			repoName: repoNames.join(", "),
			...(repoNames.length > 1 ? { repoNames } : {}),
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
	const normalizedParams = normalizeDeepWikiParams(params);
	const repoLabel = Array.isArray(normalizedParams.repoName)
		? normalizedParams.repoName.join(", ")
		: normalizedParams.repoName;

	onUpdate?.(buildResult(normalizedParams, `Querying DeepWiki for ${repoLabel}...`));

	let response: DeepWikiResponse;
	try {
		response = await callDeepWiki(normalizedParams, signal);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`DeepWiki call failed: ${message}`);
	}

	const extra: Partial<DeepWikiDetails> = {
		toolName: response.toolName,
		outputLength: response.outputLength,
		...(response.cacheHit ? { cacheHit: true } : {}),
		...(response.pageTitles
			? {
					pageCount: response.pageTitles.length,
					pageTitles: response.pageTitles,
				}
			: {}),
	};

	return buildResult(normalizedParams, response.text, extra);
}

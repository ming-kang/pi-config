import type { DeepWikiParams } from "./schema.ts";

const DEEPWIKI_MCP_URL = "https://mcp.deepwiki.com/mcp";
const MCP_PROTOCOL_VERSION = "2024-11-05";

type DeepWikiToolName = "read_wiki_structure" | "read_wiki_contents" | "ask_question";

interface JsonRpcErrorPayload {
	code?: number;
	message?: string;
	data?: unknown;
}

interface JsonRpcEnvelope {
	jsonrpc?: string;
	id?: string | number | null;
	result?: unknown;
	error?: JsonRpcErrorPayload;
}

interface McpTextContent {
	type: "text";
	text: string;
}

interface McpToolCallResult {
	content?: unknown;
	structuredContent?: unknown;
	isError?: boolean;
}

export interface DeepWikiResponse {
	toolName: DeepWikiToolName;
	text: string;
	outputLength: number;
	sectionTitles?: string[];
}

function toolNameForAction(action: DeepWikiParams["action"]): DeepWikiToolName {
	if (action === "structure") return "read_wiki_structure";
	if (action === "contents") return "read_wiki_contents";
	return "ask_question";
}

function normalizeRepoName(repoName: string): string {
	const normalized = repoName.trim();
	if (!normalized) throw new Error("repoName is required");
	if (!/^[^\s/]+\/[^\s/]+$/.test(normalized)) {
		throw new Error('repoName must use "owner/repo" format');
	}
	return normalized;
}

function argumentsForParams(params: DeepWikiParams): Record<string, unknown> {
	const repoName = normalizeRepoName(params.repoName);
	if (params.action === "question") {
		const question = params.question?.trim();
		if (!question) throw new Error("question is required when action is question");
		return { repoName, question };
	}
	return { repoName };
}

function truncate(text: string, maxLength = 500): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 3)}...`;
}

function parseJson(text: string): JsonRpcEnvelope {
	try {
		return JSON.parse(text) as JsonRpcEnvelope;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`DeepWiki returned invalid JSON: ${message}`);
	}
}

function parseSse(text: string): JsonRpcEnvelope {
	const blocks = text.split(/\r?\n\r?\n/);
	for (const block of blocks) {
		const dataLines = block
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""));
		if (dataLines.length === 0) continue;

		const data = dataLines.join("\n").trim();
		if (!data || data === "[DONE]") continue;
		return parseJson(data);
	}
	throw new Error("DeepWiki returned an empty event stream");
}

function parseEnvelope(text: string, contentType: string | null): JsonRpcEnvelope {
	if (contentType?.includes("text/event-stream")) return parseSse(text);
	return parseJson(text);
}

function extractStructuredResult(result: McpToolCallResult): string | undefined {
	if (!result.structuredContent || typeof result.structuredContent !== "object") return undefined;
	const value = (result.structuredContent as Record<string, unknown>).result;
	return typeof value === "string" ? value : undefined;
}

function extractContentResult(result: McpToolCallResult): string {
	if (!Array.isArray(result.content)) return "";
	return result.content
		.filter((part): part is McpTextContent => {
			if (!part || typeof part !== "object") return false;
			const record = part as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string";
		})
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function extractToolText(result: unknown): string {
	if (!result || typeof result !== "object") throw new Error("DeepWiki returned no result object");

	const toolResult = result as McpToolCallResult;
	const text = extractStructuredResult(toolResult) ?? extractContentResult(toolResult);
	if (!text) throw new Error("DeepWiki returned no text content");
	if (toolResult.isError) throw new Error(text);
	return text;
}

export function extractStructureSections(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.match(/^\s*-\s+\d+\s+(.+)$/)?.[1]?.trim())
		.filter((section): section is string => Boolean(section));
}

export async function callDeepWiki(params: DeepWikiParams, signal: AbortSignal | undefined): Promise<DeepWikiResponse> {
	const toolName = toolNameForAction(params.action);
	const body = {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: {
			name: toolName,
			arguments: argumentsForParams(params),
		},
	};

	const response = await fetch(DEEPWIKI_MCP_URL, {
		method: "POST",
		headers: {
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			"MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
		},
		body: JSON.stringify(body),
		signal,
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`DeepWiki HTTP ${response.status}: ${truncate(text)}`);
	}

	const envelope = parseEnvelope(text, response.headers.get("content-type"));
	if (envelope.error) {
		throw new Error(envelope.error.message ?? `DeepWiki JSON-RPC error ${envelope.error.code ?? "unknown"}`);
	}

	const resultText = extractToolText(envelope.result);
	return {
		toolName,
		text: resultText,
		outputLength: resultText.length,
		...(toolName === "read_wiki_structure" ? { sectionTitles: extractStructureSections(resultText) } : {}),
	};
}

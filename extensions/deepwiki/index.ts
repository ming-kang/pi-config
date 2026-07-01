/**
 * deepwiki — Pi-native wrapper for DeepWiki repository documentation.
 *
 * Pi does not expose MCP servers as tools. This extension intentionally exposes
 * only one DeepWiki-specific tool and hard-codes DeepWiki's public operations.
 */
import { type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";

import { buildStandardRenderer } from "../tools-view/shared.ts";
import { truncateText } from "../shared/text.ts";
import {
	DEEPWIKI_DESCRIPTION,
	DEEPWIKI_LABEL,
	DEEPWIKI_PROMPT_GUIDELINES,
	DEEPWIKI_PROMPT_SNIPPET,
	DEEPWIKI_TOOL_NAME,
} from "./constants.ts";

import { executeDeepWiki, type DeepWikiDetails } from "./execute.ts";
import { extractContentPages, extractStructureSections } from "./client.ts";
import { DeepWikiParamsSchema, normalizeDeepWikiParams, type DeepWikiParams } from "./schema.ts";

const ACTION_LABEL: Record<DeepWikiParams["action"], string> = {
	structure: "structure",
	contents: "contents",
	question: "question",
};

function firstContentLine(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0) ?? "DeepWiki response";
}

function extractTopLevelSections(text: string): string[] {
	return extractStructureSections(text);
}

function formatPageList(pages: string[], maxItems = 4): string {
	const shown = pages.slice(0, maxItems).join(", ");
	return pages.length > maxItems ? `${shown}...` : shown;
}

function getPageTitles(text: string, details: DeepWikiDetails | undefined): string[] {
	if (details?.pageTitles?.length) return details.pageTitles;
	if (details?.sectionTitles?.length) return details.sectionTitles;
	const contentPages = extractContentPages(text);
	return contentPages.length ? contentPages : extractTopLevelSections(text);
}

function summarizeStructure(text: string, details: DeepWikiDetails | undefined): string {
	const pages = getPageTitles(text, details);
	if (pages.length === 0) return truncateText(firstContentLine(text), 120);
	return `${pages.length} pages · ${formatPageList(pages)}`;
}

function summarizeContents(text: string, details: DeepWikiDetails | undefined): string {
	const pages = getPageTitles(text, details);
	if (pages.length === 0) return "Wiki loaded · expand for full contents";
	return `Wiki loaded · ${pages.length} pages · expand for full contents`;
}

function stripDeepWikiTail(text: string): string {
	const tailIndex = text.search(/\n(?:#+\s*)?(?:Wiki pages you might want to explore|View this search)/i);
	if (tailIndex < 0) return text;
	return text.slice(0, tailIndex);
}

function cleanSummaryText(text: string): string {
	return stripDeepWikiTail(text)
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/[`*_]/g, "")
		.replace(/\s+([.,;:!?])/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

function summarizeQuestion(text: string): string {
	const cleaned = cleanSummaryText(text);
	if (!cleaned) return "DeepWiki answered";
	const sentenceMatch = cleaned.match(/^.{40,}?[.!?](?=\s|$)/);
	return truncateText(sentenceMatch?.[0] ?? cleaned, 160, { word: true });
}

function summarizeCollapsedResult(text: string, details: DeepWikiDetails | undefined): string {
	if (details?.action === "structure") return summarizeStructure(text, details);
	if (details?.action === "contents") return summarizeContents(text, details);
	if (details?.action === "question") return summarizeQuestion(text);
	return truncateText(firstContentLine(text), 120);
}

function repoLabel(repoName: DeepWikiParams["repoName"] | undefined): string {
	if (Array.isArray(repoName)) {
		if (repoName.length === 0) return "repo";
		if (repoName.length === 1) return repoName[0];
		return `${repoName.length} repos: ${repoName.slice(0, 3).join(", ")}${repoName.length > 3 ? "..." : ""}`;
	}
	return repoName ?? "repo";
}

function callSuffix(args: DeepWikiParams, theme: Theme): string {
	const action = ACTION_LABEL[args.action] ?? String(args.action ?? "...");
	let suffix = `${theme.fg("muted", action)} ${theme.fg("accent", repoLabel(args.repoName))}`;
	if (args.action === "question" && args.question) {
		suffix += ` ${theme.fg("dim", truncateText(args.question, 72))}`;
	}
	return suffix;
}

const DEEPWIKI_RENDERER = buildStandardRenderer<DeepWikiDetails>({
	name: "DeepWiki",
	callSuffix: (args, theme) => callSuffix(args as DeepWikiParams, theme),
	partialLabel: (details) => ` Querying${details?.repoName ? ` ${details.repoName}` : ""}...`,
	errorMessage: (text, details) => `failed · ${details?.errorMessage ?? firstContentLine(text)}`,
	collapsedLine: (text, details) => summarizeCollapsedResult(text, details),
});

export default function deepwiki(pi: ExtensionAPI): void {
	pi.registerTool({
		name: DEEPWIKI_TOOL_NAME,
		label: DEEPWIKI_LABEL,
		description: DEEPWIKI_DESCRIPTION,
		promptSnippet: DEEPWIKI_PROMPT_SNIPPET,
		promptGuidelines: DEEPWIKI_PROMPT_GUIDELINES,
		parameters: DeepWikiParamsSchema,
		prepareArguments: normalizeDeepWikiParams,
		renderShell: "self",

		async execute(_toolCallId, params, signal, onUpdate) {
			return executeDeepWiki(params, signal, onUpdate);
		},

		renderCall: DEEPWIKI_RENDERER.renderCall,
		renderResult: DEEPWIKI_RENDERER.renderResult,
	});
}

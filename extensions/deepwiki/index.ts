/**
 * deepwiki — Pi-native wrapper for DeepWiki repository documentation.
 *
 * Pi does not expose MCP servers as tools. This extension intentionally exposes
 * only one DeepWiki-specific tool and hard-codes DeepWiki's public operations.
 */
import { type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { activeDotLine, callLine, errorResultLine, markdownResultBlock, resultLine } from "../tools-view/shared.ts";
import { truncateText } from "../shared/text.ts";

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

export default function deepwiki(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "deepwiki",
		label: "DeepWiki",
		description:
			"Query DeepWiki's generated documentation for public GitHub repositories. Best for understanding an unfamiliar repo, finding reference patterns while designing or building something, explaining architecture/APIs/implementation details, and comparing up to 10 public repos. Results are generated from indexed public repo snapshots and often include cited source files; they are not local workspace state or guaranteed-latest upstream facts.",
		promptSnippet:
			"Use DeepWiki for public GitHub repo architecture, APIs, implementation patterns, reference designs, and repo comparisons",
		promptGuidelines: [
			"Use `deepwiki` when the user wants to understand a public GitHub repository: architecture, module layout, APIs, extension points, data flow, onboarding, or where a concept lives.",
			"Use `deepwiki` as reference research while developing a new feature or project when public repos can provide implementation patterns, design tradeoffs, or examples to adapt.",
			"Use `question` for targeted questions; use repoName as an array of up to 10 repos when comparing libraries, frameworks, plugin systems, or implementation approaches.",
			"When these conditions apply, call `deepwiki` yourself instead of asking the user to open DeepWiki or paste docs.",
			"Use `structure` first when the repo is unfamiliar and you need the topic map; use `contents` only when broad generated docs and source-file citations are worth the larger output.",
			"Prefer repoName in owner/repo format; GitHub and DeepWiki URLs are accepted as fallback inputs, but do not pass package names or local paths.",
			"Do not use `deepwiki` for local workspace files, uncommitted changes, private repos, exact current HEAD, release dates, pricing, security advisories, or anything where freshness is required; use local tools or current primary sources instead.",
		],
		parameters: DeepWikiParamsSchema,
		prepareArguments: normalizeDeepWikiParams,
		renderShell: "self",

		async execute(_toolCallId, params, signal, onUpdate) {
			return executeDeepWiki(params, signal, onUpdate);
		},

		renderCall(args, theme) {
			return new Text(callLine("DeepWiki", callSuffix(args, theme), theme), 0, 0);
		},

		renderResult(result, options, theme, ctx) {
			const details = result.details as DeepWikiDetails | undefined;
			const text = result.content.find((part) => part.type === "text")?.text ?? "";

			if (options.isPartial) {
				const target = details?.repoName ? ` ${details.repoName}` : "";
				return new Text(activeDotLine("DeepWiki", ` Querying${target}...`, theme), 0, 0);
			}

			if (ctx.isError || details?.errorMessage) {
				const message = `failed · ${details?.errorMessage ?? firstContentLine(text)}`;
				return new Text(errorResultLine(message, options.expanded, theme), 0, 0);
			}

			if (!options.expanded) {
				return new Text(resultLine(theme.fg("accent", summarizeCollapsedResult(text, details)), theme), 0, 0);
			}

			return markdownResultBlock(text);
		},
	});
}

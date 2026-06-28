/**
 * deepwiki — Pi-native wrapper for DeepWiki repository documentation.
 *
 * Pi does not expose MCP servers as tools. This extension intentionally exposes
 * only one DeepWiki-specific tool and hard-codes DeepWiki's public operations.
 */
import { getMarkdownTheme, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

import { activeDotLine, callLine, errLine, resultLine } from "../tools-view/shared.ts";

import { executeDeepWiki, type DeepWikiDetails } from "./execute.ts";
import { extractStructureSections } from "./client.ts";
import { DeepWikiParamsSchema, type DeepWikiParams } from "./schema.ts";

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

function truncate(text: string, maxLength = 120): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 3)}...`;
}

function truncateAtWord(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	const prefix = text.slice(0, maxLength - 3);
	const lastSpace = prefix.lastIndexOf(" ");
	if (lastSpace < 40) return `${prefix}...`;
	return `${prefix.slice(0, lastSpace)}...`;
}

function extractTopLevelSections(text: string): string[] {
	return extractStructureSections(text);
}

function formatSectionList(sections: string[], maxItems = 4): string {
	const shown = sections.slice(0, maxItems).join(", ");
	return sections.length > maxItems ? `${shown}...` : shown;
}

function getSectionTitles(text: string, details: DeepWikiDetails | undefined): string[] {
	return details?.sectionTitles?.length ? details.sectionTitles : extractTopLevelSections(text);
}

function summarizeStructure(text: string, details: DeepWikiDetails | undefined): string {
	const sections = getSectionTitles(text, details);
	if (sections.length === 0) return truncate(firstContentLine(text));
	return `${sections.length} pages · ${formatSectionList(sections)}`;
}

function summarizeContents(details: DeepWikiDetails | undefined): string {
	if (!details?.sectionCount) return "Wiki loaded · expand for full contents";
	return `Wiki loaded · ${details.sectionCount} sections · expand for full contents`;
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
	return truncateAtWord(sentenceMatch?.[0] ?? cleaned, 160);
}

function summarizeCollapsedResult(text: string, details: DeepWikiDetails | undefined): string {
	if (details?.action === "structure") return summarizeStructure(text, details);
	if (details?.action === "contents") return summarizeContents(details);
	if (details?.action === "question") return summarizeQuestion(text);
	return truncate(firstContentLine(text));
}

function callSuffix(args: DeepWikiParams, theme: Theme): string {
	const action = ACTION_LABEL[args.action] ?? String(args.action ?? "...");
	let suffix = `${theme.fg("muted", action)} ${theme.fg("accent", args.repoName ?? "repo")}`;
	if (args.action === "question" && args.question) {
		suffix += ` ${theme.fg("dim", truncate(args.question, 72))}`;
	}
	return suffix;
}

export default function deepwiki(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "deepwiki",
		label: "DeepWiki",
		description:
			"Query DeepWiki online docs for public GitHub repos by owner/repo. Actions: question asks a focused repo question, structure lists wiki topics, contents fetches the full wiki. Not for local files, private repos, or uncommitted changes.",
		promptSnippet: "Query online DeepWiki docs for public GitHub repos, not local files",
		promptGuidelines: [
			"Use `deepwiki` for public GitHub repo architecture, API, or implementation questions when online generated docs help.",
			"Use `deepwiki` only with repoName in owner/repo format; do not pass local paths, URLs, or package names.",
			"Prefer `deepwiki` action `question` for specific asks; use `structure` for the topic map and `contents` only when full-wiki context is needed.",
			"Do not use `deepwiki` for local workspace state or uncommitted changes; use read, grep, find, and ls for local files.",
		],
		parameters: DeepWikiParamsSchema,
		renderShell: "self",

		async execute(_toolCallId, params, signal, onUpdate) {
			return executeDeepWiki(params, signal, onUpdate);
		},

		renderCall(args, theme) {
			return new Text(callLine("DeepWiki", callSuffix(args, theme), theme, "accent"), 0, 0);
		},

		renderResult(result, options, theme, ctx) {
			const details = result.details as DeepWikiDetails | undefined;
			const text = result.content.find((part) => part.type === "text")?.text ?? "";

			if (options.isPartial) {
				const target = details?.repoName ? ` ${details.repoName}` : "";
				return new Text(activeDotLine("DeepWiki", ` Querying${target}...`, theme), 0, 0);
			}

			if (ctx.isError || details?.errorMessage) {
				const message = details?.errorMessage ?? firstContentLine(text);
				if (!options.expanded) {
					return new Text(resultLine(theme.fg("error", `failed · ${message}`), theme), 0, 0);
				}
				return new Text(errLine(message, theme), 0, 0);
			}

			if (!options.expanded) {
				return new Text(resultLine(theme.fg("accent", summarizeCollapsedResult(text, details)), theme), 0, 0);
			}

			const container = new Container();
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(text, 1, 0, getMarkdownTheme()));
			return container;
		},
	});
}

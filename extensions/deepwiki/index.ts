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
			"Query DeepWiki repository documentation for public GitHub repositories. Actions: structure lists wiki topics, contents reads the generated repository wiki, question asks a focused repository question.",
		promptSnippet: "Query DeepWiki documentation for GitHub repositories",
		promptGuidelines: [
			"Use `deepwiki` for GitHub repository architecture, module maps, and implementation questions when a repository-level generated wiki is useful.",
			"Use `deepwiki` action `structure` before `contents` when you need the available documentation topic map.",
			"Use `deepwiki` action `question` with a concrete question and a repoName in owner/repo format.",
			"Do not use `deepwiki` for local uncommitted workspace state; use read, grep, find, and ls for files in the current checkout.",
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
				return new Text(errLine(details?.errorMessage ?? firstContentLine(text), theme), 0, 0);
			}

			if (!options.expanded) {
				return new Text(resultLine(theme.fg("accent", truncate(firstContentLine(text))), theme), 0, 0);
			}

			const container = new Container();
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(text, 1, 0, getMarkdownTheme()));
			return container;
		},
	});
}

import type { AgentToolResult, Theme, ThemeColor, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { type Component, Container, getCapabilities, hyperlink, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";

import { firstLine } from "../shared/text.ts";

export const BULLET = "●";
export const RESULT_PREFIX = "│ ";

/**
 * Structural subset of Pi's `ToolRenderContext` (which is not publicly
 * exported from `@earendil-works/pi-coding-agent`). Field names match Pi's
 * internal type so this composes cleanly when passed to base renderers; we
 * only declare the fields tools-view renderers actually read. Pi's runtime
 * always supplies the full context, so callers must not default-instantiate
 * this (the old `ctx = {} as RenderCtx` default was dead code, removed).
 */
export interface RenderCtx {
	args: Record<string, unknown>;
	state: Record<string, unknown>;
	isError: boolean;
}

export function textLineCount(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

/**
 * Pull the first text content block out of a tool result, or undefined if none.
 * Use this (rather than `firstText`) when the caller must distinguish "no text
 * block" from "an empty text block" — e.g. read.ts treats an empty file
 * (text block with `text: ""`) as a successful empty read, not "no content".
 */
export function firstTextBlock(result: AgentToolResult<unknown>): TextContent | undefined {
	for (const part of result.content ?? []) {
		if ((part as TextContent | undefined)?.type === "text" && typeof (part as TextContent).text === "string") {
			return part as TextContent;
		}
	}
	return undefined;
}

/**
 * Pull the first text content block's text out of a tool result, or "" if none.
 * Used by every tool renderer; centralizing avoids 9 inline `find((c: any) => c.type === "text")`
 * sites and the `result.content[0]` shortcut that breaks when a result has both
 * image and text blocks. Callers that need to tell "no block" from "empty
 * block" apart should use `firstTextBlock` instead.
 */
export function firstText(result: AgentToolResult<unknown>): string {
	return firstTextBlock(result)?.text ?? "";
}

/**
 * Pull the first image content block out of a tool result. `data` is base64;
 * `mimeType` may be empty. Used by the read renderer to detect image results.
 */
export function firstImage(result: AgentToolResult<unknown>): ImageContent | undefined {
	for (const part of result.content ?? []) {
		if ((part as ImageContent | undefined)?.type === "image" && typeof (part as ImageContent).data === "string") {
			return part as ImageContent;
		}
	}
	return undefined;
}

/** First line of the result's text content, or `fallback` if empty/missing. */
export function firstLineError(result: AgentToolResult<unknown>, fallback: string): string {
	return firstLine(firstText(result), fallback);
}

export function callLine(toolName: string, args: string, theme: Theme): string {
	// Trim args so a caller passing a stray leading/trailing space doesn't render
	// "Tool( args)". The value is theme-colored text, so trimming only removes the
	// literal padding around it, never the visible content or its color codes.
	// The dot is ALWAYS the success color: line form conveys state, not dot color
	// (see tools-view/README.md → Dot-color rule).
	const a = args.trim();
	return `${theme.fg("success", BULLET)} ${theme.fg("toolTitle", theme.bold(toolName))}${a ? theme.fg("dim", `(${a})`) : ""}`;
}

export function activeDotLine(toolName: string, body: string, theme: Theme): string {
	return `${theme.fg("warning", BULLET)} ${theme.fg("toolTitle", theme.bold(toolName))}${theme.fg("dim", body)}`;
}

/** The dim `│ ` collapsed-result prefix, for callers composing multi-colored lines. */
export function resultPrefix(theme: Theme): string {
	return theme.fg("dim", RESULT_PREFIX);
}

/**
 * Collapsed result line: dim `│ ` prefix + `info` in `color` (default dim).
 * Pass an explicit color instead of nesting theme.fg calls inside `info`;
 * for genuinely multi-colored info, compose on `resultPrefix()` instead.
 */
export function resultLine(info: string, theme: Theme, color: ThemeColor = "dim"): string {
	return `${resultPrefix(theme)}${theme.fg(color, info)}`;
}

export function errLine(message: string, theme: Theme): string {
	return `${theme.fg("error", BULLET)} ${theme.fg("dim", message)}`;
}

/**
 * Render a tool error consistently across collapsed and expanded states.
 *
 * Folded (`expanded === false`): a single dim-prefixed line with the message in
 * error color — matches deepwiki's existing collapsed error branch. Expanded
 * (`expanded === true`): `errLine`'s `● error` bullet form. Callers wrap the
 * returned string in `new Text(..., 0, 0)`.
 *
 * SPEC F7: codifies the collapsed-vs-expanded convention so advisor/question/todo
 * render errors the same way deepwiki already did.
 */
export function errorResultLine(message: string, expanded: boolean, theme: Theme): string {
	return expanded ? errLine(message, theme) : resultLine(message, theme, "error");
}

export function emptyLine(label: string, theme: Theme): string {
	return `  ${theme.fg("muted", label)}`;
}

// ---- expand/collapse footer hints ------------------------------------------
// One wording for the affordance across every preview renderer. Callers prepend
// their own newline/indent ("\n  " for footer rows, " " for inline suffixes).

/** `... N more lines (<key> to expand)` — collapsed footer under a bounded preview. */
export function moreLinesHint(hidden: number, theme: Theme): string {
	return `${theme.fg("muted", `... ${hidden} more lines (`)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

/** `(<key> to collapse)` — expanded footer. */
export function collapseHint(theme: Theme): string {
	return `${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`;
}

/** `(<key> to expand)` — inline suffix on a one-line collapsed summary. */
export function expandHint(theme: Theme): string {
	return `${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

/** Two-space-indented `toolOutput` body: `\n  <line>` per input line. */
export function indentedOutput(lines: string[], theme: Theme): string {
	let text = "";
	for (const line of lines) text += `\n  ${theme.fg("toolOutput", line)}`;
	return text;
}

/**
 * The expanded tool-result block: a top spacer + the result text rendered as
 * Markdown with pi's markdown theme (via `getMarkdownTheme()`). This is the
 * byte-identical block that was inlined in `advisor/index.ts` and
 * `deepwiki/index.ts`; factored here so both (and future tools) share one
 * implementation.
 */
export function markdownResultBlock(text: string): Component {
	const container = new Container();
	container.addChild(new Spacer(1));
	container.addChild(new Markdown(text, 1, 0, getMarkdownTheme()));
	return container;
}

export function renderNumberedLines(lines: string[], startLine: number, theme: Theme): string[] {
	const maxLine = Math.max(startLine, startLine + Math.max(0, lines.length - 1));
	const width = String(maxLine).length;
	return lines.map((line, index) => {
		const lineNumber = String(startLine + index).padStart(width, " ");
		return `  ${theme.fg("dim", lineNumber)} ${theme.fg("dim", "│")} ${theme.fg("toolOutput", line)}`;
	});
}

function tryFormatJson(line: string): string {
	try {
		const parsed = JSON.parse(line);
		const stringified = JSON.stringify(parsed, null, 2);
		const normalizedOriginal = line.replace(/\s+/g, "");
		const normalizedStringified = stringified.replace(/\s+/g, "");
		if (normalizedOriginal !== normalizedStringified) return line;
		return stringified;
	} catch {
		return line;
	}
}

const MAX_JSON_FORMAT_LENGTH = 10_000;

export function tryJsonFormatContent(content: string): string {
	if (content.length > MAX_JSON_FORMAT_LENGTH) return content;
	return content.split("\n").map(tryFormatJson).join("\n");
}

const URL_RE = /https?:\/\/[^\s"'<>\\]+/g;

export function linkifyUrlsInText(content: string): string {
	if (!getCapabilities().hyperlinks) return content;
	return content.replace(URL_RE, (url) => hyperlink(url, url));
}

// ============================================================================
// buildStandardRenderer
// ============================================================================
//
// Folds the 4-branch renderResult skeleton shared by tools whose collapsed +
// expanded output is a text summary / markdown block. Each branch is a small
// callback, so the surrounding control flow lives in one place:
//
//   1. isPartial         → activeDotLine(name, partialLabel)
//   2. error / details   → errorResultLine(errorMessage)
//   3. !expanded         → resultLine(accent(collapsedLine))
//   4. expanded          → markdownResultBlock(text)
//
// Tools with domain-specific rendering (e.g. question's multi-answer layout,
// todo's status-mark coloring) keep their custom renderResult — the builder
// would need a per-tool escape hatch that defeats the savings.

export interface StandardRendererConfig<TDetails> {
	name: string;
	callSuffix: (args: Record<string, unknown>, theme: Theme) => string;
	partialLabel: (details: TDetails | undefined, theme: Theme) => string;
	errorMessage: (text: string, details: TDetails | undefined) => string;
	collapsedLine: (text: string, details: TDetails | undefined, theme: Theme) => string;
}

export function buildStandardRenderer<TDetails>(cfg: StandardRendererConfig<TDetails>) {
	return {
		renderCall(args: Record<string, unknown>, theme: Theme): Component {
			return new Text(callLine(cfg.name, cfg.callSuffix(args, theme), theme), 0, 0);
		},
		renderResult(
			result: AgentToolResult<TDetails>,
			options: ToolRenderResultOptions,
			theme: Theme,
			ctx: RenderCtx,
		): Component {
			if (options.isPartial) {
				return new Text(activeDotLine(cfg.name, cfg.partialLabel(result.details, theme), theme), 0, 0);
			}
			const text = firstText(result);
			if (ctx.isError || (result.details as { errorMessage?: unknown } | undefined)?.errorMessage) {
				return new Text(errorResultLine(cfg.errorMessage(text, result.details), options.expanded, theme), 0, 0);
			}
			if (!options.expanded) {
				return new Text(resultLine(cfg.collapsedLine(text, result.details, theme), theme, "accent"), 0, 0);
			}
			return markdownResultBlock(text);
		},
	};
}

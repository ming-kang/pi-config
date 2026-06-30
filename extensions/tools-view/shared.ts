import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, getCapabilities, hyperlink, Markdown, Spacer } from "@earendil-works/pi-tui";

export const BULLET = "●";
export const RESULT_PREFIX = "│ ";

export interface RenderCtx {
	args: Record<string, unknown>;
	state: Record<string, unknown>;
	invalidate: () => void;
	isError: boolean;
}

export function textLineCount(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

export function fmtSize(base64Len: number): string {
	const bytes = Math.floor((base64Len * 3) / 4);
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function callLine(toolName: string, args: string, theme: Theme, dotColor: ThemeColor = "success"): string {
	// Trim args so a caller passing a stray leading/trailing space doesn't render
	// "Tool( args)". The value is theme-colored text, so trimming only removes the
	// literal padding around it, never the visible content or its color codes.
	const a = args.trim();
	return `${theme.fg(dotColor, BULLET)} ${theme.fg("toolTitle", theme.bold(toolName))}${a ? theme.fg("dim", `(${a})`) : ""}`;
}

export function activeDotLine(toolName: string, body: string, theme: Theme): string {
	return `${theme.fg("warning", BULLET)} ${theme.fg("toolTitle", theme.bold(toolName))}${theme.fg("dim", body)}`;
}

export function resultLine(info: string, theme: Theme): string {
	return `${theme.fg("dim", RESULT_PREFIX)}${theme.fg("dim", info)}`;
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
	return expanded ? errLine(message, theme) : resultLine(theme.fg("error", message), theme);
}

export function emptyLine(label: string, theme: Theme): string {
	return `  ${theme.fg("muted", label)}`;
}

/**
 * The expanded tool-result block: a top spacer + the result text rendered as
 * Markdown with pi's markdown theme. This is the byte-identical block that was
 * inlined in `advisor/index.ts` and `deepwiki/index.ts`; factored here so both
 * (and future tools) share one implementation. `theme` is unused — the markdown
 * theme comes from `getMarkdownTheme()` to match the prior inlined calls.
 */
export function markdownResultBlock(text: string, _theme?: Theme): Component {
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

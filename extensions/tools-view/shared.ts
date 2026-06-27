import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";

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

export function emptyLine(label: string, theme: Theme): string {
	return `  ${theme.fg("muted", label)}`;
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

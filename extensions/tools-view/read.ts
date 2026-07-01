import type { AgentToolResult, ReadToolDetails, Theme } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition, keyHint, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	activeDotLine,
	callLine,
	emptyLine,
	errLine,
	firstImage,
	firstLineError,
	firstTextBlock,
	linkifyUrlsInText,
	resultLine,
	type RenderCtx,
} from "./shared.ts";
import { formatSize } from "../shared/text.ts";

interface ReadDisplayLines {
	fileLines: string[];
	noticeLines: string[];
}

function isReadBackendNotice(line: string): boolean {
	const trimmed = line.trim();
	return (
		trimmed.startsWith("[Showing lines ") ||
		/^\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/.test(trimmed) ||
		/^\[Line \d+ is .+ exceeds .+ limit\. Use bash: .+\]$/.test(trimmed)
	);
}

function splitReadOutput(text: string): ReadDisplayLines {
	const lines = text.split("\n");
	let noticeStart = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (isReadBackendNotice(lines[i] ?? "")) {
			noticeStart = i;
			break;
		}
		if ((lines[i] ?? "").trim() !== "") break;
	}
	if (noticeStart === -1) return { fileLines: lines, noticeLines: [] };
	if (noticeStart > 0 && (lines[noticeStart - 1] ?? "").trim() === "") noticeStart--;
	return {
		fileLines: lines.slice(0, noticeStart),
		noticeLines: lines.slice(noticeStart),
	};
}

function renderReadNotice(line: string, theme: Theme): string {
	if (line.trim() === "") return "";
	const color = line.trim().startsWith("[Line ") ? "warning" : "muted";
	return `  ${theme.fg(color, linkifyUrlsInText(line))}`;
}

export function createReadRenderer(cwd: string) {
	const base = createReadToolDefinition(cwd);
	return {
		...base,
		renderShell: "self" as const,

		renderCall(args: Record<string, unknown>, theme: Theme) {
			const parts: string[] = [String(args.path ?? "...")];
			if (args.offset) parts.push(`offset=${args.offset}`);
			if (args.limit) parts.push(`limit=${args.limit}`);
			return new Text(callLine("Read", parts.join(" "), theme), 0, 0);
		},

		renderResult(result: AgentToolResult<ReadToolDetails>, options: ToolRenderResultOptions, theme: Theme, ctx: RenderCtx) {
			const { expanded, isPartial } = options;
			if (isPartial) return new Text(activeDotLine("Read", " Reading...", theme), 0, 0);
			// base.renderResult expects Pi's full ToolRenderContext (not publicly
			// exported); RenderCtx is a structural subset, so narrow via the base's
			// own parameter type rather than `as any`.
			if (expanded) return base.renderResult(result, options, theme, ctx as Parameters<typeof base.renderResult>[3]);

			const details = result.details as ReadToolDetails | undefined;
			const image = firstImage(result);
			// Distinguish "no text block" (error) from "empty text block" (success:
			// an empty file). firstText() collapses both to "", so read the block.
			const textBlock = firstTextBlock(result);
			const noteText = textBlock?.text ?? "";
			const isImage = !!image || noteText.startsWith("Read image file");

			if (ctx.isError) {
				return new Text(errLine(firstLineError(result, "read failed"), theme), 0, 0);
			}

			if (isImage) {
				const mimeMatch = noteText.match(/\[([^\]]+)\]/);
				const mime = mimeMatch ? mimeMatch[1] : "";
				const size = image ? formatSize(Math.floor((image.data.length * 3) / 4)) : "";
				const detail = [mime, size].filter(Boolean).join(", ");
				const text = resultLine(`Read image${detail ? ` (${detail})` : ""}`, theme);
				return new Text(text, 0, 0);
			}

			if (!textBlock) return new Text(errLine("no content", theme), 0, 0);

			const { fileLines, noticeLines } = splitReadOutput(noteText);
			const lineCount = noteText.length === 0 ? 0 : fileLines.length;
			const truncInfo = details?.truncation?.truncated ? ` (truncated from ${details.truncation.totalLines})` : "";
			let text = resultLine(`Read ${lineCount} ${lineCount === 1 ? "line" : "lines"}${truncInfo}`, theme);
			if (noteText.length === 0) {
				text += `\n${emptyLine("(empty file)", theme)}`;
				return new Text(text, 0, 0);
			}

			text += ` ${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
			if (noticeLines.length > 0) for (const line of noticeLines) text += `\n${renderReadNotice(line, theme)}`;
			return new Text(text, 0, 0);
		},
	};
}

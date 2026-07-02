import { type AgentToolResult, createWriteToolDefinition, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	activeDotLine,
	callLine,
	emptyLine,
	errLine,
	firstLineError,
	linkifyUrlsInText,
	moreLinesHint,
	renderNumberedLines,
	resultLine,
	textLineCount,
	type RenderCtx,
} from "./shared.ts";

export function createWriteRenderer(cwd: string) {
	return {
		...createWriteToolDefinition(cwd),
		renderShell: "self" as const,

		renderCall(args: Record<string, unknown>, theme: Theme) {
			const filePath = String(args.path ?? "...");
			const suffix = typeof args.content === "string" ? ` · ${textLineCount(args.content)} lines` : "";
			return new Text(callLine("Write", `${filePath}${suffix}`, theme), 0, 0);
		},

		renderResult(result: AgentToolResult<undefined>, options: ToolRenderResultOptions, theme: Theme, ctx: RenderCtx) {
			const { expanded, isPartial } = options;
			if (isPartial) return new Text(activeDotLine("Write", " Writing...", theme), 0, 0);

			if (ctx.isError) {
				return new Text(errLine(firstLineError(result, "write failed"), theme), 0, 0);
			}

			const filePath = String(ctx.args?.path ?? "");
			const writtenContent = String(ctx.args?.content ?? "");
			const lineCount = textLineCount(writtenContent);
			const pathDisplay = filePath.split(/[/\\]/).pop() || filePath;
			let text = resultLine(`Wrote ${lineCount} ${lineCount === 1 ? "line" : "lines"} to ${pathDisplay}`, theme, "success");

			if (writtenContent.length === 0) {
				text += `\n${emptyLine("(empty content)", theme)}`;
				return new Text(text, 0, 0);
			}

			const allWriteLines = linkifyUrlsInText(writtenContent).split("\n");
			const maxLines = expanded ? allWriteLines.length : 10;
			for (const line of renderNumberedLines(allWriteLines.slice(0, maxLines), 1, theme)) text += `\n${line}`;
			const remaining = allWriteLines.length - maxLines;
			if (remaining > 0) {
				text += `\n  ${moreLinesHint(remaining, theme)}`;
			}
			return new Text(text, 0, 0);
		},
	};
}

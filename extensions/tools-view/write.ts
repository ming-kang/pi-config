import { createWriteToolDefinition, keyHint, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	activeDotLine,
	callLine,
	emptyLine,
	errLine,
	linkifyUrlsInText,
	renderNumberedLines,
	RESULT_PREFIX,
	textLineCount,
	type RenderCtx,
} from "./shared.ts";

export function createWriteRenderer(cwd: string) {
	return {
		...createWriteToolDefinition(cwd),
		renderShell: "self" as const,

		renderCall(args: Record<string, unknown>, theme: Theme) {
			const filePath = String(args.path ?? "…");
			const suffix = typeof args.content === "string" ? ` · ${textLineCount(args.content)} lines` : "";
			return new Text(callLine("Write", `${filePath}${suffix}`, theme), 0, 0);
		},

		renderResult(result: any, options: ToolRenderResultOptions, theme: Theme, ctx = {} as RenderCtx) {
			const { expanded, isPartial } = options;
			if (isPartial) return new Text(activeDotLine("Write", " Writing…", theme), 0, 0);

			if (ctx.isError) {
				const textBlock = (result.content ?? []).find((c: any) => c?.type === "text");
				const msg = textBlock?.type === "text" ? textBlock.text.split("\n")[0] : "write failed";
				return new Text(errLine(msg, theme), 0, 0);
			}

			const filePath = String(ctx.args?.path ?? "");
			const writtenContent = String(ctx.args?.content ?? "");
			const lineCount = textLineCount(writtenContent);
			const pathDisplay = filePath.split(/[/\\]/).pop() || filePath;
			let text =
				theme.fg("dim", RESULT_PREFIX) +
				theme.fg("success", `Wrote ${lineCount} ${lineCount === 1 ? "line" : "lines"} to ${pathDisplay}`);

			if (writtenContent.length === 0) {
				text += `\n${emptyLine("(empty content)", theme)}`;
				return new Text(text, 0, 0);
			}

			const allWriteLines = linkifyUrlsInText(writtenContent).split("\n");
			const maxLines = expanded ? allWriteLines.length : 10;
			for (const line of renderNumberedLines(allWriteLines.slice(0, maxLines), 1, theme)) text += `\n${line}`;
			const remaining = allWriteLines.length - maxLines;
			if (remaining > 0) {
				text += `\n  ${theme.fg("muted", `… (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
			}
			return new Text(text, 0, 0);
		},
	};
}

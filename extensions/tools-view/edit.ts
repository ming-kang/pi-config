import type { AgentToolResult, EditToolDetails, Theme } from "@earendil-works/pi-coding-agent";
import { createEditToolDefinition, keyHint, renderDiff as renderPiDiff, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { activeDotLine, callLine, errLine, resultLine, type RenderCtx } from "./shared.ts";

// Collapsed edit results cap the diff at this many lines; expand (Ctrl+O) shows
// the full diff. Diffs are the core signal of an edit, so the cap is generous —
// only genuinely large diffs collapse, matching read/bash/write expand behavior.
const COLLAPSED_DIFF_LIMIT = 15;

function indentBlock(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

export function createEditRenderer(cwd: string) {
	return {
		...createEditToolDefinition(cwd),
		renderShell: "self" as const,

		renderCall(args: Record<string, unknown>, theme: Theme) {
			return new Text(callLine("Edit", String(args.path ?? "..."), theme), 0, 0);
		},

		renderResult(result: AgentToolResult<EditToolDetails>, options: ToolRenderResultOptions, theme: Theme, ctx: RenderCtx) {
			const { expanded, isPartial } = options;
			if (isPartial) return new Text(activeDotLine("Edit", " Editing...", theme), 0, 0);

			const details = result.details as EditToolDetails | undefined;
			if (ctx.isError) {
				const textBlock = (result.content ?? []).find((c: any) => c?.type === "text");
				const msg = textBlock?.type === "text" ? textBlock.text.split("\n")[0] : "edit failed";
				return new Text(errLine(msg, theme), 0, 0);
			}

			if (!details?.diff) return new Text(resultLine("applied", theme), 0, 0);

			const diffLines = details.diff.split("\n");
			let additions = 0;
			let removals = 0;
			for (const line of diffLines) {
				if (line.startsWith("+") && !line.startsWith("+++")) additions++;
				if (line.startsWith("-") && !line.startsWith("---")) removals++;
			}
			let text = resultLine(`+${additions} -${removals}`, theme);
			const filePath = typeof ctx.args?.path === "string" ? ctx.args.path : undefined;
			const rendered = renderPiDiff(details.diff, { filePath }).split("\n");
			const shown = expanded ? rendered : rendered.slice(0, COLLAPSED_DIFF_LIMIT);
			text += `\n${indentBlock(shown.join("\n"))}`;
			const hidden = rendered.length - shown.length;
			if (hidden > 0) {
				text += `\n  ${theme.fg("muted", `... ${hidden} more lines (`)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
			} else if (expanded && rendered.length > COLLAPSED_DIFF_LIMIT) {
				text += `\n  ${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`;
			}
			return new Text(text, 0, 0);
		},
	};
}

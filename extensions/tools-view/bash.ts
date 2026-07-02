import type { AgentToolResult, BashToolDetails, Theme } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	BULLET,
	callLine,
	collapseHint,
	errLine,
	firstText,
	indentedOutput,
	linkifyUrlsInText,
	moreLinesHint,
	resultLine,
	tryJsonFormatContent,
	type RenderCtx,
} from "./shared.ts";

interface BashOutputView {
	bodyLines: string[];
	failureLabel: string | null;
}

function splitBashOutput(output: string, isError: boolean): BashOutputView {
	if (!output) return { bodyLines: [], failureLabel: null };

	const lines = output.split("\n");
	let lastContent = lines.length - 1;
	while (lastContent >= 0 && lines[lastContent]?.trim() === "") lastContent--;
	if (lastContent < 0) return { bodyLines: [], failureLabel: null };

	const status = lines[lastContent]!.trim();
	let failureLabel: string | null = null;
	let consumesStatusLine = false;
	const exitMatch = isError ? status.match(/^Command exited with code (\d+)$/) : null;
	const legacyExitMatch = status.match(/^exit code: (\d+)$/);
	const timeoutMatch = isError ? status.match(/^Command timed out after ([^ ]+) seconds$/) : null;
	if (exitMatch) {
		consumesStatusLine = true;
		failureLabel = `exit ${exitMatch[1]}`;
	} else if (legacyExitMatch && (isError || legacyExitMatch[1] === "0")) {
		consumesStatusLine = true;
		failureLabel = legacyExitMatch[1] === "0" ? null : `exit ${legacyExitMatch[1]}`;
	} else if (timeoutMatch) {
		consumesStatusLine = true;
		failureLabel = `timeout ${timeoutMatch[1]}s`;
	} else if (isError && status === "Command aborted") {
		consumesStatusLine = true;
		failureLabel = "aborted";
	}

	if (!consumesStatusLine) return { bodyLines: lines, failureLabel: null };

	const bodyLines = lines.slice(0, lastContent);
	while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1]!.trim() === "") bodyLines.pop();
	return { bodyLines, failureLabel };
}

export function createBashRenderer(cwd: string) {
	return {
		...createBashToolDefinition(cwd),
		renderShell: "self" as const,

		renderCall(args: Record<string, unknown>, theme: Theme) {
			const cmd = truncateToWidth(String(args.command ?? "..."), 80, "...");
			const tail = args.timeout ? ` timeout=${args.timeout}s` : "";
			return new Text(callLine("Bash", cmd + tail, theme), 0, 0);
		},

		renderResult(result: AgentToolResult<BashToolDetails>, options: ToolRenderResultOptions, theme: Theme, ctx: RenderCtx) {
			const { expanded, isPartial } = options;
			const details = result.details as BashToolDetails | undefined;
			const output = firstText(result);
			const { bodyLines, failureLabel } = splitBashOutput(output, ctx.isError);
			const visible = bodyLines.filter((line) => line.trim());
			const bodyCount = visible.length;

			if (isPartial) {
				const s = (ctx.state ?? {}) as { blink?: number };
				s.blink = ((s.blink ?? 0) + 1) % 2;
				const dot = s.blink ? theme.fg("warning", BULLET) : " ";
				const preview = bodyLines.map((line) => line.trim()).filter(Boolean).slice(-5).join("\n  ");
				let text = `${dot} ${theme.fg("toolTitle", theme.bold("Bash"))}`;
				if (preview) {
					text += `\n  ${theme.fg("dim", preview)}`;
					if (bodyCount > 5) text += `\n  ${theme.fg("muted", `... ${bodyCount - 5} lines`)}`;
				} else {
					text += theme.fg("dim", " Running...");
				}
				if (details?.truncation?.truncated) text += theme.fg("warning", " (truncating)");
				return new Text(text, 0, 0);
			}

			let text: string;
			if (ctx.isError || failureLabel) {
				text = errLine(failureLabel ?? "failed", theme);
			} else if (bodyCount === 0) {
				text = resultLine("done (no output)", theme);
			} else {
				text = resultLine(`done (${bodyCount} lines)`, theme);
			}
			if (details?.truncation?.truncated) text += theme.fg("warning", " [truncated]");

			if (visible.length > 0) {
				if (expanded) {
					const displayContent = linkifyUrlsInText(tryJsonFormatContent(bodyLines.join("\n")));
					text += indentedOutput(displayContent.split("\n"), theme);
				} else {
					text += indentedOutput(visible.slice(-5), theme);
				}
				const hidden = Math.max(0, bodyCount - 5);
				if (hidden > 0) {
					text += `\n  ${expanded ? collapseHint(theme) : moreLinesHint(hidden, theme)}`;
				}
			}
			return new Text(text, 0, 0);
		},
	};
}

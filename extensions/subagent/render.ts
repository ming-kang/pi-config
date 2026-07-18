/** Compact/expanded TUI rendering for subagent tool calls. */
import type {
	AgentToolResult,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Markdown,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";

import { SUBAGENT_TOOL_LABEL } from "./constants.ts";
import { formatTokens } from "./format.ts";
import type { SubagentParams } from "./schema.ts";
import type { SubagentDetails } from "./types.ts";

function oneLine(text: string, maxChars: number): string {
	const flattened = text
		.replace(/[\r\n\t]+/g, " ")
		.replace(/ +/g, " ")
		.trim();
	return flattened.length <= maxChars
		? flattened
		: `${flattened.slice(0, Math.max(1, maxChars - 3))}...`;
}

function firstText(result: AgentToolResult<SubagentDetails>): string {
	for (const part of result.content ?? []) {
		if (part.type === "text" && typeof part.text === "string") return part.text;
	}
	return "";
}

function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) ?? "Done"
	);
}

export function renderSubagentCall(
	args: SubagentParams,
	theme: Theme,
): Component {
	let line = theme.fg("toolTitle", theme.bold(`${SUBAGENT_TOOL_LABEL} `));
	line += theme.fg("muted", args.action);
	if (args.id) line += ` ${theme.fg("accent", args.id)}`;
	if (args.action === "spawn") {
		const count = args.tasks?.length ?? 1;
		const agent = args.agent ?? args.tasks?.[0]?.agent ?? "general";
		line += ` ${theme.fg("accent", count > 1 ? `${count} workers` : agent)}`;
		const task = args.task ?? args.tasks?.[0]?.task;
		if (task) line += ` ${theme.fg("dim", oneLine(task, 72))}`;
	}
	return new Text(line, 0, 0);
}

function summarizeDetails(
	details: SubagentDetails | undefined,
	fallback: string,
): string {
	if (!details) return oneLine(firstLine(fallback), 180);
	const agents = details.agents;
	if (details.action === "list") {
		const active = agents.filter(
			(agent) => agent.status === "starting" || agent.status === "running",
		).length;
		const queued = agents.filter((agent) => agent.status === "queued").length;
		return `${active} active · ${queued} queued · ${agents.length}/${details.config.maxAgents} retained`;
	}
	if (details.action === "spawn") {
		const ids = agents
			.slice(0, 3)
			.map((agent) => `${agent.id} ${agent.status}`)
			.join(" · ");
		return `${agents.length} background worker${agents.length === 1 ? "" : "s"} started${ids ? ` · ${ids}` : ""}`;
	}
	const agent = agents[0];
	if (agent) {
		const stats = [
			`${agent.toolUses} tool use${agent.toolUses === 1 ? "" : "s"}`,
			agent.outputTokens ? `↓${formatTokens(agent.outputTokens)} tokens` : "",
		]
			.filter(Boolean)
			.join(" · ");
		return `${agent.id} ${agent.status} · ${oneLine(agent.label, 72)} · ${stats}`;
	}
	return oneLine(firstLine(fallback), 180);
}

function expandedMarkdown(text: string): Component {
	const container = new Container();
	container.addChild(new Spacer(1));
	container.addChild(
		new Markdown(text || "(no output)", 1, 0, getMarkdownTheme()),
	);
	return container;
}

export function renderSubagentResult(
	result: AgentToolResult<SubagentDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
): Component {
	const text = firstText(result);
	if (options.isPartial) {
		return new Text(theme.fg("warning", "Working..."), 0, 0);
	}
	if (isError || result.details?.errorCode) {
		return new Text(theme.fg("error", oneLine(firstLine(text), 220)), 0, 0);
	}
	if (options.expanded) return expandedMarkdown(text);

	const summary = theme.fg("accent", summarizeDetails(result.details, text));
	const viewHint =
		result.details?.action === "spawn" || result.details?.action === "send"
			? theme.fg("dim", "alt+o view · ")
			: "";
	const hint = `${theme.fg("muted", "(")}${viewHint}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	return new Text(`${summary}\n${hint}`, 0, 0);
}

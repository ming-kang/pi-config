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
import { formatAgentType, formatTokens, oneLine } from "./format.ts";
import type { SubagentParams } from "./schema.ts";
import type { SubagentDetails } from "./types.ts";

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
	const action = args.action ?? "spawn";
	let line = theme.fg("toolTitle", theme.bold(`${SUBAGENT_TOOL_LABEL}`));
	if (action !== "spawn") {
		line += ` ${theme.fg("muted", action)}`;
	}
	if (args.id) line += ` ${theme.fg("accent", args.id)}`;
	if (action === "spawn") {
		const count = args.tasks?.length ?? 1;
		const agent = args.agent ?? args.tasks?.[0]?.agent ?? "general";
		const display =
			count > 1 ? `${count} workers` : formatAgentType(agent);
		line += ` ${theme.fg("accent", display)}`;
		const desc =
			args.description ??
			args.label ??
			args.tasks?.[0]?.description ??
			args.tasks?.[0]?.label;
		if (desc) line += ` ${theme.fg("muted", oneLine(desc, 48))}`;
		else {
			const task =
				args.prompt ?? args.task ?? args.tasks?.[0]?.prompt ?? args.tasks?.[0]?.task;
			if (task) line += ` ${theme.fg("dim", oneLine(task, 56))}`;
		}
	} else if (action === "send") {
		if (args.fresh) line += ` ${theme.fg("accent", "fresh")}`;
		if (args.message) line += ` ${theme.fg("dim", oneLine(args.message, 72))}`;
	}
	return new Text(line, 0, 0);
}

function summarizeDetails(
	details: SubagentDetails | undefined,
	fallback: string,
): string {
	if (!details) return oneLine(firstLine(fallback), 180);
	const agents = details.agents;
	if (details.action === "read_list") {
		const active = agents.filter(
			(agent) => agent.status === "starting" || agent.status === "running",
		).length;
		const queued = agents.filter((agent) => agent.status === "queued").length;
		return `${active} active · ${queued} queued · ${agents.length}/${details.config.maxAgents} retained`;
	}
	if (details.action === "spawn") {
		const types = new Map<string, number>();
		for (const agent of agents) {
			types.set(agent.agent, (types.get(agent.agent) ?? 0) + 1);
		}
		const typeSummary = [...types.entries()]
			.map(([name, count]) => (count === 1 ? name : `${count} ${name}`))
			.join(", ");
		return `${agents.length} worker${agents.length === 1 ? "" : "s"} started${typeSummary ? ` · ${typeSummary}` : ""}`;
	}
	const agent = agents[0];
	if (agent) {
		const stats = [
			agent.status,
			agent.agent,
			agent.toolUses
				? `${agent.toolUses} tool use${agent.toolUses === 1 ? "" : "s"}`
				: "",
			agent.outputTokens ? `↓${formatTokens(agent.outputTokens)}` : "",
		]
			.filter(Boolean)
			.join(" · ");
		return `${agent.id} · ${stats}`;
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
		return new Text(theme.fg("warning", "Working…"), 0, 0);
	}
	if (isError || result.details?.errorCode) {
		return new Text(theme.fg("error", oneLine(firstLine(text), 220)), 0, 0);
	}
	if (options.expanded) return expandedMarkdown(text);

	const summary = theme.fg("accent", summarizeDetails(result.details, text));
	const hint = `${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	return new Text(`${summary}\n${hint}`, 0, 0);
}

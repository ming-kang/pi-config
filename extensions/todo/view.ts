import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import type { TodoItem, TodoState, TodoStatus } from "./types.ts";

export const STATUS_MARK: Record<TodoStatus, string> = {
	pending: "[ ]",
	in_progress: "[>]",
	completed: "[x]",
	deleted: "[-]",
};

export const STATUS_COLOR: Record<TodoStatus, "dim" | "warning" | "success" | "muted"> = {
	pending: "dim",
	in_progress: "warning",
	completed: "success",
	deleted: "muted",
};

function visibleTodos(state: TodoState): TodoItem[] {
	return state.items.filter((item) => item.status !== "deleted");
}

function todoCounts(state: TodoState): { total: number; pending: number; inProgress: number; completed: number } {
	const visible = visibleTodos(state);
	return {
		total: visible.length,
		pending: visible.filter((item) => item.status === "pending").length,
		inProgress: visible.filter((item) => item.status === "in_progress").length,
		completed: visible.filter((item) => item.status === "completed").length,
	};
}

export function renderOverlayLines(state: TodoState, theme: Theme, width: number, hiddenCompleted: ReadonlySet<number>): string[] {
	const visible = visibleTodos(state).filter((item) => item.status !== "completed" || !hiddenCompleted.has(item.id));
	if (!visible.length) return [];

	const counts = todoCounts({ items: visible, nextId: state.nextId });
	const hasActive = visible.some((item) => item.status === "pending" || item.status === "in_progress");
	const heading = `${theme.fg(hasActive ? "accent" : "dim", "Todos")} ${theme.fg("dim", `(${counts.completed}/${counts.total})`)}`;
	const lines = [truncateToWidth(heading, width, "...")];

	const maxBody = 10;
	const showIds = visible.some((item) => item.blockedBy?.length);
	const body = chooseOverlayItems(visible, maxBody);
	for (const item of body.items) {
		lines.push(truncateToWidth(`  ${formatOverlayItem(item, theme, showIds)}`, width, "..."));
	}
	if (body.hidden > 0) lines.push(truncateToWidth(theme.fg("dim", `  +${body.hidden} more`), width, "..."));
	lines.push("");
	return lines;
}

function chooseOverlayItems(items: TodoItem[], maxBody: number): { items: TodoItem[]; hidden: number } {
	if (items.length <= maxBody) return { items, hidden: 0 };
	const nonCompleted = items.filter((item) => item.status !== "completed");
	if (nonCompleted.length >= maxBody) return { items: nonCompleted.slice(0, maxBody - 1), hidden: items.length - (maxBody - 1) };

	const chosen = new Set<TodoItem>(nonCompleted);
	for (const item of items) {
		if (chosen.size >= maxBody - 1) break;
		if (item.status === "completed") chosen.add(item);
	}
	const selected = items.filter((item) => chosen.has(item));
	return { items: selected, hidden: items.length - selected.length };
}

function formatOverlayItem(item: TodoItem, theme: Theme, showId: boolean): string {
	let text = theme.fg(STATUS_COLOR[item.status], STATUS_MARK[item.status]);
	if (showId) text += ` ${theme.fg("accent", `#${item.id}`)}`;
	const subject = item.status === "completed" ? theme.strikethrough(theme.fg("dim", item.subject)) : theme.fg("text", item.subject);
	text += ` ${subject}`;
	if (item.status === "in_progress" && item.activeForm) text += ` ${theme.fg("dim", `(${item.activeForm})`)}`;
	if (item.blockedBy?.length) text += ` ${theme.fg("dim", `blocked by ${item.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
	return text;
}

export function formatCommandList(state: TodoState): string {
	const visible = visibleTodos(state);
	if (!visible.length) return "No todos yet.";
	const lines: string[] = [];
	for (const status of ["in_progress", "pending", "completed"] as const) {
		const group = visible.filter((item) => item.status === status);
		if (!group.length) continue;
		lines.push(status);
		for (const item of group) {
			const active = item.status === "in_progress" && item.activeForm ? ` (${item.activeForm})` : "";
			const deps = item.blockedBy?.length ? ` blocked by ${item.blockedBy.map((id) => `#${id}`).join(",")}` : "";
			lines.push(`  ${STATUS_MARK[item.status]} #${item.id} ${item.subject}${active}${deps}`);
		}
	}
	return lines.join("\n");
}

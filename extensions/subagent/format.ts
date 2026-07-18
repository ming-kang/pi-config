/** Shared presentation constants and formatters for the subagent TUI surfaces. */

import type {
	SubagentSnapshot,
	SubagentStatus,
	SubagentUsage,
} from "./types.ts";

/** Pulse-style spinner frames; all surfaces derive the frame from wall-clock time so they animate in sync. */
export const SPINNER_FRAMES = (() => {
	const chars = ["·", "✢", "*", "✶", "✻", "✽"];
	return [...chars, ...[...chars].reverse()];
})();

export const SPINNER_INTERVAL_MS = 120;

export function spinnerFrame(now = Date.now()): string {
	const index =
		Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
	return SPINNER_FRAMES[index] ?? "·";
}

export const STATUS_ICON: Record<SubagentStatus, string> = {
	queued: "○",
	starting: "◌",
	running: "●",
	completed: "✓",
	failed: "✗",
	stopped: "■",
};

export const STATUS_COLOR: Record<
	SubagentStatus,
	"dim" | "warning" | "success" | "error" | "muted"
> = {
	queued: "dim",
	starting: "warning",
	running: "warning",
	completed: "success",
	failed: "error",
	stopped: "muted",
};

export function isActiveStatus(status: SubagentStatus): boolean {
	return status === "running" || status === "starting";
}

export function isTerminalStatus(status: SubagentStatus): boolean {
	return (
		status === "completed" || status === "failed" || status === "stopped"
	);
}

/**
 * Stable list order shared by the footer widget and the panel's Tab cycle:
 * pending/active workers first, finished ones sink below, spawn order within
 * each group. A row moves at most once (when it finishes) and never trades
 * places with its neighbors just because it produced output more recently.
 */
export function sortSnapshots(
	snapshots: SubagentSnapshot[],
): SubagentSnapshot[] {
	return [...snapshots].sort((first, second) => {
		const firstDone = isTerminalStatus(first.status) ? 1 : 0;
		const secondDone = isTerminalStatus(second.status) ? 1 : 0;
		return (
			firstDone - secondDone ||
			first.createdAt - second.createdAt ||
			first.id.localeCompare(second.id)
		);
	});
}

export function formatDuration(
	start: number | undefined,
	end = Date.now(),
): string {
	if (!start) return "";
	const seconds = Math.max(0, Math.floor((end - start) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Flatten to a single line and clip to maxChars with an ellipsis. */
export function oneLine(text: string, maxChars = 160): string {
	const flattened = text
		.replace(/[\r\n\t]+/g, " ")
		.replace(/ +/g, " ")
		.trim();
	return flattened.length <= maxChars
		? flattened
		: `${flattened.slice(0, Math.max(1, maxChars - 3))}...`;
}

export function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Uniform stats phrasing used by list rows, detail headers, and completion summaries. */
export function formatStats(
	usage: SubagentUsage,
	options?: { includeCost?: boolean },
): string {
	const parts = [
		usage.toolUses
			? `${usage.toolUses} tool use${usage.toolUses === 1 ? "" : "s"}`
			: "",
		usage.output ? `↓${formatTokens(usage.output)} tokens` : "",
		options?.includeCost && usage.cost ? `$${usage.cost.toFixed(4)}` : "",
	].filter(Boolean);
	return parts.join(" · ");
}

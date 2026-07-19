/** Shared presentation constants and formatters for the subagent TUI surfaces. */

import { randomBytes } from "node:crypto";

import type {
	SubagentSnapshot,
	SubagentStatus,
	SubagentUsage,
} from "./types.ts";

/**
 * Pi-native braille frames (same family as `@earendil-works/pi-tui` Loader).
 * Used by the top-right preview while workers are active.
 */
export const BRAILLE_FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏",
] as const;

/** Match `@earendil-works/pi-tui` Loader default interval. */
export const BRAILLE_INTERVAL_MS = 80;

export function brailleFrame(now = Date.now()): string {
	const index =
		Math.floor(now / BRAILLE_INTERVAL_MS) % BRAILLE_FRAMES.length;
	return BRAILLE_FRAMES[index] ?? "⠋";
}

/** Static status glyphs for terminal / idle workers. */
export const STATUS_ICON: Record<SubagentStatus, string> = {
	queued: "○",
	starting: "●",
	running: "●",
	completed: "✓",
	failed: "✗",
	stopped: "■",
};

export const STATUS_COLOR: Record<
	SubagentStatus,
	"dim" | "warning" | "success" | "error" | "muted" | "accent"
> = {
	queued: "dim",
	starting: "accent",
	running: "accent",
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
 * Fixed spawn order for Tab cycle and lists: never re-rank by status so
 * finished workers do not jump under active ones.
 */
export function sortSnapshots(
	snapshots: SubagentSnapshot[],
): SubagentSnapshot[] {
	return [...snapshots].sort(
		(first, second) =>
			first.createdAt - second.createdAt ||
			first.id.localeCompare(second.id),
	);
}

/** Wire id: `a` + 8 hex (Claude Code–style short agent id). */
export function createWorkerId(): string {
	return `a${randomBytes(4).toString("hex")}`;
}

/** Display type title: explorer → Explorer. */
export function formatAgentType(agentName: string): string {
	const trimmed = agentName.trim();
	if (!trimmed) return "Worker";
	return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Short type for tight tabs: explorer → Exp, general → Gen. */
export function shortAgentType(agentName: string): string {
	const lower = agentName.trim().toLowerCase();
	if (lower === "explorer") return "Exp";
	if (lower === "general") return "Gen";
	if (lower.length <= 4) return formatAgentType(lower);
	return formatAgentType(lower).slice(0, 3);
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

/** Truncate to an exact character budget, including the omission notice. */
export function truncateText(
	text: string,
	maxChars: number,
	label = "output",
): string {
	const budget = Math.max(0, Math.floor(maxChars));
	if (text.length <= budget) return text;
	if (budget === 0) return "";

	let contentChars = budget;
	let suffix = "";
	for (let attempt = 0; attempt < 3; attempt++) {
		const omitted = text.length - contentChars;
		suffix = `\n\n[${label} truncated: ${omitted} characters omitted. Use subagent action "read" for the retained snapshot.]`;
		contentChars = Math.max(0, budget - suffix.length);
	}
	if (suffix.length >= budget) {
		const shortSuffix = `[${label} truncated]`;
		return shortSuffix.length <= budget
			? shortSuffix
			: shortSuffix.slice(0, budget);
	}
	return `${text.slice(0, contentChars)}${suffix}`;
}

export function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

/**
 * Shorten a filesystem path to `~` relative to the user home directory.
 * Same algorithm as the statusline extension (Windows-safe, `/` separators).
 */
export function formatHomePath(filePath: string): string {
	const rawHome =
		process.env.USERPROFILE || process.env.HOME || "";
	const homeDirectory = rawHome.replace(/[\\/]+$/, "");
	if (!homeDirectory || !filePath) return filePath;

	const normalize = (p: string) =>
		p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	const homeNorm = normalize(homeDirectory);
	const pathNorm = normalize(filePath);
	if (pathNorm === homeNorm) return "~";
	if (pathNorm.startsWith(`${homeNorm}/`)) {
		// Preserve original casing from the input for the suffix.
		const withSlashes = filePath.replace(/\\/g, "/");
		const homeWithSlashes = homeDirectory.replace(/\\/g, "/").replace(/\/+$/, "");
		// Case-insensitive prefix strip for Windows.
		if (withSlashes.toLowerCase().startsWith(homeWithSlashes.toLowerCase())) {
			return `~${withSlashes.slice(homeWithSlashes.length)}`;
		}
		return `~${withSlashes.slice(homeDirectory.length)}`;
	}
	return filePath;
}

/** When still too long after `~`, keep `~/…/basename`. */
export function shortenHomePath(filePath: string, maxChars: number): string {
	const display = formatHomePath(filePath);
	if (display.length <= maxChars) return display;
	const normalized = display.replace(/\\/g, "/").replace(/\/+$/, "");
	const slash = normalized.lastIndexOf("/");
	const base = slash >= 0 ? normalized.slice(slash + 1) : normalized;
	if (normalized.startsWith("~/") || normalized === "~") {
		const short = `~/${base}`;
		return short.length <= maxChars
			? short
			: oneLine(short, maxChars);
	}
	return oneLine(base, maxChars);
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

/**
 * Meta line pieces; drop from the tail when width is tight.
 * Type lives on the title row, so it is omitted here.
 */
export function formatMetaParts(snapshot: SubagentSnapshot): string[] {
	const elapsed = formatDuration(
		snapshot.startedAt,
		snapshot.endedAt ?? Date.now(),
	);
	return [
		elapsed,
		snapshot.usage.toolUses ? `${snapshot.usage.toolUses} tools` : "",
		snapshot.usage.output ? `↓${formatTokens(snapshot.usage.output)}` : "",
		snapshot.model ? oneLine(snapshot.model, 28) : "",
		snapshot.usage.cost > 0 ? `$${snapshot.usage.cost.toFixed(2)}` : "",
		snapshot.runCount > 1 ? `run ${snapshot.runCount}` : "",
	].filter(Boolean);
}

export interface SnapshotCounts {
	total: number;
	active: number;
	queued: number;
	done: number;
	failed: number;
	unread: number;
}

export function countSnapshots(
	snapshots: readonly SubagentSnapshot[],
): SnapshotCounts {
	let active = 0;
	let queued = 0;
	let done = 0;
	let failed = 0;
	let unread = 0;
	for (const snapshot of snapshots) {
		if (snapshot.unread) unread++;
		if (isActiveStatus(snapshot.status)) active++;
		else if (snapshot.status === "queued") queued++;
		else if (snapshot.status === "failed") failed++;
		else if (isTerminalStatus(snapshot.status)) done++;
	}
	return {
		total: snapshots.length,
		active,
		queued,
		done,
		failed,
		unread,
	};
}

/**
 * Plain statusline summary (no ANSI).
 * Examples: "2 explorer", "1 running · 1 queued", "2 done · unread"
 */
export function formatStatuslineSummary(
	snapshots: readonly SubagentSnapshot[],
): string | undefined {
	if (!snapshots.length) return undefined;
	const counts = countSnapshots(snapshots);

	const live = snapshots.filter(
		(snapshot) =>
			isActiveStatus(snapshot.status) || snapshot.status === "queued",
	);
	const liveTypes = new Set(live.map((snapshot) => snapshot.agentName));
	const singleType =
		liveTypes.size === 1 ? [...liveTypes][0] : undefined;

	if (counts.active || counts.queued) {
		const parts: string[] = [];
		if (counts.active) {
			// Color carries "running"; keep the chip short.
			parts.push(
				singleType && counts.queued === 0
					? `${counts.active} ${singleType}`
					: `${counts.active} running`,
			);
		}
		if (counts.queued) {
			parts.push(
				!counts.active && singleType
					? `${counts.queued} ${singleType} queued`
					: `${counts.queued} queued`,
			);
		}
		if (counts.failed) parts.push(`${counts.failed} failed`);
		return parts.join(" · ");
	}

	const parts: string[] = [];
	if (counts.failed) parts.push(`${counts.failed} failed`);
	if (counts.done) parts.push(`${counts.done} done`);
	if (counts.unread && counts.done) parts.push("unread");
	return parts.length ? parts.join(" · ") : undefined;
}

export type StatuslineTone =
	| "accent"
	| "success"
	| "warning"
	| "error"
	| "muted";

/** Semantic tone for the statusline chip based on fleet state. */
export function statuslineTone(
	snapshots: readonly SubagentSnapshot[],
): StatuslineTone {
	const counts = countSnapshots(snapshots);
	if (counts.active || counts.queued) return "accent";
	if (counts.failed) return "error";
	if (counts.unread) return "warning";
	if (counts.done) return "success";
	return "muted";
}

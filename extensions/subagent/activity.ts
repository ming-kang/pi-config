import { formatHomePath, oneLine, shortenHomePath } from "./format.ts";
import type { SubagentSnapshot, ToolActivity } from "./types.ts";

export interface ToolActivityDescription {
	headline: string;
	summary: string;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function firstString(
	record: Record<string, unknown>,
	...keys: string[]
): string {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

function quote(value: string, maxChars = 80): string {
	return `"${oneLine(value, maxChars)}"`;
}

function displayPath(filePath: string, maxChars = 120): string {
	if (!filePath || filePath === "…") return filePath || "…";
	const withHome = formatHomePath(filePath);
	return withHome.length > maxChars
		? shortenHomePath(filePath, maxChars)
		: withHome;
}

function pathWithRange(record: Record<string, unknown>): string {
	const raw = firstString(record, "path", "file_path", "filePath") || "…";
	const filePath = displayPath(raw);
	const offset =
		typeof record.offset === "number" && Number.isFinite(record.offset)
			? Math.max(1, Math.floor(record.offset))
			: undefined;
	const limit =
		typeof record.limit === "number" && Number.isFinite(record.limit)
			? Math.max(1, Math.floor(record.limit))
			: undefined;
	if (offset === undefined && limit === undefined) return filePath;
	const start = offset ?? 1;
	return `${filePath}:${start}${limit ? `-${start + limit - 1}` : ""}`;
}

function describeBash(command: string): ToolActivityDescription {
	const normalized = command.toLowerCase();
	const summary = `Run ${oneLine(command || "command", 140)}`;
	if (
		/\b(test|typecheck|lint|build|gofmt|go test|vitest|jest|pytest|tsc)\b/.test(
			normalized,
		)
	) {
		return { headline: "Running verification", summary };
	}
	if (/\b(git status|git diff|rg|grep|find|ls|tree)\b/.test(normalized)) {
		return { headline: "Inspecting the workspace", summary };
	}
	return { headline: "Running a command", summary };
}

export function describeToolCall(
	toolName: string,
	args: unknown,
): ToolActivityDescription {
	const record = asRecord(args);
	switch (toolName) {
		case "read":
			return {
				headline: "Reading code",
				summary: `Read ${oneLine(pathWithRange(record), 160)}`,
			};
		case "grep": {
			const pattern = firstString(record, "pattern") || "…";
			const searchPath = firstString(record, "path");
			return {
				headline: "Searching the workspace",
				summary: `Search ${quote(pattern)}${searchPath ? ` in ${oneLine(displayPath(searchPath), 100)}` : ""}`,
			};
		}
		case "find": {
			const pattern = firstString(record, "pattern", "name") || "*";
			const searchPath = firstString(record, "path") || ".";
			return {
				headline: "Searching the workspace",
				summary: `Find ${quote(pattern)} in ${oneLine(displayPath(searchPath), 100)}`,
			};
		}
		case "ls": {
			const listPath = firstString(record, "path") || ".";
			return {
				headline: "Inspecting the workspace",
				summary: `List ${oneLine(displayPath(listPath), 160)}`,
			};
		}
		case "bash":
			return describeBash(firstString(record, "command", "cmd"));
		case "edit": {
			const filePath =
				displayPath(
					firstString(record, "path", "file_path", "filePath") || "…",
				);
			const edits = Array.isArray(record.edits) ? record.edits.length : undefined;
			return {
				headline: "Applying changes",
				summary: `Edit ${oneLine(filePath, 150)}${edits ? ` · ${edits} change${edits === 1 ? "" : "s"}` : ""}`,
			};
		}
		case "write": {
			const filePath =
				displayPath(
					firstString(record, "path", "file_path", "filePath") || "…",
				);
			const content = typeof record.content === "string" ? record.content : "";
			const lines = content ? content.split(/\r?\n/).length : undefined;
			return {
				headline: "Applying changes",
				summary: `Write ${oneLine(filePath, 150)}${lines ? ` · ${lines} line${lines === 1 ? "" : "s"}` : ""}`,
			};
		}
		default:
			return {
				headline: `Using ${toolName}`,
				summary: `Use ${toolName}`,
			};
	}
}

function extractToolResultText(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				Boolean(part) &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/**
 * Compact result footnote for the fleet panel. Prefer size over a noisy first
 * line (JSON braces, code openers, fence markers) so the rail stays scannable.
 */
export function summarizeToolResult(result: unknown): string {
	const text = extractToolResultText(result);
	if (!text) return "";
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const nonEmpty = lines.filter((line) => line.trim().length > 0);
	if (lines.length >= 2) {
		return `${lines.length} line${lines.length === 1 ? "" : "s"}`;
	}
	const first = oneLine(nonEmpty[0] ?? "", 100);
	if (!first) return "";
	// Single-line payloads that look like structure, not a human summary.
	if (/^[\{\[\`<(|]/.test(first) || /^[\s]*[{[]/.test(first)) {
		return "1 line";
	}
	return first;
}

function isSearchTool(activity: ToolActivity): boolean {
	return (
		activity.toolName === "read" ||
		activity.toolName === "grep" ||
		activity.toolName === "find" ||
		activity.toolName === "ls"
	);
}

function isMutationTool(activity: ToolActivity): boolean {
	return activity.toolName === "edit" || activity.toolName === "write";
}

function isVerificationHeadline(activity: ToolActivity): boolean {
	return /verif|test|lint|typecheck|build/i.test(
		`${activity.headline} ${activity.summary}`,
	);
}

function isInspectionHeadline(activity: ToolActivity): boolean {
	return /inspect|list|search/i.test(`${activity.headline} ${activity.summary}`);
}

/**
 * Trellis-style one-line intent for the always-on preview card.
 * Prefers live tool state, then recent tool mix, then currentActivity / streaming text.
 */
export function behaviorSummary(snapshot: SubagentSnapshot): string {
	if (snapshot.status === "completed")
		return "Task completed and result returned";
	if (snapshot.status === "failed")
		return snapshot.error
			? oneLine(`Failed: ${snapshot.error}`, 80)
			: "Task failed";
	if (snapshot.status === "stopped") return "Stopped";
	if (snapshot.status === "queued") return "Waiting for a free slot";
	if (snapshot.status === "starting") return "Starting worker session";

	let running: ToolActivity | undefined;
	for (let i = snapshot.activities.length - 1; i >= 0; i--) {
		const a = snapshot.activities[i];
		if (a?.status === "running") {
			running = a;
			break;
		}
	}
	if (running) {
		if (isMutationTool(running)) return "Applying the plan to code";
		if (running.toolName === "bash" && isVerificationHeadline(running))
			return "Verifying whether the implementation passes";
		if (running.toolName === "bash" && isInspectionHeadline(running))
			return "Inspecting current code state";
		if (isSearchTool(running)) return "Locating relevant code and context";
		if (running.toolName === "bash") return "Validating assumptions with commands";
		return oneLine(running.headline || "Using tools to advance the task", 72);
	}

	const recent = snapshot.activities.slice(-5);
	if (recent.some((a) => a.status === "failed"))
		return "Investigating tool or command failure";
	if (recent.some(isMutationTool)) return "Reviewing recent changes";
	if (recent.some((a) => a.toolName === "bash" && isVerificationHeadline(a)))
		return "Analyzing verification results";
	if (
		recent.length >= 2 &&
		recent.every(
			(a) =>
				isSearchTool(a) ||
				(a.toolName === "bash" && isInspectionHeadline(a)),
		)
	) {
		return "Mapping code structure and impact";
	}

	if (snapshot.currentActivity) return oneLine(snapshot.currentActivity, 72);
	if (snapshot.liveText.trim()) return "Writing response…";
	if (!snapshot.activities.length) return "Understanding the task and planning";
	return "Advancing the task";
}

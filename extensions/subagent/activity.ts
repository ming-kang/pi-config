import { oneLine } from "./format.ts";

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

function pathWithRange(record: Record<string, unknown>): string {
	const filePath = firstString(record, "path", "file_path", "filePath") || "…";
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
				summary: `Search ${quote(pattern)}${searchPath ? ` in ${oneLine(searchPath, 100)}` : ""}`,
			};
		}
		case "find": {
			const pattern = firstString(record, "pattern", "name") || "*";
			const searchPath = firstString(record, "path") || ".";
			return {
				headline: "Searching the workspace",
				summary: `Find ${quote(pattern)} in ${oneLine(searchPath, 100)}`,
			};
		}
		case "ls": {
			const listPath = firstString(record, "path") || ".";
			return {
				headline: "Inspecting the workspace",
				summary: `List ${oneLine(listPath, 160)}`,
			};
		}
		case "bash":
			return describeBash(firstString(record, "command", "cmd"));
		case "edit": {
			const filePath = firstString(record, "path", "file_path", "filePath") || "…";
			const edits = Array.isArray(record.edits) ? record.edits.length : undefined;
			return {
				headline: "Applying changes",
				summary: `Edit ${oneLine(filePath, 150)}${edits ? ` · ${edits} change${edits === 1 ? "" : "s"}` : ""}`,
			};
		}
		case "write": {
			const filePath = firstString(record, "path", "file_path", "filePath") || "…";
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

export function summarizeToolResult(result: unknown): string {
	const text = extractToolResultText(result);
	if (!text) return "";
	const lines = text.split("\n").filter((line) => line.trim().length > 0);
	const first = oneLine(lines[0] ?? "", 140);
	return lines.length > 1 ? `${first} (+${lines.length - 1} lines)` : first;
}

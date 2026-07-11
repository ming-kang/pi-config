/**
 * read-before-edit — enforce "read before edit/write" and "re-read if modified".
 *
 * Mirrors Claude Code's readFileState guard, adapted to Pi's extension events:
 *   - tool_result(read|edit|write, ok) → record { contentHash, mtime, isPartialView? }
 *   - tool_call(edit|write)            → block unless fully read and unchanged on disk
 *   - before_agent_start               → append a soft "read before write" prompt
 *
 * Coverage (per SPEC): CC constraint classes ① Read-before-Edit/Write,
 * ② Re-read-if-modified, and partial-view rejection (CC isPartialView):
 *   - A read with offset/limit, or auto-truncated by the read tool, is partial.
 *   - Partial state blocks edit/write with the same "has not been read yet" message.
 *   - Multi-offset continuation reads are NOT stitched into a full view (CC model).
 *   - Injected context files (AGENTS.md/CLAUDE.md) never pass through the read tool,
 *     so editing them is blocked as "not read yet" until an explicit full read.
 *
 * New-file exemption (matches CC FileWriteTool): a write/edit whose target does
 * not exist on disk (ENOENT) is allowed without a prior read — you can't read a
 * file you're about to create. Existing files require a full read + mtime gate.
 *
 * Windows mtime false positives: cloud sync / antivirus can bump mtime without
 * changing content. When mtime grew but the on-disk content equals what was
 * recorded for a FULL read, we allow the write (content fallback), matching CC.
 * Partial views never use the content-fallback path.
 *
 * All errors are returned as tool_call `{ block, reason }`; Pi surfaces `reason`
 * to the model as an error tool result. No ANSI / colors here (no UI surface).
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fileState from "./file-state.ts";
import { editWriteTargetPath, resolveToolPath } from "./tool-path.ts";

// Error messages are kept byte-for-byte identical to Claude Code so behavior
// (and any downstream prompting the model has learned) stays consistent.
const MSG_NOT_READ = "File has not been read yet. Read it first before writing to it.";
const MSG_MODIFIED =
	"File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";

const SOFT_CONSTRAINT_LINES = [
	"Before using the edit or write tool on an existing file, you must first read it fully with the read tool in this session.",
	"A partial or truncated read (offset/limit or auto-truncation) does not count — read the full file before editing.",
	"If a file changed on disk since you last read it, read it again before editing. This prevents edits based on stale content.",
];

function isENOENT(error: unknown): boolean {
	return !!error && typeof error === "object" && (error as { code?: string }).code === "ENOENT";
}

/** True when the model only saw a partial view of the file. */
function isPartialRead(event: {
	input: Record<string, unknown>;
	details?: unknown;
}): boolean {
	const { offset, limit } = event.input as { offset?: unknown; limit?: unknown };
	if (offset !== undefined && offset !== null) return true;
	if (limit !== undefined && limit !== null) return true;
	const details = event.details as { truncation?: { truncated?: boolean } } | undefined;
	return details?.truncation?.truncated === true;
}

export default function readBeforeEdit(pi: ExtensionAPI): void {
	// ---- record reads, and the agent's own writes/edits ---------------------
	// Recording on edit/write (not only read) mirrors CC's FileWriteTool /
	// FileEditTool, which refresh readFileState after writing. Without it the
	// agent's own edit bumps the file's mtime and changes its content, so the
	// very next edit to the same file would be wrongly blocked as "modified since
	// read" — forcing a needless re-read between consecutive edits. The tool_call
	// gate still runs before each edit, so a genuine external change is caught
	// first (it fires before the write that would refresh the state).
	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return;
		if (event.toolName !== "read" && event.toolName !== "edit" && event.toolName !== "write") return;
		const rawPath = editWriteTargetPath(event.input);
		if (!rawPath) return;

		if (event.toolName === "read") {
			if (isPartialRead(event)) {
				recordPartialState(rawPath, ctx.cwd);
			} else {
				recordDiskState(rawPath, ctx.cwd);
			}
			return;
		}

		// write: hash the utf-8 args content (matches Pi writeFile(..., "utf-8"))
		// so we avoid a second full-file disk read after a successful write.
		// edit: always hash on-disk bytes (input is a patch, not final content).
		if (event.toolName === "write") {
			const content = (event.input as { content?: unknown } | undefined)?.content;
			recordWriteState(rawPath, ctx.cwd, typeof content === "string" ? content : undefined);
		} else {
			recordDiskState(rawPath, ctx.cwd);
		}
	});

	// ---- gate edits / writes ------------------------------------------------
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const rawPath = editWriteTargetPath(event.input);
		if (!rawPath) return;

		const abs = resolveToolPath(rawPath, ctx.cwd);

		// Single stat: ENOENT → new-file exemption; other errors soft-allow.
		let currentMtime: number;
		try {
			currentMtime = statSync(abs).mtimeMs;
		} catch (error) {
			if (isENOENT(error)) return;
			// Can't stat an existing-looking file — don't hard-block on a flaky FS.
			return;
		}

		const state = fileState.get(rawPath, ctx.cwd);
		// Missing or partial view → same CC message as "not read yet".
		if (!state || state.isPartialView) {
			return { block: true, reason: MSG_NOT_READ };
		}

		if (currentMtime > state.mtime) {
			// Full-read content fallback only (CC: isFullRead && content equal).
			// Windows false-positive: identical raw bytes ⇒ allow.
			let sameContent = false;
			if (state.contentHash !== undefined) {
				try {
					sameContent = hashFile(abs) === state.contentHash;
				} catch {
					sameContent = false;
				}
			}
			if (!sameContent) {
				return { block: true, reason: MSG_MODIFIED };
			}
			// Content matched: refresh the recorded mtime so we don't re-read it
			// (and re-compare) on every subsequent edit this session.
			fileState.set(
				rawPath,
				{ contentHash: state.contentHash, mtime: currentMtime },
				ctx.cwd,
			);
		}
		return;
	});

	// ---- soft constraint ----------------------------------------------------
	pi.on("before_agent_start", (event) => {
		return {
			systemPrompt: [
				event.systemPrompt,
				"",
				"<read_before_edit>",
				...SOFT_CONSTRAINT_LINES,
				"</read_before_edit>",
			].join("\n"),
		};
	});

	// Tree navigation may restore files through another independent extension.
	// Conservatively require fresh reads regardless of whether files changed.
	pi.on("session_tree", () => {
		fileState.clear();
	});
}

/** Mark a partial/truncated read — edit/write stay blocked until a full read. */
function recordPartialState(rawPath: string, cwd: string): void {
	try {
		const abs = resolveToolPath(rawPath, cwd);
		const stat = statSync(abs);
		fileState.set(rawPath, { mtime: stat.mtimeMs, isPartialView: true }, cwd);
	} catch {
		// File vanished between the tool run and this event, or stat failed.
	}
}

/**
 * After a successful write: prefer hashing the utf-8 content from tool args
 * (same encoding Pi's write tool uses on disk). Fall back to a full disk hash
 * when content is missing or over the budget. Still stats for mtime. Always full.
 */
function recordWriteState(rawPath: string, cwd: string, content: string | undefined): void {
	try {
		const abs = resolveToolPath(rawPath, cwd);
		const stat = statSync(abs);
		let contentHash: string | undefined;
		if (content !== undefined) {
			const byteLength = Buffer.byteLength(content, "utf8");
			if (byteLength <= fileState.MAX_CONTENT_BYTES) {
				contentHash = hashUtf8(content);
			}
			// Oversized write args: mtime-only (same as oversized disk files).
		} else if (stat.size <= fileState.MAX_CONTENT_BYTES) {
			try {
				contentHash = hashFile(abs);
			} catch {
				contentHash = undefined;
			}
		}
		fileState.set(rawPath, { contentHash, mtime: stat.mtimeMs }, cwd);
	} catch {
		// File vanished between the tool run and this event, or stat failed.
	}
}

/**
 * Capture on-disk full-read state { contentHash, mtime }. Used after full read
 * and after edit (and as write fallback). Hash only within the size budget.
 */
function recordDiskState(rawPath: string, cwd: string): void {
	try {
		const abs = resolveToolPath(rawPath, cwd);
		const stat = statSync(abs);
		let contentHash: string | undefined;
		if (stat.size <= fileState.MAX_CONTENT_BYTES) {
			try {
				contentHash = hashFile(abs);
			} catch {
				contentHash = undefined;
			}
		}
		fileState.set(rawPath, { contentHash, mtime: stat.mtimeMs }, cwd);
	} catch {
		// File vanished between the tool run and this event, or stat failed.
	}
}

/** sha-256 (hex) of a utf-8 string — matches Pi write tool disk encoding. */
function hashUtf8(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha-256 (hex) of a file's raw bytes. Throws on IO errors; callers handle. */
function hashFile(absPath: string): string {
	return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

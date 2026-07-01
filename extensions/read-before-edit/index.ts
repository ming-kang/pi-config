/**
 * read-before-edit — enforce "read before edit/write" and "re-read if modified".
 *
 * Mirrors Claude Code's readFileState guard, adapted to Pi's extension events:
 *   - tool_result(read|edit|write, ok) → record { content, mtime } for the file
 *   - tool_call(edit|write)            → block unless read and unchanged on disk
 *   - before_agent_start               → append a soft "read before write" prompt
 *
 * Coverage (per SPEC): CC constraint classes ① Read-before-Edit/Write and
 * ② Re-read-if-modified. The other CC classes don't apply to Pi:
 *   - Injected context files (AGENTS.md/CLAUDE.md) go straight into the system
 *     prompt via buildSystemPrompt; they never pass through the read tool, so
 *     they're absent from readFileState and editing them is blocked as
 *     "not read yet" — stricter than CC's isPartialView, and for free.
 *
 * New-file exemption (matches CC FileWriteTool): a write/edit whose target does
 * not exist on disk (ENOENT) is allowed without a prior read — you can't read a
 * file you're about to create. Existing files require the read + mtime gate.
 *
 * Windows mtime false positives: cloud sync / antivirus can bump mtime without
 * changing content. When mtime grew but the on-disk content equals what the
 * model read, we allow the write (content fallback), matching CC.
 *
 * All errors are returned as tool_call `{ block, reason }`; Pi surfaces `reason`
 * to the model as an error tool result. No ANSI / colors here (no UI surface).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// The read-state cache lives in extensions/shared/ (not inside this extension)
// because rewind also imports it to invalidate entries after a checkpoint
// restore — it is a shared utility, not this extension's private module.
import * as fileState from "../shared/file-state.ts";
import { appendSoftConstraint } from "../shared/extension-ui.ts";

// Error messages are kept byte-for-byte identical to Claude Code so behavior
// (and any downstream prompting the model has learned) stays consistent.
const MSG_NOT_READ = "File has not been read yet. Read it first before writing to it.";
const MSG_MODIFIED =
	"File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";

const SOFT_CONSTRAINT_LINES = [
	"Before using the edit or write tool on an existing file, you must first read it with the read tool in this session.",
	"If a file changed on disk since you last read it, read it again before editing. This prevents edits based on stale content.",
];

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
		const rawPath = (event.input as { path?: unknown }).path;
		if (typeof rawPath !== "string" || rawPath.length === 0) return;
		recordReadState(rawPath, ctx.cwd);
	});

	// ---- gate edits / writes ------------------------------------------------
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const rawPath = (event.input as { path?: unknown }).path;
		if (typeof rawPath !== "string" || rawPath.length === 0) return;

		const abs = resolvePath(rawPath, ctx.cwd);

		// New-file exemption: a target that doesn't exist can't have been read.
		// Let the write create it (or let edit produce its own not-found error).
		if (!existsSync(abs)) return;

		const state = fileState.get(rawPath, ctx.cwd);
		if (!state) {
			return { block: true, reason: MSG_NOT_READ };
		}

		let currentMtime: number;
		try {
			currentMtime = statSync(abs).mtimeMs;
		} catch {
			// Can't stat an existing-looking file — don't hard-block on a flaky FS.
			return;
		}

		if (currentMtime > state.mtime) {
			// Windows false-positive fallback: identical content ⇒ allow.
			let sameContent = false;
			if (state.content !== undefined) {
				try {
					sameContent = readFileSync(abs, "utf8") === state.content;
				} catch {
					sameContent = false;
				}
			}
			if (!sameContent) {
				return { block: true, reason: MSG_MODIFIED };
			}
			// Content matched: refresh the recorded mtime so we don't re-read it
			// (and re-compare) on every subsequent edit this session.
			fileState.set(rawPath, { content: state.content, mtime: currentMtime }, ctx.cwd);
		}
		return;
	});

	// ---- soft constraint ----------------------------------------------------
	pi.on("before_agent_start", (event) => {
		return appendSoftConstraint(event, "read_before_edit", SOFT_CONSTRAINT_LINES);
	});
}

/**
 * Capture the current on-disk { content, mtime } for a path into the shared
 * read-state cache. Content is cached only when the file is within the size
 * budget; otherwise only the mtime is tracked. Failures (vanished file, stat
 * error) are swallowed — a missing entry just means the next edit re-reads.
 */
function recordReadState(rawPath: string, cwd: string): void {
	try {
		const abs = resolvePath(rawPath, cwd);
		const stat = statSync(abs);
		let content: string | undefined;
		if (stat.size <= fileState.MAX_CONTENT_BYTES) {
			try {
				content = readFileSync(abs, "utf8");
			} catch {
				content = undefined;
			}
		}
		fileState.set(rawPath, { content, mtime: stat.mtimeMs }, cwd);
	} catch {
		// File vanished between the tool run and this event, or stat failed.
	}
}

/**
 * Resolve a tool path the way the read tool would, so a relative read and an
 * absolute edit of the same file agree. We don't normalize case here — that's
 * done inside file-state's key normalization.
 */
function resolvePath(rawPath: string, cwd: string): string {
	return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

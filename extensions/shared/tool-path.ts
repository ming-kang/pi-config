/**
 * tool-path.ts — shared helpers for reading the target path of Pi's edit/write
 * tool events.
 *
 * read-before-edit (gate + record) and rewind (pre-edit backup) must agree on
 * "which file is this tool call touching"; both previously hand-rolled the same
 * input extraction and cwd resolution. Keeping them here stops the two
 * lifecycle extensions from drifting.
 */
import path from "node:path";

/**
 * The `path` input of an edit/write tool event, or undefined when absent or
 * empty. Callers pass `event.input` as-is.
 */
export function editWriteTargetPath(input: unknown): string | undefined {
	const raw = (input as { path?: unknown } | undefined)?.path;
	return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * Resolve a tool-supplied path the way the read tool would (absolute wins,
 * else cwd-relative), so a relative read and an absolute edit of the same file
 * agree. Case normalization is NOT done here — file-state's key normalization
 * owns that.
 */
export function resolveToolPath(rawPath: string, cwd: string): string {
	return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
}

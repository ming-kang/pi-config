/**
 * file-state.ts — read-state cache shared by two extensions, deliberately housed
 * in extensions/shared/ rather than inside either one:
 *   - read-before-edit WRITES it: records {contentHash, mtime} on every `read`,
 *     and reads it to enforce "read before edit/write" and "re-read if modified".
 *   - rewind INVALIDATES it: calls `del` after a checkpoint restore rewrites files
 *     on disk, so the next edit isn't wrongly blocked as "modified since read".
 *
 * extensions/shared/ has no index.ts and no pi manifest, so Pi's loader does not
 * treat it as an extension — it is purely an import target. This keeps the
 * rewind↔read-before-edit coupling on a neutral shared utility instead of one
 * extension reaching into another's internal modules.
 *
 * Tracks, per absolute file path, a sha-256 of the RAW BYTES the model last saw
 * via the `read` tool plus the file's mtime at read time. A hash (not decoded
 * text) is stored deliberately: utf-8 decoding folds invalid sequences to
 * U+FFFD, which can make two different binary files compare equal — and hashes
 * keep the cache a few bytes per entry instead of up to 25MB of file contents.
 *
 * Key normalization: callers pass raw paths (possibly relative, possibly with
 * Windows backslashes). We resolve + normalize so that a `read` of "src/a.ts"
 * and an `edit` of an absolute "C:\proj\src\a.ts" hit the same entry.
 *
 * Eviction: a plain insertion-ordered Map capped at MAX_ENTRIES; the oldest
 * entry is dropped when the cap is exceeded. No LRU — read-before-edit only
 * needs recent files, and a Map's iteration order gives us cheap FIFO.
 */
import path from "node:path";

export interface ReadState {
	/** sha-256 (hex) of the raw file bytes at read time, when within the size budget. */
	contentHash?: string;
	/** File mtime in ms at read time. */
	mtime: number;
}

/** Upper bound on tracked files. Oldest entry evicted past this. */
const MAX_ENTRIES = 100;
/**
 * Upper bound on file sizes we read back just to hash/compare, matching CC's
 * 25MB read-state budget. Also imported by rewind as its byte-compare guard.
 */
export const MAX_CONTENT_BYTES = 25 * 1024 * 1024;

const readFileState = new Map<string, ReadState>();

/**
 * Normalize a path to a stable cache key.
 * - resolve relative paths against an optional base (cwd) so relative/absolute agree
 * - lowercase the drive letter and unify separators on Windows (case-insensitive FS)
 */
export function normalizeKey(rawPath: string, base?: string): string {
	const resolved = base ? path.resolve(base, rawPath) : path.resolve(rawPath);
	// path.resolve already collapses separators to the platform default and
	// removes "." / ".." segments. On Windows the FS is case-insensitive, so
	// fold to lower case to avoid C:\Foo vs c:\foo misses.
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Get the recorded read-state for a path, or undefined if never read. */
export function get(rawPath: string, base?: string): ReadState | undefined {
	return readFileState.get(normalizeKey(rawPath, base));
}

/** Record (or refresh) the read-state for a path. Refreshing re-orders to newest. */
export function set(rawPath: string, state: ReadState, base?: string): void {
	const key = normalizeKey(rawPath, base);
	// Delete first so a refresh moves the entry to the end (newest) of the Map.
	readFileState.delete(key);
	readFileState.set(key, state);

	while (readFileState.size > MAX_ENTRIES) {
		// Drop the oldest (first-inserted) entry.
		const oldest = readFileState.keys().next().value;
		if (oldest === undefined) break;
		readFileState.delete(oldest);
	}
}

/** Remove a path from the cache. Used by rewind after restoring files. */
export function del(rawPath: string, base?: string): void {
	readFileState.delete(normalizeKey(rawPath, base));
}

/** Clear the entire cache. */
export function clear(): void {
	readFileState.clear();
}

/** Current number of tracked files (testing/diagnostics). */
export function size(): number {
	return readFileState.size;
}

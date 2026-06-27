/**
 * file-state.ts — read-state cache shared by two extensions, deliberately housed
 * in extensions/shared/ rather than inside either one:
 *   - read-before-edit WRITES it: records {content, mtime} on every `read`, and
 *     reads it to enforce "read before edit/write" and "re-read if modified".
 *   - rewind INVALIDATES it: calls `del` after a checkpoint restore rewrites files
 *     on disk, so the next edit isn't wrongly blocked as "modified since read".
 *
 * extensions/shared/ has no index.ts and no pi manifest, so Pi's loader does not
 * treat it as an extension — it is purely an import target. This keeps the
 * rewind↔read-before-edit coupling on a neutral shared utility instead of one
 * extension reaching into another's internal modules.
 *
 * Tracks, per absolute file path, the content the model last saw via the `read`
 * tool plus the file's mtime at read time.
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
	/** Raw text content captured at read time, when small enough to cache. */
	content?: string;
	/** File mtime in ms at read time. */
	mtime: number;
}

type StoredReadState = ReadState & { contentBytes: number };

/** Upper bound on tracked files. Oldest entry evicted past this. */
const MAX_ENTRIES = 100;
/** Upper bound on cached file contents, matching CC's 25MB read-state budget. */
export const MAX_CONTENT_BYTES = 25 * 1024 * 1024;

const readFileState = new Map<string, StoredReadState>();
let totalContentBytes = 0;

function deleteKey(key: string): void {
	const existing = readFileState.get(key);
	if (existing) totalContentBytes -= existing.contentBytes;
	readFileState.delete(key);
}

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
	deleteKey(key);

	const contentBytes = state.content === undefined ? 0 : Buffer.byteLength(state.content, "utf8");
	const normalizedState: StoredReadState = contentBytes > MAX_CONTENT_BYTES
		? { mtime: state.mtime, contentBytes: 0 }
		: { ...state, contentBytes };
	readFileState.set(key, normalizedState);
	totalContentBytes += normalizedState.contentBytes;

	while (readFileState.size > MAX_ENTRIES || totalContentBytes > MAX_CONTENT_BYTES) {
		// Drop the oldest (first-inserted) entry.
		const oldest = readFileState.keys().next().value;
		if (oldest === undefined) break;
		deleteKey(oldest);
	}
}

/** Remove a path from the cache. Used by rewind after restoring files. */
export function del(rawPath: string, base?: string): void {
	deleteKey(normalizeKey(rawPath, base));
}

/** Clear the entire cache. */
export function clear(): void {
	readFileState.clear();
	totalContentBytes = 0;
}

/** Current number of tracked files (testing/diagnostics). */
export function size(): number {
	return readFileState.size;
}

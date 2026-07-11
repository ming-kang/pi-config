import path from "node:path";

export interface ReadState {
	/** Present for full reads within the hashing budget. Omitted for partial views. */
	contentHash?: string;
	mtime: number;
	/**
	 * True when the model only saw a partial/truncated view (offset/limit or
	 * auto-truncation). Edit/write treat this like "not read yet".
	 */
	isPartialView?: boolean;
}

const MAX_ENTRIES = 100;
export const MAX_CONTENT_BYTES = 25 * 1024 * 1024;

const readFileState = new Map<string, ReadState>();

function normalizeKey(rawPath: string, baseDirectory?: string): string {
	const resolvedPath = baseDirectory ? path.resolve(baseDirectory, rawPath) : path.resolve(rawPath);
	return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

export function get(rawPath: string, baseDirectory?: string): ReadState | undefined {
	return readFileState.get(normalizeKey(rawPath, baseDirectory));
}

export function set(rawPath: string, state: ReadState, baseDirectory?: string): void {
	const cacheKey = normalizeKey(rawPath, baseDirectory);
	// delete-before-set keeps insertion order as LRU-ish FIFO eviction order.
	readFileState.delete(cacheKey);
	readFileState.set(cacheKey, state);

	while (readFileState.size > MAX_ENTRIES) {
		const oldestCacheKey = readFileState.keys().next().value;
		if (oldestCacheKey === undefined) break;
		readFileState.delete(oldestCacheKey);
	}
}

export function clear(): void {
	readFileState.clear();
}

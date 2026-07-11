import path from "node:path";

export interface ReadState {
	contentHash?: string;
	mtime: number;
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

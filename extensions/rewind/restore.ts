/**
 * restore.ts — map a /tree navigation target to the snapshot that should be
 * restored, apply it via the engine, and keep the read-before-edit cache
 * consistent afterwards.
 *
 * The readFileState sync couples rewind with read-before-edit through their
 * shared read-cache module (extensions/shared/file-state.ts): after we rewrite
 * files on disk, any path the model had "read" is now stale, so we drop those
 * cache entries. Without this, the next edit would be wrongly blocked as
 * "modified since read".
 */
// Shared read-cache contract (extensions/shared/file-state.ts): read-before-edit
// records reads into it; rewind drops stale entries here after rewriting files.
import { del as dropReadState } from "../shared/file-state.ts";
import { resolveToolPath } from "../shared/tool-path.ts";
import { applySnapshot, collectChanges } from "./engine.ts";
import type { FileHistorySnapshot } from "./snapshot.ts";

/** Minimal session view we need to walk the entry tree. */
export interface EntryTreeView {
	getEntry(id: string): { id: string; parentId: string | null } | undefined;
}

/** Collect the ancestor id set of `targetId` (inclusive), walking parentId to root. */
export function ancestorIds(view: EntryTreeView, targetId: string): Set<string> {
	const set = new Set<string>();
	let cur: string | null = targetId;
	let guard = 0;
	while (cur && !set.has(cur) && guard++ < 100_000) {
		set.add(cur);
		cur = view.getEntry(cur)?.parentId ?? null;
	}
	return set;
}

/**
 * The snapshot that best matches navigating to `targetId`: the most recent
 * snapshot (chronological) whose turn anchor (userEntryId) is an ancestor of, or
 * equal to, the target. Undefined when no recorded turn precedes the target.
 */
export function snapshotForEntry(
	snapshots: FileHistorySnapshot[],
	view: EntryTreeView,
	targetId: string,
): FileHistorySnapshot | undefined {
	const ancestors = ancestorIds(view, targetId);
	let best: FileHistorySnapshot | undefined;
	for (const snap of snapshots) {
		if (ancestors.has(snap.userEntryId)) best = snap; // snapshots are in chronological order
	}
	return best;
}

/**
 * Absolute file paths restoring to this snapshot would change on disk (empty =
 * none). Callers use the length for the count and the paths for the preview.
 */
export function snapshotChangedPaths(sessionId: string, snapshot: FileHistorySnapshot): Promise<string[]> {
	return collectChanges(sessionId, snapshot);
}

/**
 * Restore the work tree to `snapshot` and drop read-before-edit cache entries for
 * every file that changed, so the next edit isn't wrongly blocked as stale.
 * Returns the list of changed file paths (absolute).
 */
export async function restoreToSnapshot(
	sessionId: string,
	snapshot: FileHistorySnapshot,
): Promise<string[]> {
	const changed = await applySnapshot(sessionId, snapshot);
	for (const filePath of changed) {
		// applySnapshot returns absolute paths; resolve defensively anyway.
		dropReadState(resolveToolPath(filePath, process.cwd()));
	}
	return changed;
}

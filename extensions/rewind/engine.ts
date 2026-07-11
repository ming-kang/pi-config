/**
 * engine.ts — file-history backup engine for the rewind extension.
 *
 * Ported from Claude Code 2.1.88's src/utils/fileHistory.ts, adapted from its
 * React state-updater to module-level per-session maps. The core idea (and the
 * reason this exists): we back up ONLY the files Pi's edit/write tools are about
 * to modify — one copyFile before the edit — instead of snapshotting the whole
 * work tree. Cost is proportional to "how many files Pi changed", not project
 * size, so it never blocks the session-lifecycle critical path and storage stays
 * tiny.
 *
 * Per turn:
 *   - beginTurn()  (before_agent_start): open a working frame and re-record every
 *     already-tracked file at its current (turn-start) state, reusing the latest
 *     backup when unchanged (mtime/size/content), creating a new version when not.
 *   - trackEdit()  (tool_call edit|write, before the write): back up a *newly*
 *     edited file at its pre-edit state into the working frame (null marker when
 *     the target does not exist yet, so rewind deletes the created file).
 *   - endTurn()    (agent_end): if anything changed, stamp + return the frame to
 *     persist; else discard it.
 *
 * Rewind = applySnapshot(): restore every tracked file to the version recorded in
 * the target frame (copy back / delete for null), touching only files that differ.
 *
 * Backups live at <rewindBackupsDir(sessionId)>/<sha256(relpath)[:16]>@v<n>.
 */
import { createHash } from "node:crypto";
import { type Stats, chmodSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { chmod, copyFile, link, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

import { backupsDir } from "./storage.ts";
import type { FileBackup, FileHistorySnapshot } from "./snapshot.ts";

/** Cap on retained snapshots per session (matches CC's MAX_SNAPSHOTS). */
const MAX_SNAPSHOTS = 100;
/** Avoid reading very large files solely to compare backup content. */
const MAX_CONTENT_BYTES = 25 * 1024 * 1024;

export interface FileHistoryState {
	/** Finalized + persisted frames, oldest first. */
	snapshots: FileHistorySnapshot[];
	/** All tracking-paths ever edited this session. */
	trackedFiles: Set<string>;
	/** The current turn's working frame (built across the turn, persisted at endTurn). */
	pending: FileHistorySnapshot | null;
	/** Whether the pending frame differs from the last finalized frame. */
	dirty: boolean;
	/** Monotonic activity counter (incremented on every finalized frame). */
	seq: number;
}

// ---- per-session state ----------------------------------------------------

const states = new Map<string, FileHistoryState>();
const cwds = new Map<string, string>();

function freshState(): FileHistoryState {
	return { snapshots: [], trackedFiles: new Set(), pending: null, dirty: false, seq: 0 };
}

function getState(sid: string): FileHistoryState {
	let s = states.get(sid);
	if (!s) {
		s = freshState();
		states.set(sid, s);
	}
	return s;
}

/** Bind a session id to its cwd (for relative-path keying). Call at session_start. */
export function registerSession(sid: string, cwd: string): void {
	cwds.set(sid, cwd);
	getState(sid);
}

export function disposeSession(sid: string): void {
	states.delete(sid);
	cwds.delete(sid);
}

export function getSnapshots(sid: string): FileHistorySnapshot[] {
	return states.get(sid)?.snapshots ?? [];
}

function cwdFor(sid: string): string {
	return cwds.get(sid) ?? process.cwd();
}

// ---- path helpers ---------------------------------------------------------

/** Use the cwd-relative path as the tracking key when inside cwd (shorter, portable). */
function shorten(absPath: string, cwd: string): string {
	if (!isAbsolute(absPath)) return absPath;
	if (absPath === cwd) return absPath;
	const rel = relative(cwd, absPath);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return absPath;
	return rel;
}

function expand(tracking: string, cwd: string): string {
	return isAbsolute(tracking) ? tracking : join(cwd, tracking);
}

function backupName(tracking: string, version: number): string {
	const h = createHash("sha256").update(tracking).digest("hex").slice(0, 16);
	return `${h}@v${version}`;
}

function backupPathFor(sid: string, name: string): string {
	return join(backupsDir(sid), name);
}

function latestBackupOf(state: FileHistoryState, tracking: string): FileBackup | undefined {
	for (let i = state.snapshots.length - 1; i >= 0; i--) {
		const b = state.snapshots[i]!.trackedFileBackups[tracking];
		if (b) return b;
	}
	return state.pending?.trackedFileBackups[tracking];
}

/** First-ever recorded backup for a file (used when rewinding before it was tracked). */
function firstBackupName(state: FileHistoryState, tracking: string): string | null | undefined {
	for (const snap of state.snapshots) {
		const b = snap.trackedFileBackups[tracking];
		if (b && b.version === 1) return b.backupName;
	}
	return undefined;
}

// ---- change detection (ported fileHistory.ts compareStatsAndContent) ------

function isENOENT(e: unknown): boolean {
	return !!e && typeof e === "object" && (e as { code?: string }).code === "ENOENT";
}

async function statOrNull(p: string): Promise<Stats | null> {
	try {
		return await stat(p);
	} catch (e) {
		if (isENOENT(e)) return null;
		throw e;
	}
}

/** True when the on-disk file differs from its backup blob. */
async function originChanged(sid: string, filePath: string, name: string, hint?: Stats): Promise<boolean> {
	const backupPath = backupPathFor(sid, name);
	const orig = hint ?? (await statOrNull(filePath).catch(() => null));
	const back = await statOrNull(backupPath).catch(() => null);

	// One exists, one missing -> changed.
	if ((orig === null) !== (back === null)) return true;
	if (orig === null || back === null) return false;
	if (orig.mode !== back.mode || orig.size !== back.size) return true;
	// Original untouched since the backup was written -> unchanged (skip content read).
	if (orig.mtimeMs < back.mtimeMs) return false;
	// Memory guard: don't load huge files just to byte-compare; assume changed and
	// let createBackup stream a new version instead (copyFile never buffers whole files).
	if (orig.size > MAX_CONTENT_BYTES) return true;
	try {
		// Raw-byte compare. A utf-8 decode maps invalid sequences to U+FFFD, which
		// can make two DIFFERENT binary files compare equal — and then rewind would
		// silently skip both the re-backup and the restore.
		const [a, b] = await Promise.all([readFile(filePath), readFile(backupPath)]);
		return !a.equals(b);
	} catch {
		return true;
	}
}

// ---- backup / restore IO --------------------------------------------------

/** Copy the file's current contents into a backup blob; null backup when absent. */
async function createBackup(sid: string, filePath: string, tracking: string, version: number): Promise<FileBackup> {
	let src: Stats;
	try {
		src = await stat(filePath);
	} catch (e) {
		if (isENOENT(e)) return { backupName: null, version };
		throw e;
	}
	const name = backupName(tracking, version);
	const dest = backupPathFor(sid, name);
	try {
		await copyFile(filePath, dest);
	} catch (e) {
		if (!isENOENT(e)) throw e;
		await mkdir(dirname(dest), { recursive: true });
		await copyFile(filePath, dest);
	}
	try {
		await chmod(dest, src.mode);
	} catch {
		// best-effort (e.g. Windows); content is what matters
	}
	return { backupName: name, version };
}

/**
 * Synchronous backup, used on the edit critical path (tool_call). Doing the copy
 * synchronously guarantees it completes before the hook returns control to the
 * host — so the backup always captures the file's PRE-edit contents, regardless
 * of whether the host awaits the hook before running the tool.
 */
function createBackupSync(sid: string, filePath: string, tracking: string, version: number): FileBackup {
	let src: Stats;
	try {
		src = statSync(filePath);
	} catch (e) {
		if (isENOENT(e)) return { backupName: null, version };
		throw e;
	}
	const name = backupName(tracking, version);
	const dest = backupPathFor(sid, name);
	try {
		copyFileSync(filePath, dest);
	} catch (e) {
		if (!isENOENT(e)) throw e;
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(filePath, dest);
	}
	try {
		chmodSync(dest, src.mode);
	} catch {
		// best-effort
	}
	return { backupName: name, version };
}

async function restoreBackup(sid: string, filePath: string, name: string): Promise<void> {
	const backupPath = backupPathFor(sid, name);
	let back: Stats;
	try {
		back = await stat(backupPath);
	} catch {
		return; // backup vanished; leave the file untouched
	}
	try {
		await copyFile(backupPath, filePath);
	} catch (e) {
		if (!isENOENT(e)) throw e;
		await mkdir(dirname(filePath), { recursive: true });
		await copyFile(backupPath, filePath);
	}
	try {
		await chmod(filePath, back.mode);
	} catch {
		// best-effort
	}
}

// ---- per-turn lifecycle ---------------------------------------------------

/**
 * Open the working frame for a turn and re-record every tracked file at its
 * current state (reuse latest backup when unchanged, new version when changed).
 * Sets state.dirty when any file produced a new version.
 */
export async function beginTurn(sid: string): Promise<void> {
	const state = getState(sid);
	const cwd = cwdFor(sid);
	const backups: Record<string, FileBackup> = {};
	let dirty = false;

	await Promise.all(
		Array.from(state.trackedFiles, async (tracking) => {
			try {
				const filePath = expand(tracking, cwd);
				const latest = latestBackupOf(state, tracking);
				const nextVersion = latest ? latest.version + 1 : 1;
				const st = await statOrNull(filePath);
				if (!st) {
					// Already recorded absent in the latest frame -> reuse it. Allocating a
					// fresh null version every turn would pin dirty=true forever once a
					// tracked file is deleted, defeating the "skip unchanged turns" check
					// and flushing real checkpoints out of the capped ring.
					if (latest && latest.backupName === null) {
						backups[tracking] = latest;
						return;
					}
					backups[tracking] = { backupName: null, version: nextVersion };
					dirty = true;
					return;
				}
				if (latest && latest.backupName !== null && !(await originChanged(sid, filePath, latest.backupName, st))) {
					backups[tracking] = latest; // unchanged -> reuse
					return;
				}
				backups[tracking] = await createBackup(sid, filePath, tracking, nextVersion);
				dirty = true;
			} catch {
				// skip this file; never break the turn
			}
		}),
	);

	state.pending = { v: 1, userEntryId: "", turnId: "", prompt: "", trackedFileBackups: backups, timestamp: "" };
	state.dirty = dirty;
}

/**
 * Back up a file about to be edited/written, if not already captured this turn.
 * Call from the tool_call hook BEFORE the edit lands. ENOENT target -> null
 * marker (rewind deletes the created file). Synchronous so the backup is on disk
 * before the hook returns (see createBackupSync).
 */
export function trackEdit(sid: string, absPath: string): void {
	const state = getState(sid);
	const cwd = cwdFor(sid);
	const tracking = shorten(absPath, cwd);

	if (!state.pending) {
		state.pending = { v: 1, userEntryId: "", turnId: "", prompt: "", trackedFileBackups: {}, timestamp: "" };
	}
	if (state.pending.trackedFileBackups[tracking]) return; // already captured this turn

	const latest = latestBackupOf(state, tracking);
	const version = latest ? latest.version + 1 : 1;
	const backup = createBackupSync(sid, expand(tracking, cwd), tracking, version);
	state.pending.trackedFileBackups[tracking] = backup;
	state.trackedFiles.add(tracking);
	state.dirty = true;
}

/**
 * Finalize the turn. Returns the snapshot to persist (caller appendEntry's it),
 * or null when nothing changed this turn. Pushes finalized frames into the
 * in-memory ring (capped at MAX_SNAPSHOTS).
 */
export function endTurn(
	sid: string,
	userEntryId: string,
	turnId: string,
	prompt: string,
	timestamp: string,
	maxSnapshots = MAX_SNAPSHOTS,
): FileHistorySnapshot | null {
	const state = getState(sid);
	const pending = state.pending;
	state.pending = null;
	if (!pending || !state.dirty) {
		state.dirty = false;
		return null;
	}
	state.dirty = false;
	const frame: FileHistorySnapshot = { ...pending, userEntryId, turnId, prompt, timestamp };
	state.snapshots.push(frame);
	if (state.snapshots.length > maxSnapshots) {
		const dropped = state.snapshots.slice(0, state.snapshots.length - maxSnapshots);
		state.snapshots = state.snapshots.slice(-maxSnapshots);
		void pruneDroppedBlobs(sid, dropped, state.snapshots);
	}
	state.seq++;
	return frame;
}

/**
 * Best-effort deletion of backup blobs referenced ONLY by frames dropped from
 * the capped ring. Backups are reused across frames (an unchanged file keeps
 * pointing at the same version), so a blob is unlinked only when no retained
 * frame still references it. Without this, the cap trims the in-memory index
 * while the blob files accumulate for the whole session — gc.ts only reclaims
 * whole session directories.
 */
async function pruneDroppedBlobs(
	sid: string,
	dropped: FileHistorySnapshot[],
	retained: FileHistorySnapshot[],
): Promise<void> {
	const live = new Set<string>();
	for (const snap of retained) {
		for (const b of Object.values(snap.trackedFileBackups)) {
			if (b.backupName) live.add(b.backupName);
		}
	}
	const doomed = new Set<string>();
	for (const snap of dropped) {
		for (const b of Object.values(snap.trackedFileBackups)) {
			if (b.backupName && !live.has(b.backupName)) doomed.add(b.backupName);
		}
	}
	if (doomed.size === 0) return;
	await Promise.allSettled(Array.from(doomed, (name) => unlink(backupPathFor(sid, name))));
}

// ---- rewind ---------------------------------------------------------------

/**
 * Absolute paths that restoring to `target` would change on disk (empty =
 * nothing to do). Same walk applySnapshot performs, without writing — the
 * caller can both count and preview the files from one pass.
 */
export async function collectChanges(sid: string, target: FileHistorySnapshot): Promise<string[]> {
	const state = getState(sid);
	const cwd = cwdFor(sid);
	const changed: string[] = [];
	for (const tracking of state.trackedFiles) {
		try {
			const filePath = expand(tracking, cwd);
			const tb = target.trackedFileBackups[tracking];
			const name = tb ? tb.backupName : firstBackupName(state, tracking);
			if (name === undefined) continue;
			if (name === null) {
				if (await statOrNull(filePath)) changed.push(filePath);
				continue;
			}
			if (await originChanged(sid, filePath, name)) changed.push(filePath);
		} catch {
			// ignore
		}
	}
	return changed;
}

/** Restore the work tree to `target`. Returns the list of changed file paths. */
export async function applySnapshot(sid: string, target: FileHistorySnapshot): Promise<string[]> {
	const state = getState(sid);
	const cwd = cwdFor(sid);
	const changed: string[] = [];
	for (const tracking of state.trackedFiles) {
		try {
			const filePath = expand(tracking, cwd);
			const tb = target.trackedFileBackups[tracking];
			const name = tb ? tb.backupName : firstBackupName(state, tracking);
			if (name === undefined) continue; // can't resolve -> leave file alone
			if (name === null) {
				try {
					await unlink(filePath);
					changed.push(filePath);
				} catch (e) {
					if (!isENOENT(e)) throw e;
				}
				continue;
			}
			if (await originChanged(sid, filePath, name)) {
				await restoreBackup(sid, filePath, name);
				changed.push(filePath);
			}
		} catch {
			// skip this file
		}
	}
	return changed;
}

// ---- persistence rebuild + resume migration -------------------------------

/** Rebuild in-memory state from snapshots persisted in the session JSONL. */
export function restoreStateFromSnapshots(
	sid: string,
	cwd: string,
	snapshots: FileHistorySnapshot[],
	maxSnapshots = MAX_SNAPSHOTS,
): void {
	cwds.set(sid, cwd);
	// Apply the same cap on reload so a long session's JSONL can't reinflate the
	// in-memory ring past the limit. trackedFiles is rebuilt from the retained
	// frames only (older frames are unreachable for rewind anyway); blobs only
	// those frames referenced are pruned best-effort, mirroring endTurn.
	const retained = snapshots.length > maxSnapshots ? snapshots.slice(-maxSnapshots) : snapshots;
	if (retained.length < snapshots.length) {
		void pruneDroppedBlobs(sid, snapshots.slice(0, snapshots.length - retained.length), retained);
	}
	const trackedFiles = new Set<string>();
	for (const snap of retained) {
		for (const key of Object.keys(snap.trackedFileBackups)) trackedFiles.add(key);
	}
	states.set(sid, { snapshots: [...retained], trackedFiles, pending: null, dirty: false, seq: retained.length });
}

/**
 * Hard-link this session's backup blobs from a previous session's directory
 * (resume/fork carries the conversation + its snapshot index, but the blobs live
 * under the old session id). Falls back to copy. No-op when ids match.
 */
export async function migrateBackupsFromSession(prevSid: string, sid: string, snapshots: FileHistorySnapshot[]): Promise<void> {
	if (!prevSid || prevSid === sid) return;
	const destDir = backupsDir(sid);
	await mkdir(destDir, { recursive: true });
	await Promise.allSettled(
		snapshots.flatMap((snap) =>
			Object.values(snap.trackedFileBackups)
				.filter((b): b is FileBackup & { backupName: string } => b.backupName !== null)
				.map(async ({ backupName: name }) => {
					const from = join(backupsDir(prevSid), name);
					const to = join(destDir, name);
					try {
						await link(from, to);
					} catch (e) {
						const code = (e as { code?: string }).code;
						if (code === "EEXIST") return;
						try {
							await copyFile(from, to);
						} catch {
							// best-effort; a missing blob just means that version can't restore
						}
					}
				}),
		),
	);
}

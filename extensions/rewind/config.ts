/**
 * config.ts — load/save the rewind extension's settings at
 * <rewindDir>/config.json. Mirrors advisor/config.ts: tolerant parse, atomic-ish
 * write, sensible defaults so a missing/corrupt file never breaks the session.
 *
 * Settings are user-editable via the /rewind menu (menu.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { rewindConfigPath } from "../shared/paths.ts";

export interface RewindConfig {
	/** Master switch. When false, no backups are taken and rewind is inert. */
	enabled: boolean;
	/** Backups for sessions whose dir is older than this are GC'd. 0 = keep forever. */
	retentionDays: number;
	/** Cap on retained snapshots per session. */
	maxSnapshots: number;
}

export const DEFAULT_CONFIG: RewindConfig = {
	enabled: true,
	retentionDays: 30,
	maxSnapshots: 100,
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

function normalize(raw: unknown): RewindConfig {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
	const r = raw as Partial<RewindConfig>;
	return {
		enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_CONFIG.enabled,
		retentionDays: clampInt(r.retentionDays, 0, 3650, DEFAULT_CONFIG.retentionDays),
		maxSnapshots: clampInt(r.maxSnapshots, 1, 1000, DEFAULT_CONFIG.maxSnapshots),
	};
}

export function loadRewindConfig(): RewindConfig {
	const file = rewindConfigPath();
	if (!existsSync(file)) return { ...DEFAULT_CONFIG };
	try {
		return normalize(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveRewindConfig(config: RewindConfig): boolean {
	try {
		const file = rewindConfigPath();
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(normalize(config), null, 2) + "\n", "utf8");
		return true;
	} catch {
		return false;
	}
}

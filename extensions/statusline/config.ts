/**
 * config.ts — statusline settings, persisted at
 * ~/.pi/agent/pi-config/statusline.json. Edited via the /statusline menu
 * (menu.ts) or by hand (+ /reload).
 *
 * Every field is optional on disk; the defaults reproduce the extension's
 * historical behavior exactly. Invalid values fall back per-field, never
 * rejecting the whole file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** CTX% turns warning past this (historical hard-coded 70). */
export const DEFAULT_CTX_WARN_PCT = 70;
/** CTX% turns error past this (historical hard-coded 90). */
export const DEFAULT_CTX_ERROR_PCT = 90;

export interface StatuslineConfig {
	/** CTX% threshold for the warning color. */
	ctxWarnPct: number;
	/** CTX% threshold for the error color (>= ctxWarnPct). */
	ctxErrorPct: number;
	/** Right-aligned ↑in ↓out Rcache $cost cluster. */
	showUsageStats: boolean;
	/** Second line forwarding ctx.ui.setStatus() extension statuses. */
	showStatusLine2: boolean;
}

function pctOrDefault(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(100, Math.max(0, value));
}

function boolOrDefault(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizeConfig(raw: unknown): StatuslineConfig {
	const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const warn = pctOrDefault(record.ctxWarnPct, DEFAULT_CTX_WARN_PCT);
	// Keep the tier order sane: error never below warn.
	const error = Math.max(warn, pctOrDefault(record.ctxErrorPct, DEFAULT_CTX_ERROR_PCT));
	return {
		ctxWarnPct: warn,
		ctxErrorPct: error,
		showUsageStats: boolOrDefault(record.showUsageStats, true),
		showStatusLine2: boolOrDefault(record.showStatusLine2, true),
	};
}

function statuslineConfigPath(): string {
	return join(getAgentDir(), "pi-config", "statusline.json");
}

/** Load statusline.json (missing/corrupt file → all defaults). */
export function loadStatuslineConfig(): StatuslineConfig {
	const configPath = statuslineConfigPath();
	if (!existsSync(configPath)) return normalizeConfig({});
	try {
		return normalizeConfig(JSON.parse(readFileSync(configPath, "utf8")));
	} catch {
		return normalizeConfig({});
	}
}

/** Persist statusline.json (normalized). Returns false when the write failed. */
export function saveStatuslineConfig(config: StatuslineConfig): boolean {
	const configPath = statuslineConfigPath();
	try {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, JSON.stringify(normalizeConfig(config), null, 2) + "\n", "utf8");
		return true;
	} catch {
		return false;
	}
}

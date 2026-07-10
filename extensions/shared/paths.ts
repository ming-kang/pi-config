/**
 * paths.ts — single source of truth for pi-config's on-disk storage locations.
 *
 * Every pi-config extension that persists state writes under one root:
 *   getAgentDir()/pi-config/
 * Routing all paths through here keeps the layout consistent and makes a future
 * relocation a one-line change instead of a grep-and-replace across extensions.
 *
 * Layout:
 *   <agentDir>/pi-config/
 *     statusline.json                    statusline settings (see statusline/config.ts)
 *     rewind/
 *       config.json                      rewind settings { enabled, retentionDays, maxSnapshots }
 *       backups/<sessionId>/<hash>@v<n>  rewind file-history backup blobs
 *     fast-context/
 *       config.json                      Fast Context API key (see fast-context/storage.ts)
 */
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Root for all pi-config persistent state: `<agentDir>/pi-config`. */
export function piConfigDir(): string {
	return join(getAgentDir(), "pi-config");
}

/** statusline's settings file. */
export function statuslineConfigPath(): string {
	return join(piConfigDir(), "statusline.json");
}

/** Root for the rewind extension's storage. */
export function rewindDir(): string {
	return join(piConfigDir(), "rewind");
}

/** rewind's settings file. */
export function rewindConfigPath(): string {
	return join(rewindDir(), "config.json");
}

/** Root holding every session's backup directory. */
export function rewindBackupsRoot(): string {
	return join(rewindDir(), "backups");
}

/** A single session's backup directory: `<rewindDir>/backups/<sessionId>`. */
export function rewindBackupsDir(sessionId: string): string {
	return join(rewindBackupsRoot(), sessionId);
}

/** Root holding Pi's session JSONL files: `<agentDir>/sessions`. */
export function sessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

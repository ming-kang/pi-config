/**
 * Persistent key storage under the Pi package dir (~/.pi/agent/pi-config/fast-context/config.json),
 * mirroring how Pi stores its own credentials (0600 file, 0700 dir). Kept in a
 * dedicated file rather than Pi's auth.json so it never collides with provider
 * credentials. This is the only module besides grep-backend/execute that touches
 * Pi, via getAgentDir().
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function keyFilePath(): string {
	return join(getAgentDir(), "pi-config", "fast-context", "config.json");
}

export function loadPersistedKey(): string | undefined {
	try {
		const data = JSON.parse(readFileSync(keyFilePath(), "utf-8")) as { apiKey?: unknown };
		return typeof data.apiKey === "string" && data.apiKey.trim() ? data.apiKey.trim() : undefined;
	} catch {
		return undefined; // missing or unreadable — treat as no key
	}
}

export function savePersistedKey(key: string): void {
	const path = keyFilePath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify({ apiKey: key }, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	try {
		chmodSync(path, 0o600); // no-op on platforms without POSIX perms
	} catch {
		// best-effort
	}
}

export function deletePersistedKey(): void {
	try {
		rmSync(keyFilePath(), { force: true });
	} catch {
		// ignore
	}
}

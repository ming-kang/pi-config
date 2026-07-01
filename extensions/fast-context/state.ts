/**
 * API key state: an in-memory value backed by a persistent file under the Pi
 * agent dir. Seeded on load from the persisted file, falling back to an explicit
 * FAST_CONTEXT_KEY env var (set by the user, never read from Devin's local
 * state). Setting the key persists it; clearing removes the file.
 */
import { clearJwtCache } from "./client.ts";
import { isAcceptableApiKey, looksTruncated, TRUNCATED_KEY_HINT } from "./key-format.ts";
import { deletePersistedKey, loadPersistedKey, savePersistedKey } from "./storage.ts";

function warnIfTruncated(key: string | undefined, source: string): void {
	if (key && looksTruncated(key)) {
		console.warn(`[Fast Context] ${source} ${TRUNCATED_KEY_HINT}`);
	}
}

const persistedKey = loadPersistedKey();
const envKey = process.env.FAST_CONTEXT_KEY?.trim();
warnIfTruncated(persistedKey, "saved key");
if (!persistedKey) warnIfTruncated(envKey, "FAST_CONTEXT_KEY");

let apiKey: string | undefined = persistedKey ?? (isAcceptableApiKey(envKey) ? envKey.trim() : undefined);

export function getApiKey(): string | undefined {
	return apiKey;
}

export function setApiKey(key: string): void {
	const next = key.trim();
	if (!isAcceptableApiKey(next)) return;
	warnIfTruncated(next, "new key");
	if (apiKey && apiKey !== next) clearJwtCache(apiKey);
	apiKey = next;
	savePersistedKey(next);
}

export function clearApiKey(): void {
	if (apiKey) clearJwtCache(apiKey);
	apiKey = undefined;
	deletePersistedKey();
}

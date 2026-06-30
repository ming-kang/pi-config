/**
 * json-store.ts — shared tolerant JSON config load/save.
 *
 * Every pi-config extension that persists a JSON config file (advisor, rewind)
 * used to inline the same boilerplate: missing-file → fallback, corrupt JSON →
 * fallback, save = mkdir(dirname) + write pretty JSON + try/catch → boolean.
 * Routing both through here collapses that duplication and keeps the on-disk
 * write format identical (`JSON.stringify(value, null, 2) + "\n"`).
 *
 * Callers keep their own `normalize`/`DEFAULT_CONFIG`/types — only the IO moves.
 * Paths come from `shared/paths.ts`, the single source of truth for locations.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Load and normalize a JSON config file.
 *
 * - Missing file → `fallback` (no throw).
 * - Corrupt JSON or read error → `fallback` (no throw).
 * - Otherwise → `normalize(JSON.parse(raw))`.
 *
 * @param path - Absolute config file path.
 * @param normalize - Converts the parsed `unknown` into the typed config,
 *   applying defaults/validation. Mirrors each extension's existing normalizer.
 * @param fallback - Returned when the file is absent or unparseable.
 */
export function loadJson<T>(path: string, normalize: (raw: unknown) => T, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return normalize(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return fallback;
	}
}

/**
 * Normalize and persist a config as pretty JSON. Creates the parent directory.
 * Never throws — returns `false` on any write error so callers can notify.
 *
 * @param path - Absolute config file path.
 * @param value - Already-normalized value to write (callers normalize first,
 *   matching the prior inlined `saveX(config)` shape which called normalize
 *   internally; we keep that contract by accepting the value to serialize as-is).
 * @returns `true` on success, `false` on error.
 */
export function saveJson(path: string, value: unknown): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
		return true;
	} catch {
		return false;
	}
}

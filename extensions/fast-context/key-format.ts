/**
 * API-key format helpers (pure, no I/O — node-testable).
 *
 * Devin's current key format is `devin-session-token$<JWT>`. The real credential
 * is the JWT after the `$`. That `$` is a footgun: shell and config-file env
 * expansion (e.g. an unquoted value in a TOML `env` table) eats `$eyJ…` as an
 * undefined variable, leaving a bare `devin-session-token` (or a lone `$`). The
 * server then 401s once it rotates the JWT. `looksTruncated` detects that shape
 * so the caller can warn instead of failing silently.
 *
 * Note: unlike upstream, we never *recover* the full key from a local DB — we
 * only surface a clear hint. Reading the vendor's local state is out of bounds.
 */

const DEVIN_PREFIX = "devin-session-token";

/** True for any non-empty string — the only hard requirement for a usable key. */
export function isAcceptableApiKey(key: unknown): key is string {
	return typeof key === "string" && key.trim().length > 0;
}

/**
 * Heuristic: does this look like a `devin-session-token$<JWT>` key whose JWT
 * body was eaten by `$` expansion? Only flags the Devin format; other key shapes
 * (e.g. legacy `sk-ws-…`) are never reported as truncated.
 */
export function looksTruncated(key: unknown): boolean {
	if (typeof key !== "string") return false;
	const k = key.trim();
	if (!k.startsWith(DEVIN_PREFIX)) return false;
	const dollar = k.indexOf("$");
	if (dollar === -1) return true; // `$<JWT>` gone entirely
	return !k.slice(dollar + 1).startsWith("eyJ"); // `$` kept but JWT body missing/garbled
}

/** One-line hint shown when a key looks truncated by shell/config `$` expansion. */
export const TRUNCATED_KEY_HINT =
	"key looks truncated — the '$' in devin-session-token$<JWT> may have been eaten by shell/config " +
	"variable expansion. Single-quote the value (or escape the '$') and set it again.";

/**
 * http.ts — fetch with per-attempt timeout and bounded retry for pi-config's
 * network-facing extensions.
 *
 * Policy (matching fast-context's streamingRequest): transient failures —
 * network errors, 5xx, 429 — get linear-backoff retries; caller aborts and
 * per-attempt timeouts throw immediately (a timeout already waited its full
 * budget; an abort is the caller's decision). Other statuses are returned to
 * the caller for domain-specific handling.
 *
 * Used by deepwiki. fast-context's streaming client deliberately keeps its own
 * implementation: it speaks a fragile verbatim wire protocol whose changes
 * require live backend validation (see AGENTS.md → Fast Context boundary).
 */

export interface FetchRetryOptions {
	/** Per-attempt timeout in ms. */
	timeoutMs: number;
	/** Extra attempts after the first (default 2). */
	retries?: number;
	/** Caller's abort signal, bridged into every attempt and backoff sleep. */
	signal?: AbortSignal;
	/** Label for timeout/abort error messages, e.g. "DeepWiki". */
	label?: string;
}

/** Abortable backoff sleep between retry attempts. */
function delay(ms: number, label: string, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(new Error(`${label} request aborted`));
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * One fetch attempt under a fresh AbortController that fires on the parent
 * signal or the per-attempt timeout, whichever comes first. Distinguishes the
 * two on failure so the caller can throw non-retryables immediately.
 */
async function attemptOnce(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	label: string,
	signal: AbortSignal | undefined,
): Promise<{ ok: true; response: Response; text: string } | { ok: false; error: Error }> {
	const controller = new AbortController();
	let timedOut = false;
	const abortFromParent = () => controller.abort(signal?.reason);
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	if (signal?.aborted) abortFromParent();
	else signal?.addEventListener("abort", abortFromParent, { once: true });

	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		// The body must be consumed inside the attempt: a stalled body is as much
		// a failure of this attempt as a failed connect.
		const text = await response.text();
		return { ok: true, response, text };
	} catch (error) {
		if (timedOut) throw new Error(`${label} request timed out after ${timeoutMs / 1000}s`);
		if (signal?.aborted) throw new Error(`${label} request aborted`);
		return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abortFromParent);
	}
}

/**
 * Fetch `url` with retry on transient failures. Resolves with the final
 * response and its already-read text body — including non-ok statuses that are
 * either non-retryable or survived all attempts; callers turn those into
 * domain errors. Throws on timeout, abort, or when every attempt failed at
 * the network layer.
 */
export async function fetchWithRetry(
	url: string,
	init: RequestInit,
	opts: FetchRetryOptions,
): Promise<{ response: Response; text: string }> {
	const retries = opts.retries ?? 2;
	const label = opts.label ?? "HTTP";
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= retries; attempt++) {
		if (attempt > 0) await delay(1000 * attempt, label, opts.signal);
		const outcome = await attemptOnce(url, init, opts.timeoutMs, label, opts.signal);
		if (!outcome.ok) {
			lastError = outcome.error;
			continue;
		}
		const { response, text } = outcome;
		const retryable = response.status >= 500 || response.status === 429;
		if (!response.ok && retryable && attempt < retries) {
			lastError = new Error(`${label} HTTP ${response.status}`);
			continue;
		}
		return { response, text };
	}
	throw lastError ?? new Error(`${label} request failed`);
}

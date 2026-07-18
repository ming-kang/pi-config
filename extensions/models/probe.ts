/**
 * models — probe
 *
 * Fetch /v1/models from a custom provider so the user can pick which ones
 * to register. Best-effort: every failure mode returns `{ ok: false, error }`
 * rather than throwing, so the wizard can fall back to manual model-id entry.
 *
 * Supported endpoints:
 * - openai-completions / openai-responses:  GET <baseUrl>/models  (Bearer auth)
 * - anthropic-messages:                     no public list endpoint
 * - google-generative-ai:                   GET <baseUrl>/models?key=<apiKey>
 * - Ollama native fallback (port 11434):    GET <baseUrl>/../api/tags  (no auth)
 */

import { DEFAULTS } from "./constants.ts";

export interface ProbeOptions {
	baseUrl: string;
	apiKey?: string;
	api: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface ProbeModel {
	id: string;
	name?: string;
}

export type ProbeResult = { ok: true; models: ProbeModel[] } | { ok: false; error: string };

// ============================================================================
// Public entry
// ============================================================================

export async function probeModels(opts: ProbeOptions): Promise<ProbeResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULTS.probeTimeoutMs;
	const signal = combineSignals(opts.signal, timeoutMs);

	try {
		const url = new URL(opts.baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return { ok: false, error: `unsupported protocol: ${url.protocol}` };
		}

		switch (opts.api) {
			case "openai-completions":
			case "openai-responses":
				return await probeOpenAICompat(opts, signal);

			case "anthropic-messages":
				return {
					ok: false,
					error: "Anthropic does not expose a public /models endpoint. Enter model ids manually.",
				};

			case "google-generative-ai":
				return await probeGoogle(opts, signal);

			default:
				return { ok: false, error: `unsupported api: ${opts.api}` };
		}
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// ============================================================================
// Per-API probes
// ============================================================================

async function probeOpenAICompat(opts: ProbeOptions, signal: AbortSignal): Promise<ProbeResult> {
	const trimmedBase = opts.baseUrl.replace(/\/+$/, "");

	// Try OpenAI-style /models first
	const primary = await fetchOnce(`${trimmedBase}/models`, buildHeaders(opts, "bearer"), signal);
	if (primary.ok) {
		const models = parseOpenAIData(primary.body);
		if (models !== null) return { ok: true, models };
	}

	// Ollama native fallback: baseUrl ends with /v1 and host looks like local Ollama
	const ollamaMatch = /^(https?:\/\/[^/]+(:\d+)?)\/v1\/?$/i.exec(trimmedBase);
	if (ollamaMatch) {
		const ollamaBase = ollamaMatch[1];
		const fallback = await fetchOnce(`${ollamaBase}/api/tags`, {}, signal);
		if (fallback.ok) {
			const models = parseOllamaTags(fallback.body);
			if (models !== null) return { ok: true, models };
		}
	}

	return {
		ok: false,
		error: primary.error ?? "endpoint did not return a recognizable model list",
	};
}

async function probeGoogle(opts: ProbeOptions, signal: AbortSignal): Promise<ProbeResult> {
	const trimmedBase = opts.baseUrl.replace(/\/+$/, "");
	if (!opts.apiKey) {
		return { ok: false, error: "Google Generative AI probe requires an API key (used as ?key=…)" };
	}
	const url = `${trimmedBase}/models?key=${encodeURIComponent(opts.apiKey)}&pageSize=200`;
	const result = await fetchOnce(url, {}, signal);
	if (!result.ok) return { ok: false, error: result.error };

	const models = parseGoogleModels(result.body);
	if (models === null) {
		return { ok: false, error: "Google endpoint did not return a `models` array" };
	}
	return { ok: true, models };
}

// ============================================================================
// Helpers
// ============================================================================

function buildHeaders(opts: ProbeOptions, authStyle: "bearer" | "google"): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers ?? {}) };
	if (authStyle === "bearer" && opts.apiKey) {
		headers.Authorization = `Bearer ${opts.apiKey}`;
	}
	return headers;
}

function combineSignals(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("probe timed out")), timeoutMs);
	const onExternalAbort = () => controller.abort(external?.reason);
	if (external) {
		if (external.aborted) controller.abort(external.reason);
		else external.addEventListener("abort", onExternalAbort, { once: true });
	}
	controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
	return controller.signal;
}

interface FetchOutcome {
	ok: boolean;
	status: number;
	body: string;
	error?: string;
}

async function fetchOnce(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<FetchOutcome> {
	try {
		const res = await fetch(url, { method: "GET", headers, signal });
		const body = await res.text();
		if (!res.ok) {
			return { ok: false, status: res.status, body, error: `HTTP ${res.status}` };
		}
		return { ok: true, status: res.status, body };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 0, body: "", error: msg };
	}
}

// ============================================================================
// Response parsers — return null when the body doesn't match the expected shape
// ============================================================================

function parseOpenAIData(body: string): ProbeModel[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const data = (parsed as { data?: unknown }).data;
	if (!Array.isArray(data)) return null;
	const models: ProbeModel[] = [];
	for (const item of data) {
		if (!item || typeof item !== "object") continue;
		const id = (item as { id?: unknown }).id;
		if (typeof id !== "string" || !id) continue;
		const name = typeof (item as { name?: unknown }).name === "string" ? ((item as { name: string }).name) : undefined;
		models.push(name ? { id, name } : { id });
	}
	return models;
}

function parseOllamaTags(body: string): ProbeModel[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const models = (parsed as { models?: unknown }).models;
	if (!Array.isArray(models)) return null;
	const out: ProbeModel[] = [];
	for (const item of models) {
		if (!item || typeof item !== "object") continue;
		const name = (item as { name?: unknown }).name ?? (item as { model?: unknown }).model;
		if (typeof name !== "string" || !name) continue;
		out.push({ id: name });
	}
	return out;
}

function parseGoogleModels(body: string): ProbeModel[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const models = (parsed as { models?: unknown }).models;
	if (!Array.isArray(models)) return null;
	const out: ProbeModel[] = [];
	for (const item of models) {
		if (!item || typeof item !== "object") continue;
		const name = (item as { name?: unknown }).name;
		if (typeof name !== "string" || !name) continue;
		// Google's `name` is "models/gemini-pro" — keep the suffix only so it matches what
		// the user types in their request path.
		const id = name.startsWith("models/") ? name.slice("models/".length) : name;
		if (!id) continue;
		const displayName =
			typeof (item as { displayName?: unknown }).displayName === "string"
				? ((item as { displayName: string }).displayName)
				: undefined;
		out.push(displayName ? { id, name: displayName } : { id });
	}
	return out;
}
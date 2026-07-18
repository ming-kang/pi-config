/** Bounded, best-effort model catalog probing for supported APIs. */

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

export type ProbeResult =
	| { ok: true; models: ProbeModel[]; omitted: number; truncated: boolean }
	| { ok: false; error: string };

export async function probeModels(opts: ProbeOptions): Promise<ProbeResult> {
	let baseUrl: URL;
	try {
		baseUrl = new URL(opts.baseUrl);
	} catch {
		return { ok: false, error: "Base URL is not a valid URL." };
	}
	if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
		return { ok: false, error: `Unsupported protocol: ${baseUrl.protocol}` };
	}

	const combined = createProbeSignal(opts.signal, opts.timeoutMs ?? DEFAULTS.probeTimeoutMs);
	try {
		let result: ProbeResult;
		switch (opts.api) {
			case "openai-completions":
			case "openai-responses":
				result = await probeOpenAICompat(baseUrl, opts, combined.signal);
				break;
			case "anthropic-messages":
				result = {
					ok: false,
					error: "Anthropic Messages has no public model-list endpoint; add model IDs manually.",
				};
				break;
			case "google-generative-ai":
				result = await probeGoogle(baseUrl, opts, combined.signal);
				break;
			default:
				result = { ok: false, error: `Unsupported API: ${opts.api}` };
		}
		if (!result.ok) return result;
		return normalizeModels(result.models, result.omitted, result.truncated);
	} catch (error) {
		return { ok: false, error: formatFetchError(error, combined.signal) };
	} finally {
		combined.dispose();
	}
}

async function probeOpenAICompat(
	baseUrl: URL,
	opts: ProbeOptions,
	signal: AbortSignal,
): Promise<ProbeResult> {
	const headers = buildHeaders(opts);
	const primaryUrl = appendPath(baseUrl, "models");
	const primary = await fetchOnce(primaryUrl, headers, signal);
	if (primary.ok) {
		const models = parseOpenAIData(primary.body);
		if (models !== null) return { ok: true, models, omitted: 0, truncated: false };
	}

	if (baseUrl.pathname.replace(/\/+$/, "").endsWith("/v1")) {
		const ollamaUrl = new URL("/api/tags", baseUrl.origin);
		const fallback = await fetchOnce(ollamaUrl, { Accept: "application/json" }, signal);
		if (fallback.ok) {
			const models = parseOllamaTags(fallback.body);
			if (models !== null) return { ok: true, models, omitted: 0, truncated: false };
		}
	}

	return {
		ok: false,
		error: primary.ok
			? "The endpoint returned JSON without an OpenAI-style `data` array."
			: primary.error,
	};
}

async function probeGoogle(baseUrl: URL, opts: ProbeOptions, signal: AbortSignal): Promise<ProbeResult> {
	const models: ProbeModel[] = [];
	let pageToken: string | undefined;
	for (let page = 0; page < 10 && models.length < DEFAULTS.probeMaxModels; page++) {
		const url = appendPath(baseUrl, "models");
		url.searchParams.set("pageSize", "200");
		if (opts.apiKey) url.searchParams.set("key", opts.apiKey);
		if (pageToken) url.searchParams.set("pageToken", pageToken);
		const result = await fetchOnce(url, buildHeaders({ ...opts, apiKey: undefined }), signal);
		if (!result.ok) return { ok: false, error: result.error };
		const parsed = parseGoogleModels(result.body);
		if (parsed === null) return { ok: false, error: "Google returned JSON without a `models` array." };
		models.push(...parsed.models);
		pageToken = parsed.nextPageToken;
		if (!pageToken) break;
	}
	return { ok: true, models, omitted: 0, truncated: Boolean(pageToken) };
}

function buildHeaders(opts: ProbeOptions): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers ?? {}) };
	if (opts.apiKey && !hasHeader(headers, "authorization")) headers.Authorization = `Bearer ${opts.apiKey}`;
	return headers;
}

function hasHeader(headers: Record<string, string>, expected: string): boolean {
	return Object.keys(headers).some((name) => name.toLowerCase() === expected);
}

function appendPath(baseUrl: URL, segment: string): URL {
	const url = new URL(baseUrl);
	const normalized = url.pathname.replace(/\/+$/, "");
	if (!normalized.endsWith(`/${segment}`)) url.pathname = `${normalized}/${segment}`.replace(/^\/{2,}/, "/");
	url.search = "";
	url.hash = "";
	return url;
}

interface FetchOutcome {
	ok: boolean;
	status: number;
	body: string;
	error: string;
}

async function fetchOnce(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<FetchOutcome> {
	try {
		const response = await fetch(url, { method: "GET", headers, signal });
		const body = await readBodyBounded(response, DEFAULTS.probeBodyBytes);
		if (!response.ok) {
			const detail = body.trim().replace(/\s+/g, " ").slice(0, 240);
			return {
				ok: false,
				status: response.status,
				body,
				error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
			};
		}
		return { ok: true, status: response.status, body, error: "" };
	} catch (error) {
		return { ok: false, status: 0, body: "", error: formatFetchError(error, signal) };
	}
}

async function readBodyBounded(response: Response, maxBytes: number): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new Error(`Model catalog exceeds the ${formatBytes(maxBytes)} response limit.`);
	}
	if (!response.body) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (bytes > maxBytes) {
			await reader.cancel();
			throw new Error(`Model catalog exceeds the ${formatBytes(maxBytes)} response limit.`);
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

function parseOpenAIData(body: string): ProbeModel[] | null {
	const parsed = parseObject(body);
	if (!parsed || !Array.isArray(parsed.data)) return null;
	const models: ProbeModel[] = [];
	for (const item of parsed.data) {
		if (!isObject(item) || typeof item.id !== "string") continue;
		const name = typeof item.name === "string" ? item.name : undefined;
		models.push(name ? { id: item.id, name } : { id: item.id });
	}
	return models;
}

function parseOllamaTags(body: string): ProbeModel[] | null {
	const parsed = parseObject(body);
	if (!parsed || !Array.isArray(parsed.models)) return null;
	const models: ProbeModel[] = [];
	for (const item of parsed.models) {
		if (!isObject(item)) continue;
		const id = typeof item.name === "string" ? item.name : typeof item.model === "string" ? item.model : undefined;
		if (id) models.push({ id });
	}
	return models;
}

function parseGoogleModels(body: string): { models: ProbeModel[]; nextPageToken?: string } | null {
	const parsed = parseObject(body);
	if (!parsed || !Array.isArray(parsed.models)) return null;
	const models: ProbeModel[] = [];
	for (const item of parsed.models) {
		if (!isObject(item) || typeof item.name !== "string") continue;
		const id = item.name.startsWith("models/") ? item.name.slice("models/".length) : item.name;
		if (!id) continue;
		const name = typeof item.displayName === "string" ? item.displayName : undefined;
		models.push(name ? { id, name } : { id });
	}
	return {
		models,
		nextPageToken: typeof parsed.nextPageToken === "string" ? parsed.nextPageToken : undefined,
	};
}

function normalizeModels(models: ProbeModel[], alreadyOmitted: number, alreadyTruncated: boolean): ProbeResult {
	const deduplicated = new Map<string, ProbeModel>();
	for (const model of models) {
		const id = model.id.trim();
		if (!id || deduplicated.has(id)) continue;
		const name = model.name?.trim();
		deduplicated.set(id, name && name !== id ? { id, name } : { id });
	}
	const sorted = [...deduplicated.values()].sort((a, b) => a.id.localeCompare(b.id));
	const omitted = alreadyOmitted + Math.max(0, sorted.length - DEFAULTS.probeMaxModels);
	return {
		ok: true,
		models: sorted.slice(0, DEFAULTS.probeMaxModels),
		omitted,
		truncated: alreadyTruncated || sorted.length > DEFAULTS.probeMaxModels,
	};
}

function createProbeSignal(external: AbortSignal | undefined, timeoutMs: number): {
	signal: AbortSignal;
	dispose: () => void;
} {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`Probe timed out after ${timeoutMs} ms.`)), timeoutMs);
	const abortFromExternal = () => controller.abort(external?.reason);
	if (external?.aborted) abortFromExternal();
	else external?.addEventListener("abort", abortFromExternal, { once: true });
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			external?.removeEventListener("abort", abortFromExternal);
		},
	};
}

function parseObject(body: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(body);
		return isObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatFetchError(error: unknown, signal: AbortSignal): string {
	if (signal.aborted) {
		const reason = signal.reason;
		return reason instanceof Error ? reason.message : "Probe was cancelled.";
	}
	return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
	return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

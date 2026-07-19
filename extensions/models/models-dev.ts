/**
 * Read-only models.dev references for the Limits editor.
 *
 * This module never writes configuration and never treats catalog data as a
 * route-authoritative model definition. It offers one thresholded best match
 * solely to give users a compact comparison while they set effective limits.
 */

import { readBodyBounded } from "./http.ts";

const CATALOG_URL = "https://models.dev/api.json";
const CATALOG_TIMEOUT_MS = 15_000;
const CATALOG_MAX_BYTES = 16 * 1024 * 1024;
// Most useful aliases normalize to an exact suffix match. Keep loose fuzzy
// matching deliberately conservative so a nearby model version is not shown
// as a persuasive-looking reference.
const MIN_REFERENCE_SCORE = 0.9;

export interface ModelsDevReferenceQuery {
	modelId: string;
	providerId?: string;
	baseUrl?: string;
}

export interface ModelsDevReference {
	providerId: string;
	providerName: string;
	modelId: string;
	modelName: string;
	match: "exact" | "similar";
	contextWindow?: number;
	maxTokens?: number;
}

export interface ModelsDevCatalogModel {
	providerId: string;
	providerName: string;
	providerApi?: string;
	modelId: string;
	modelName: string;
	contextWindow?: number;
	maxTokens?: number;
}

interface ModelsDevCatalogIndex {
	models: readonly ModelsDevCatalogModel[];
	/** Lowercased raw model IDs → catalog rows. */
	byRawId: Map<string, ModelsDevCatalogModel[]>;
	/** Alphanumeric-normalized variants → catalog rows. */
	byNormalized: Map<string, ModelsDevCatalogModel[]>;
}

let cachedCatalog: ModelsDevCatalogModel[] | undefined;
let cachedIndex: ModelsDevCatalogIndex | undefined;
let catalogRequest: Promise<ModelsDevCatalogModel[]> | undefined;

/**
 * Fetch the public catalog at most once per extension runtime. A failed
 * request is not cached, so opening Limits later can retry. The optional
 * reference must never block model editing when it is unavailable.
 */
export async function findModelsDevReference(query: ModelsDevReferenceQuery): Promise<ModelsDevReference | undefined> {
	const catalog = await loadCatalog();
	return findBestModelsDevReference(catalog, query);
}

/**
 * Prefer exact / normalized ID hits via index lookup. Does not scan the full
 * catalog with edit-distance: gateway aliases (e.g. `route/model-id`) resolve
 * through shared normalized suffixes, while unrelated IDs return no reference.
 */
export function findBestModelsDevReference(
	catalog: readonly ModelsDevCatalogModel[],
	query: ModelsDevReferenceQuery,
): ModelsDevReference | undefined {
	const cleanId = query.modelId.trim();
	if (!cleanId) return undefined;

	const index =
		cachedIndex && cachedIndex.models === catalog ? cachedIndex : buildModelsDevCatalogIndex(catalog);

	const left = identifierVariants(cleanId);
	const candidates = new Map<ModelsDevCatalogModel, { score: number; exact: boolean }>();

	for (const model of index.byRawId.get(left.raw) ?? []) {
		candidates.set(model, { score: 1, exact: true });
	}

	for (const variant of left.values) {
		for (const model of index.byNormalized.get(variant) ?? []) {
			if (candidates.has(model)) continue;
			candidates.set(model, { score: 0.97, exact: false });
		}
	}

	const best = pickBestCandidate(candidates, query);
	return best && best.score >= MIN_REFERENCE_SCORE ? toReference(best) : undefined;
}

function buildModelsDevCatalogIndex(catalog: readonly ModelsDevCatalogModel[]): ModelsDevCatalogIndex {
	const byRawId = new Map<string, ModelsDevCatalogModel[]>();
	const byNormalized = new Map<string, ModelsDevCatalogModel[]>();
	for (const model of catalog) {
		const variants = identifierVariants(model.modelId);
		const rawBucket = byRawId.get(variants.raw);
		if (rawBucket) rawBucket.push(model);
		else byRawId.set(variants.raw, [model]);
		for (const value of variants.values) {
			const bucket = byNormalized.get(value);
			if (bucket) bucket.push(model);
			else byNormalized.set(value, [model]);
		}
	}
	return { models: catalog, byRawId, byNormalized };
}

function pickBestCandidate(
	candidates: Map<ModelsDevCatalogModel, { score: number; exact: boolean }>,
	query: ModelsDevReferenceQuery,
): { model: ModelsDevCatalogModel; score: number; exact: boolean } | undefined {
	let best: { model: ModelsDevCatalogModel; score: number; exact: boolean } | undefined;
	for (const [model, idScore] of candidates) {
		let score = idScore.score;
		if (score < MIN_REFERENCE_SCORE) continue;
		// Provider hints only break close ties. They must never turn a gateway
		// route into an authoritative match for a direct-provider catalog entry.
		if (sameIdentifier(query.providerId, model.providerId)) score += 0.04;
		if (sameHost(query.baseUrl, model.providerApi)) score += 0.06;
		if (!best || score > best.score || (score === best.score && idScore.exact && !best.exact)) {
			best = { model, score, exact: idScore.exact };
		}
	}
	return best;
}

function toReference(best: {
	model: ModelsDevCatalogModel;
	score: number;
	exact: boolean;
}): ModelsDevReference {
	return {
		providerId: best.model.providerId,
		providerName: best.model.providerName,
		modelId: best.model.modelId,
		modelName: best.model.modelName,
		match: best.exact ? "exact" : "similar",
		contextWindow: best.model.contextWindow,
		maxTokens: best.model.maxTokens,
	};
}

/** Exported for focused offline smoke tests; production callers use the lazy fetch above. */
export function parseModelsDevCatalog(payload: unknown): ModelsDevCatalogModel[] {
	if (!isRecord(payload)) return [];
	const catalog: ModelsDevCatalogModel[] = [];
	for (const [providerKey, providerValue] of Object.entries(payload)) {
		if (!isRecord(providerValue) || !isRecord(providerValue.models)) continue;
		const providerId = stringValue(providerValue.id) ?? providerKey;
		const providerName = stringValue(providerValue.name) ?? providerId;
		const providerApi = stringValue(providerValue.api);
		for (const [modelKey, modelValue] of Object.entries(providerValue.models)) {
			if (!isRecord(modelValue)) continue;
			const modelId = stringValue(modelValue.id) ?? modelKey;
			if (!modelId.trim()) continue;
			const limit = isRecord(modelValue.limit) ? modelValue.limit : undefined;
			const contextWindow = positiveSafeInteger(limit?.context);
			const maxTokens = positiveSafeInteger(limit?.output);
			// The Limits panel is intentionally narrow. Models without either
			// relevant field add noise without providing a usable reference.
			if (contextWindow === undefined && maxTokens === undefined) continue;
			catalog.push({
				providerId,
				providerName,
				providerApi,
				modelId,
				modelName: stringValue(modelValue.name) ?? modelId,
				contextWindow,
				maxTokens,
			});
		}
	}
	return catalog;
}

async function loadCatalog(): Promise<ModelsDevCatalogModel[]> {
	if (cachedCatalog) return cachedCatalog;
	if (!catalogRequest) {
		catalogRequest = fetchCatalog().then(
			(catalog) => {
				cachedCatalog = catalog;
				cachedIndex = buildModelsDevCatalogIndex(catalog);
				return catalog;
			},
			(error) => {
				catalogRequest = undefined;
				throw error;
			},
		);
	}
	return catalogRequest;
}

async function fetchCatalog(): Promise<ModelsDevCatalogModel[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("models.dev lookup timed out.")), CATALOG_TIMEOUT_MS);
	try {
		const response = await fetch(CATALOG_URL, {
			headers: { Accept: "application/json" },
			signal: controller.signal,
		});
		const body = await readBodyBounded(
			response,
			CATALOG_MAX_BYTES,
			"models.dev catalog exceeds the response limit.",
		);
		if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}.`);
		let payload: unknown;
		try {
			payload = JSON.parse(body);
		} catch {
			throw new Error("models.dev returned invalid JSON.");
		}
		return parseModelsDevCatalog(payload);
	} finally {
		clearTimeout(timer);
	}
}

function identifierVariants(value: string): { raw: string; values: string[] } {
	const raw = value.trim().toLowerCase();
	const parts = raw.split("/").filter(Boolean);
	const values = new Set<string>();
	const add = (candidate: string) => {
		const normalized = candidate.toLowerCase().replace(/[^a-z0-9]+/g, "");
		if (normalized) values.add(normalized);
	};
	add(raw);
	for (let index = 0; index < parts.length; index++) add(parts.slice(index).join("/"));
	return { raw, values: [...values] };
}

function sameIdentifier(left: string | undefined, right: string | undefined): boolean {
	if (!left || !right) return false;
	return identifierVariants(left).values.some((value) => identifierVariants(right).values.includes(value));
}

function sameHost(left: string | undefined, right: string | undefined): boolean {
	if (!left || !right) return false;
	try {
		return new URL(left).host.toLowerCase() === new URL(right).host.toLowerCase();
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	return cleaned || undefined;
}

function positiveSafeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

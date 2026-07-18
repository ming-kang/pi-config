/**
 * Read-only models.dev references for the Limits editor.
 *
 * This module never writes configuration and never treats catalog data as a
 * route-authoritative model definition. It offers one thresholded best match
 * solely to give users a compact comparison while they set effective limits.
 */

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

let cachedCatalog: ModelsDevCatalogModel[] | undefined;
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

export function findBestModelsDevReference(
	catalog: readonly ModelsDevCatalogModel[],
	query: ModelsDevReferenceQuery,
): ModelsDevReference | undefined {
	const cleanId = query.modelId.trim();
	if (!cleanId) return undefined;

	let best: { model: ModelsDevCatalogModel; score: number; exact: boolean } | undefined;
	for (const model of catalog) {
		const idScore = identifierScore(cleanId, model.modelId);
		let score = idScore.score;
		if (score < MIN_REFERENCE_SCORE) continue;

		// Provider hints only break close ties. They must never turn a gateway
		// route into an authoritative match for a direct-provider catalog entry.
		if (sameIdentifier(query.providerId, model.providerId)) score += 0.04;
		if (sameHost(query.baseUrl, model.providerApi)) score += 0.06;

		const exact = idScore.exact;
		if (!best || score > best.score || (score === best.score && exact && !best.exact)) {
			best = { model, score, exact };
		}
	}
	if (!best) return undefined;

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
		const body = await readBodyBounded(response, CATALOG_MAX_BYTES);
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

async function readBodyBounded(response: Response, maxBytes: number): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new Error("models.dev catalog exceeds the response limit.");
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
			throw new Error("models.dev catalog exceeds the response limit.");
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

function identifierScore(left: string, right: string): { score: number; exact: boolean } {
	const leftVariants = identifierVariants(left);
	const rightVariants = identifierVariants(right);
	if (leftVariants.raw === rightVariants.raw) return { score: 1, exact: true };
	if (leftVariants.values.some((value) => rightVariants.values.includes(value))) return { score: 0.97, exact: false };

	let score = 0;
	for (const leftValue of leftVariants.values) {
		for (const rightValue of rightVariants.values) {
			score = Math.max(score, blendedSimilarity(leftValue, rightValue));
		}
	}
	return { score, exact: false };
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

function blendedSimilarity(left: string, right: string): number {
	if (!left || !right) return 0;
	const edit = 1 - levenshteinDistance(left, right) / Math.max(left.length, right.length);
	const leftTokens = identifierTokens(left);
	const rightTokens = identifierTokens(right);
	const shared = leftTokens.filter((token) => rightTokens.includes(token)).length;
	const dice = leftTokens.length + rightTokens.length > 0 ? (2 * shared) / (leftTokens.length + rightTokens.length) : 0;
	return edit * 0.65 + dice * 0.35;
}

function identifierTokens(value: string): string[] {
	const tokens = value.match(/[a-z]+|\d+/g) ?? [];
	return [...new Set(tokens)];
}

function levenshteinDistance(left: string, right: string): number {
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
		const current = [leftIndex];
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
			current[rightIndex] = Math.min(
				current[rightIndex - 1]! + 1,
				previous[rightIndex]! + 1,
				previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return previous[right.length]!;
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

/**
 * models — store
 *
 * Read/merge/atomic-write for ~/.pi/agent/models.json. The file's canonical
 * shape is `{ providers: Record<id, ProviderEntry> }`. We preserve any fields
 * the wizard doesn't model (compat, thinkingLevelMap, oauth, …) by passing
 * them through untouched on edit — `_passthrough` on read, re-merged on write.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Types — mirrors models.json
// ============================================================================

export interface CostTier {
	inputTokensAbove: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface Cost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: CostTier[];
}

export interface ModelEntry {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: Cost;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	[_key: string]: unknown;
}

export interface ProviderEntry {
	name?: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	compat?: Record<string, unknown>;
	modelOverrides?: Record<string, Record<string, unknown>>;
	models?: ModelEntry[];
	oauth?: Record<string, unknown>;
	[_key: string]: unknown;
}

export interface ModelsFile {
	providers: Record<string, ProviderEntry>;
	[_key: string]: unknown;
}

/** Set of provider-level keys the wizard understands. Everything else is passthrough. */
const KNOWN_PROVIDER_KEYS = new Set([
	"name",
	"baseUrl",
	"api",
	"apiKey",
	"headers",
	"authHeader",
	"compat",
	"modelOverrides",
	"models",
	"oauth",
]);

/** Set of model-level keys the wizard understands. Everything else is passthrough. */
const KNOWN_MODEL_KEYS = new Set([
	"id",
	"name",
	"api",
	"baseUrl",
	"reasoning",
	"thinkingLevelMap",
	"input",
	"contextWindow",
	"maxTokens",
	"cost",
	"headers",
	"compat",
]);

/** Split an entry into known fields and an opaque passthrough bag. */
export function splitPassthrough<T extends Record<string, unknown>>(
	entry: T,
	knownKeys: Set<string>,
): { known: Partial<T>; passthrough: Record<string, unknown> } {
	const known: Partial<T> = {};
	const passthrough: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(entry)) {
		if (knownKeys.has(k)) {
			(known as Record<string, unknown>)[k] = v;
		} else {
			passthrough[k] = v;
		}
	}
	return { known, passthrough };
}

/** Merge known fields back over a passthrough bag. Known fields win. */
export function mergePassthrough<T extends Record<string, unknown>>(
	known: Partial<T>,
	passthrough: Record<string, unknown>,
): T {
	return { ...passthrough, ...known } as T;
}

// ============================================================================
// I/O
// ============================================================================

export function getModelsJsonPath(): string {
	return join(getAgentDir(), "models.json");
}

export async function readModelsJson(): Promise<ModelsFile> {
	const path = getModelsJsonPath();
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { providers: {} };
		throw new Error(`Failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
	}
	const trimmed = text.trim();
	if (!trimmed) return { providers: {} };
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("expected an object");
		}
		const providers = (parsed as { providers?: unknown }).providers;
		if (providers === undefined) return { providers: {} };
		if (providers === null || typeof providers !== "object" || Array.isArray(providers)) {
			throw new Error("`providers` must be an object");
		}
		return { providers: providers as Record<string, ProviderEntry> };
	} catch (err) {
		throw new Error(`Invalid models.json: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Atomic write: serialize, write to .tmp, rename onto target. */
export async function writeModelsJson(data: ModelsFile): Promise<void> {
	const path = getModelsJsonPath();
	const content = `${JSON.stringify(data, null, 2)}\n`;
	const tmp = `${path}.tmp`;
	try {
		await writeFile(tmp, content, "utf8");
		await rename(tmp, path);
	} catch (err) {
		throw new Error(`Failed to write ${path}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Insert or replace a provider entry. Preserves all other providers untouched. */
export async function upsertProvider(id: string, entry: ProviderEntry): Promise<void> {
	const current = await readModelsJson();
	current.providers[id] = entry;
	await writeModelsJson(current);
}

/** Remove a provider entry. No-op if absent. */
export async function removeProvider(id: string): Promise<void> {
	const current = await readModelsJson();
	if (!(id in current.providers)) return;
	delete current.providers[id];
	await writeModelsJson(current);
}

/** True when the provider id already exists in the file. */
export async function providerExists(id: string): Promise<boolean> {
	const current = await readModelsJson();
	return id in current.providers;
}

/** Snapshot of currently configured provider ids, sorted. */
export async function listProviderIds(): Promise<string[]> {
	const current = await readModelsJson();
	return Object.keys(current.providers).sort();
}

/** Read a single provider entry, or undefined. */
export async function getProvider(id: string): Promise<ProviderEntry | undefined> {
	const current = await readModelsJson();
	return current.providers[id];
}
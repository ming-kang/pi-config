/**
 * Lossless, transactional-friendly access to ~/.pi/agent/models.json.
 *
 * Pi accepts JSON with comments, so reads strip comments without touching
 * quoted strings. Successful writes normalize the file to plain JSON while
 * preserving every top-level, provider-level, model-level, and nested field
 * that the manager did not edit.
 */

import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ModelInput = "text" | "image";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

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
	thinkingLevelMap?: ThinkingLevelMap;
	input?: ModelInput[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: Cost;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	[_key: string]: unknown;
}

export interface ModelOverride {
	name?: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input?: ModelInput[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: Partial<Cost>;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	[_key: string]: unknown;
}

export interface ProviderEntry {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	oauth?: "radius";
	headers?: Record<string, string>;
	authHeader?: boolean;
	compat?: Record<string, unknown>;
	modelOverrides?: Record<string, ModelOverride>;
	models?: ModelEntry[];
	[_key: string]: unknown;
}

export interface ModelsFile {
	providers: Record<string, ProviderEntry>;
	[_key: string]: unknown;
}

export interface ModelsFileSnapshot {
	exists: boolean;
	content?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Remove // and block comments while preserving strings and line numbers. */
export function stripJsonComments(input: string): string {
	let output = "";
	let inString = false;
	let escaped = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < input.length; i++) {
		const char = input[i]!;
		const next = input[i + 1];

		if (inLineComment) {
			if (char === "\n" || char === "\r") {
				inLineComment = false;
				output += char;
			} else {
				output += " ";
			}
			continue;
		}

		if (inBlockComment) {
			if (char === "*" && next === "/") {
				output += "  ";
				i++;
				inBlockComment = false;
			} else {
				output += char === "\n" || char === "\r" ? char : " ";
			}
			continue;
		}

		if (inString) {
			output += char;
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			output += char;
			continue;
		}
		if (char === "/" && next === "/") {
			output += "  ";
			i++;
			inLineComment = true;
			continue;
		}
		if (char === "/" && next === "*") {
			output += "  ";
			i++;
			inBlockComment = true;
			continue;
		}

		output += char;
	}

	return output;
}

export function getModelsJsonPath(): string {
	return join(getAgentDir(), "models.json");
}

export async function captureModelsJsonSnapshot(): Promise<ModelsFileSnapshot> {
	try {
		return { exists: true, content: await readFile(getModelsJsonPath(), "utf8") };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
		throw new Error(`Failed to snapshot ${getModelsJsonPath()}: ${formatError(error)}`);
	}
}

export async function restoreModelsJsonSnapshot(snapshot: ModelsFileSnapshot): Promise<void> {
	const path = getModelsJsonPath();
	if (!snapshot.exists) {
		try {
			await unlink(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error(`Failed to remove ${path} during rollback: ${formatError(error)}`);
			}
		}
		return;
	}
	await writeTextAtomically(path, snapshot.content ?? "");
}

export async function readModelsJson(): Promise<ModelsFile> {
	const path = getModelsJsonPath();
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: {} };
		throw new Error(`Failed to read ${path}: ${formatError(error)}`);
	}

	return parseModelsJsonText(text);
}

export function parseModelsJsonText(text: string): ModelsFile {
	const trimmed = text.replace(/^\uFEFF/, "").trim();
	if (!trimmed) return { providers: {} };

	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(trimmed));
	} catch (error) {
		throw new Error(`Invalid models.json: ${formatError(error)}`);
	}
	if (!isRecord(parsed)) throw new Error("Invalid models.json: expected an object at the root");

	const providers = parsed.providers;
	if (providers === undefined) return { ...parsed, providers: {} } as ModelsFile;
	if (!isRecord(providers)) throw new Error("Invalid models.json: `providers` must be an object");

	for (const [providerId, entry] of Object.entries(providers)) {
		if (!isRecord(entry)) {
			throw new Error(`Invalid models.json: provider "${providerId}" must be an object`);
		}
	}

	return { ...parsed, providers: providers as Record<string, ProviderEntry> } as ModelsFile;
}

export async function writeModelsJson(data: ModelsFile): Promise<void> {
	await writeTextAtomically(getModelsJsonPath(), `${JSON.stringify(data, null, 2)}\n`);
}

export async function writeModelsJsonText(content: string): Promise<void> {
	await writeTextAtomically(getModelsJsonPath(), content);
}

export async function listProviders(): Promise<Array<{ id: string; entry: ProviderEntry }>> {
	const current = await readModelsJson();
	return Object.entries(current.providers)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, entry]) => ({ id, entry: structuredClone(entry) }));
}

export async function listProviderIds(): Promise<string[]> {
	return (await listProviders()).map((provider) => provider.id);
}

export async function getProvider(id: string): Promise<ProviderEntry | undefined> {
	const entry = (await readModelsJson()).providers[id];
	return entry === undefined ? undefined : structuredClone(entry);
}

/** Add, replace, or rename a provider with one read and one atomic write. */
export async function saveProvider(
	originalId: string | undefined,
	newId: string,
	entry: ProviderEntry,
): Promise<void> {
	const current = await readModelsJson();
	if (originalId !== newId && newId in current.providers) {
		throw new Error(`Provider "${newId}" already exists.`);
	}
	if (originalId !== undefined && !(originalId in current.providers)) {
		throw new Error(`Provider "${originalId}" no longer exists.`);
	}
	if (originalId !== undefined && originalId !== newId) delete current.providers[originalId];
	current.providers[newId] = structuredClone(entry);
	await writeModelsJson(current);
}

export async function removeProvider(id: string): Promise<boolean> {
	const current = await readModelsJson();
	if (!(id in current.providers)) return false;
	delete current.providers[id];
	await writeModelsJson(current);
	return true;
}

async function writeTextAtomically(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	let mode = 0o600;
	try {
		mode = (await stat(path)).mode;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`Failed to inspect ${path}: ${formatError(error)}`);
		}
	}

	const temporaryPath = join(
		dirname(path),
		`.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
	);
	try {
		await writeFile(temporaryPath, content, { encoding: "utf8", mode });
		await rename(temporaryPath, path);
	} catch (error) {
		try {
			await unlink(temporaryPath);
		} catch {
			// Best-effort cleanup; retain the original write error.
		}
		throw new Error(`Failed to write ${path}: ${formatError(error)}`);
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

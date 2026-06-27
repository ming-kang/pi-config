import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { advisorConfigPath } from "../shared/paths.ts";
import { THINKING_LEVELS } from "./constants.ts";

const CONFIG_PATH = advisorConfigPath();
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

export interface AdvisorConfig {
	modelKey?: string;
	effort?: ThinkingLevel;
	guidance?: {
		promptSnippet?: string;
		promptGuidelines?: string[];
	};
}

interface LegacyAdvisorConfig {
	enabled?: boolean;
	model?: string;
}

export function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export function parseModelKey(value: string | undefined): { provider: string; modelId: string } | undefined {
	if (!value) return undefined;
	const separator = value.includes("/") ? "/" : value.includes(":") ? ":" : undefined;
	if (!separator) return undefined;
	const [provider, ...rest] = value.split(separator);
	const modelId = rest.join(separator);
	if (!provider || !modelId) return undefined;
	return { provider, modelId };
}

/**
 * Resolve a "provider/model" key to an *authenticated* model.
 *
 * Unlike `modelRegistry.find()` (which returns any known model, even one with no
 * auth configured), this checks `getAvailable()`. A configured-but-unauthenticated
 * model is therefore treated as unavailable instead of being silently activated
 * (which would make every advisor call fail at getApiKeyAndHeaders). Shared by the
 * /advisor command and session restore so both apply the same auth gate.
 */
export function findAvailableModel(ctx: ExtensionContext, key: string): Model<Api> | undefined {
	const parsed = parseModelKey(key);
	if (!parsed) return undefined;
	return ctx.modelRegistry
		.getAvailable()
		.find((model) => model.provider === parsed.provider && model.id === parsed.modelId);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVEL_SET.has(value);
}

function normalizeConfig(raw: unknown): AdvisorConfig {
	if (!raw || typeof raw !== "object") return {};
	const record = raw as LegacyAdvisorConfig & Partial<AdvisorConfig>;

	if ("enabled" in record || "model" in record) {
		if (record.enabled === false) return {};
		const parsed = parseModelKey(record.model);
		return {
			...(parsed ? { modelKey: `${parsed.provider}/${parsed.modelId}` } : {}),
		};
	}

	const parsed = parseModelKey(record.modelKey);
	return {
		...(parsed ? { modelKey: `${parsed.provider}/${parsed.modelId}` } : {}),
		...(isThinkingLevel(record.effort) ? { effort: record.effort } : {}),
		...(isGuidance(record.guidance) ? { guidance: record.guidance } : {}),
	};
}

function isGuidance(value: unknown): value is AdvisorConfig["guidance"] {
	if (!value || typeof value !== "object") return false;
	const guidance = value as Record<string, unknown>;
	if (guidance.promptSnippet !== undefined && typeof guidance.promptSnippet !== "string") return false;
	if (
		guidance.promptGuidelines !== undefined &&
		(!Array.isArray(guidance.promptGuidelines) ||
			!guidance.promptGuidelines.every((item) => typeof item === "string"))
	) {
		return false;
	}
	return true;
}

export function loadAdvisorConfig(): AdvisorConfig {
	if (!existsSync(CONFIG_PATH)) return {};
	try {
		return normalizeConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
	} catch {
		return {};
	}
}

export function saveAdvisorConfig(config: AdvisorConfig): boolean {
	try {
		const normalized = normalizeConfig(config);
		mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2) + "\n", "utf8");
		return true;
	} catch {
		return false;
	}
}

export function restoreAdvisorConfig(): AdvisorConfig {
	const config = loadAdvisorConfig();
	if (existsSync(CONFIG_PATH)) saveAdvisorConfig(config);
	return config;
}

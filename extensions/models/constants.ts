/**
 * models — constants
 *
 * All user-visible strings, default values, and API choice lists live here.
 * Keeping them out of `index.ts` and `*.dialog.ts` so the routing and UI
 * files stay focused on control flow and rendering.
 */

import type { Api } from "@earendil-works/pi-ai";

// ============================================================================
// Commands
// ============================================================================

export const COMMAND_NAME = "models";

export const COMMAND_DESCRIPTION =
	"Manage custom model providers in ~/.pi/agent/models.json (Pi-native menu, no JSON editing)";

export const SUBCOMMANDS = ["add", "list", "edit", "remove", "reload", "probe"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export function parseArgs(args: string): { subcommand: Subcommand | undefined; target: string | undefined } {
	const trimmed = args.trim();
	if (!trimmed) return { subcommand: undefined, target: undefined };
	const parts = trimmed.split(/\s+/);
	const first = parts[0];
	const target = parts.slice(1).join(" ") || undefined;
	const subcommand = (SUBCOMMANDS as readonly string[]).includes(first) ? (first as Subcommand) : undefined;
	return { subcommand, target };
}

// ============================================================================
// API choices (mirrors models.json: `api` field)
// ============================================================================

export interface ApiChoice {
	value: Api;
	label: string;
	description: string;
	baseUrlPlaceholder: string;
}

export const API_CHOICES: readonly ApiChoice[] = [
	{
		value: "openai-completions",
		label: "OpenAI-compatible",
		description: "OpenAI Chat Completions API and most compatibles (Ollama, LM Studio, vLLM, OpenRouter, …)",
		baseUrlPlaceholder: "http://localhost:11434/v1",
	},
	{
		value: "openai-responses",
		label: "OpenAI Responses",
		description: "OpenAI Responses API (newer endpoint, /v1/responses)",
		baseUrlPlaceholder: "https://api.openai.com/v1",
	},
	{
		value: "anthropic-messages",
		label: "Anthropic Messages",
		description: "Anthropic Messages API and compatibles (Claude proxies)",
		baseUrlPlaceholder: "https://api.anthropic.com",
	},
	{
		value: "google-generative-ai",
		label: "Google Generative AI",
		description: "Google Gemini / Gemma via the Generative Language API",
		baseUrlPlaceholder: "https://generativelanguage.googleapis.com/v1beta",
	},
] as const;

export function findApiChoice(api: string): ApiChoice | undefined {
	return API_CHOICES.find((c) => c.value === api);
}

// ============================================================================
// Defaults — match models.json docs (contextWindow=128000, maxTokens=16384)
// ============================================================================

export const DEFAULTS = {
	contextWindow: 128_000,
	maxTokens: 16_384,
	probeTimeoutMs: 5_000,
} as const;

// ============================================================================
// Validation
// ============================================================================

const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function isValidProviderId(id: string): boolean {
	return PROVIDER_ID_PATTERN.test(id) && id.length > 0 && id.length <= 64;
}

export function isValidUrl(url: string): boolean {
	if (!url) return false;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

export function isPositiveInteger(value: number): boolean {
	return Number.isInteger(value) && value > 0;
}

// ============================================================================
// Display formatters
// ============================================================================

/** Compact "name: value" list, e.g. "User-Agent: foo, x-bar: baz" */
export function formatHeaders(headers: Record<string, string> | undefined): string {
	if (!headers || Object.keys(headers).length === 0) return "(none)";
	const entries = Object.entries(headers);
	if (entries.length <= 2) return entries.map(([k, v]) => `${k}: ${v}`).join(", ");
	return `${entries.length} headers`;
}

/** "id (name)" or just "id" if name is missing or equal to id */
export function formatModelLine(model: { id: string; name?: string }): string {
	if (model.name && model.name !== model.id) return `${model.id} — ${model.name}`;
	return model.id;
}

export function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, Math.max(0, max - 1))}…`;
}

// ============================================================================
// UI hints
// ============================================================================

export const HINTS = {
	menu: "↑↓ navigate · Enter open · Esc back",
	form: "↑↓ navigate · Enter/Space change · Esc cancel",
	formUnsaved: "↑↓ navigate · Enter/Space change · Ctrl+S save · Esc cancel (discards changes)",
	probeCheck: "Space toggle · Enter add selected · Esc cancel",
} as const;

export const NO_UI_WARNING = "/models requires an interactive UI.";
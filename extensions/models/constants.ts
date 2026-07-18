export const COMMAND_NAME = "models";
export const COMMAND_DESCRIPTION = "Edit and reload ~/.pi/agent/models.json";

export const SUBCOMMANDS = ["add", "list", "edit", "remove", "reload", "probe"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export interface ParsedArgs {
	subcommand?: Subcommand;
	target?: string;
	invalidSubcommand?: string;
}

export function parseArgs(args: string): ParsedArgs {
	const trimmed = args.trim();
	if (!trimmed) return {};
	const [rawSubcommand = "", ...rest] = trimmed.split(/\s+/);
	const normalized = rawSubcommand.toLowerCase();
	if (!(SUBCOMMANDS as readonly string[]).includes(normalized)) {
		return { invalidSubcommand: rawSubcommand };
	}
	return {
		subcommand: normalized as Subcommand,
		target: rest.length > 0 ? rest.join(" ") : undefined,
	};
}

export const DEFAULTS = {
	contextWindow: 128_000,
	maxTokens: 16_384,
	probeTimeoutMs: 10_000,
	probeBodyBytes: 4 * 1024 * 1024,
	probeMaxModels: 2_000,
} as const;

export const API_CHOICES = [
	{ value: "openai-completions", label: "OpenAI Chat Completions" },
	{ value: "openai-responses", label: "OpenAI Responses" },
	{ value: "anthropic-messages", label: "Anthropic Messages" },
	{ value: "google-generative-ai", label: "Google Generative AI" },
] as const;

const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function isValidProviderId(id: string): boolean {
	return PROVIDER_ID_PATTERN.test(id) && id.length <= 64;
}

export function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export const NO_UI_WARNING = "/models requires an interactive UI.";

export const COMMAND_NAME = "models";
export const COMMAND_DESCRIPTION = "Manage model providers";

/** Canonical user-facing subcommands. `probe` remains a parse-only legacy alias for `fetch`. */
export const SUBCOMMANDS = ["add", "list", "edit", "remove", "reload", "fetch"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export interface ParsedArgs {
	subcommand?: Subcommand;
	target?: string;
	providerRef?: string;
}

export function parseArgs(args: string): ParsedArgs {
	const trimmed = args.trim();
	if (!trimmed) return {};
	const [rawSubcommand = "", ...rest] = trimmed.split(/\s+/);
	const normalized = rawSubcommand.toLowerCase();
	const canonical = normalized === "probe" ? "fetch" : normalized;
	if (!(SUBCOMMANDS as readonly string[]).includes(canonical)) {
		return { providerRef: trimmed };
	}
	return {
		subcommand: canonical as Subcommand,
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

export function isValidProviderId(id: string): boolean {
	// Pi's models.json schema accepts arbitrary object keys. Slash is the one
	// practical exception: Pi parses model references as provider/model.
	return Boolean(id) && !id.includes("/") && !/[\u0000-\u001f\u007f]/.test(id);
}

export function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export const NO_UI_WARNING = "/models requires an interactive UI.";

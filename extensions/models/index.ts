/**
 * models — direct models.json editing with safe reload and optional probing.
 *
 * The extension intentionally leaves the models.json schema to Pi. It adds a
 * small provider menu, Pi's native multiline JSON editor, atomic persistence,
 * and exact rollback when ModelRegistry rejects a change.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	COMMAND_DESCRIPTION,
	COMMAND_NAME,
	NO_UI_WARNING,
	SUBCOMMANDS,
	isValidProviderId,
	parseArgs,
	truncate,
} from "./constants.ts";
import { createProbeChecklist } from "./dialog.ts";
import { probeModels } from "./probe.ts";
import {
	captureModelsJsonSnapshot,
	getProvider,
	listProviderIds,
	listProviders,
	parseModelsJsonText,
	removeProvider,
	restoreModelsJsonSnapshot,
	saveProvider,
	stripJsonComments,
	type ProviderEntry,
	writeModelsJsonText,
} from "./store.ts";

export default function modelsExtension(pi: ExtensionAPI) {
	pi.registerCommand(COMMAND_NAME, {
		description: COMMAND_DESCRIPTION,
		getArgumentCompletions: async (prefix) => completeArguments(prefix),
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(NO_UI_WARNING, "warning");
				return;
			}
			try {
				await dispatch(args, ctx);
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			}
		},
	});
}

async function completeArguments(prefix: string) {
	const match = prefix.match(/^(\S*)(?:\s+(.*))?$/);
	const first = (match?.[1] ?? "").toLowerCase();
	const rest = match?.[2];
	if (rest === undefined) {
		const matches = SUBCOMMANDS.filter((subcommand) => subcommand.startsWith(first));
		return matches.length > 0
			? matches.map((value) => ({ value, label: value, description: commandDescription(value) }))
			: null;
	}
	if (first !== "edit" && first !== "remove" && first !== "probe") return null;
	try {
		const ids = (await listProviderIds()).filter((id) => id.startsWith(rest));
		return ids.length > 0
			? ids.map((id) => ({ value: `${first} ${id}`, label: id, description: `${first} provider ${id}` }))
			: null;
	} catch {
		return null;
	}
}

async function dispatch(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = parseArgs(args);
	if (parsed.invalidSubcommand) {
		ctx.ui.notify(
			`Unknown /${COMMAND_NAME} subcommand: ${parsed.invalidSubcommand}. Use ${SUBCOMMANDS.join(" | ")}.`,
			"warning",
		);
		return;
	}
	if (!parsed.subcommand || parsed.subcommand === "list") {
		if (parsed.target) return notifyUsage(ctx, "list");
		await openProvidersMenu(ctx);
		return;
	}
	if (parsed.subcommand === "file") {
		if (parsed.target) return notifyUsage(ctx, "file");
		await editCompleteModelsFile(ctx);
		return;
	}
	if (parsed.subcommand === "add") {
		if (parsed.target) return notifyUsage(ctx, "add");
		await addProvider(ctx);
		return;
	}
	if (parsed.subcommand === "reload") {
		if (parsed.target) return notifyUsage(ctx, "reload");
		await reloadModels(ctx);
		return;
	}
	if (!parsed.target) return notifyUsage(ctx, parsed.subcommand);
	if (parsed.subcommand === "edit") await editProviderJson(parsed.target, ctx);
	if (parsed.subcommand === "remove") await confirmAndRemove(parsed.target, ctx);
	if (parsed.subcommand === "probe") await probeFlow(parsed.target, ctx);
}

async function openProvidersMenu(ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const providers = await listProviders();
		const menu = [
			{ kind: "file" as const, label: "Edit complete models.json" },
			{ kind: "add" as const, label: "+ Add provider from a starter JSON" },
			...providers.map((provider) => ({
				kind: "provider" as const,
				label: formatProviderMenuLine(provider.id, provider.entry),
				providerId: provider.id,
			})),
			{ kind: "reload" as const, label: "Reload models.json" },
			{ kind: "close" as const, label: "Close" },
		];
		const selected = await ctx.ui.select(
			"Models · ~/.pi/agent/models.json",
			menu.map((item) => item.label),
		);
		if (selected === undefined) return;
		const item = menu.find((candidate) => candidate.label === selected);
		if (!item || item.kind === "close") return;
		if (item.kind === "file") await editCompleteModelsFile(ctx);
		if (item.kind === "add") await addProvider(ctx);
		if (item.kind === "reload") await reloadModels(ctx);
		if (item.kind === "provider") await openProviderActions(item.providerId, ctx);
	}
}

async function openProviderActions(providerId: string, ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		if (!(await getProvider(providerId))) {
			ctx.ui.notify(`Provider "${providerId}" no longer exists.`, "warning");
			return;
		}
		const action = await ctx.ui.select(providerId, [
			"Edit provider JSON",
			"Rename provider key",
			"Probe remote model catalog",
			"Remove provider",
			"Back",
		]);
		if (action === undefined || action === "Back") return;
		if (action === "Edit provider JSON") await editProviderJson(providerId, ctx);
		if (action === "Probe remote model catalog") await probeFlow(providerId, ctx);
		if (action === "Remove provider" && (await confirmAndRemove(providerId, ctx))) return;
		if (action === "Rename provider key") {
			const renamed = await renameProvider(providerId, ctx);
			if (renamed && renamed !== providerId) return;
		}
	}
}

async function editCompleteModelsFile(ctx: ExtensionCommandContext): Promise<boolean> {
	const snapshot = await captureModelsJsonSnapshot();
	let draft = snapshot.exists ? (snapshot.content ?? "") : '{\n  "providers": {}\n}\n';
	while (true) {
		const edited = await ctx.ui.editor("~/.pi/agent/models.json", draft);
		if (edited === undefined) return false;
		draft = edited;
		if (!draft.trim()) {
			ctx.ui.notify("models.json cannot be empty.", "error");
			continue;
		}
		try {
			parseModelsJsonText(draft);
		} catch (error) {
			ctx.ui.notify(formatError(error), "error");
			continue;
		}
		return commitModelsChange(
			ctx,
			() => writeModelsJsonText(draft),
			"Saved models.json and reloaded the model registry.",
		);
	}
}

async function addProvider(ctx: ExtensionCommandContext): Promise<string | undefined> {
	let providerId: string;
	while (true) {
		const input = await ctx.ui.input("New provider ID", "my-provider");
		if (input === undefined) return undefined;
		providerId = input.trim();
		if (!isValidProviderId(providerId)) {
			ctx.ui.notify("Use 1–64 letters, digits, _ or - for the provider ID.", "error");
			continue;
		}
		if ((await listProviderIds()).includes(providerId)) {
			ctx.ui.notify(`Provider "${providerId}" already exists.`, "error");
			continue;
		}
		break;
	}

	const starter = await ctx.ui.select("Provider starter", [
		"OpenAI-compatible local server",
		"Anthropic-compatible proxy",
		"Google AI Studio",
		"Built-in provider override",
	]);
	if (starter === undefined) return undefined;
	const entry = providerStarter(starter);
	return (await editProviderJson(providerId, ctx, entry, true)) ? providerId : undefined;
}

async function editProviderJson(
	providerId: string,
	ctx: ExtensionCommandContext,
	initialEntry?: ProviderEntry,
	isNew = false,
): Promise<boolean> {
	const entry = initialEntry ?? (await getProvider(providerId));
	if (!entry) {
		ctx.ui.notify(`Provider "${providerId}" was not found in models.json.`, "warning");
		return false;
	}
	let draft = JSON.stringify(entry, null, 2);
	while (true) {
		const edited = await ctx.ui.editor(`Provider JSON · ${providerId}`, draft);
		if (edited === undefined) return false;
		draft = edited;
		let parsed: unknown;
		try {
			parsed = JSON.parse(stripJsonComments(draft));
		} catch (error) {
			ctx.ui.notify(`Invalid provider JSON: ${formatError(error)}`, "error");
			continue;
		}
		if (!isRecord(parsed)) {
			ctx.ui.notify("A provider entry must be a JSON object.", "error");
			continue;
		}
		return commitModelsChange(
			ctx,
			() => saveProvider(isNew ? undefined : providerId, providerId, parsed as ProviderEntry),
			`Saved provider "${providerId}" and reloaded the model registry.`,
		);
	}
}

async function renameProvider(providerId: string, ctx: ExtensionCommandContext): Promise<string | undefined> {
	const entry = await getProvider(providerId);
	if (!entry) {
		ctx.ui.notify(`Provider "${providerId}" was not found in models.json.`, "warning");
		return undefined;
	}
	const edited = await ctx.ui.editor("New provider ID", providerId);
	if (edited === undefined) return undefined;
	const newId = edited.trim();
	if (!isValidProviderId(newId)) {
		ctx.ui.notify("Use 1–64 letters, digits, _ or - for the provider ID.", "error");
		return undefined;
	}
	if (newId !== providerId && (await listProviderIds()).includes(newId)) {
		ctx.ui.notify(`Provider "${newId}" already exists.`, "error");
		return undefined;
	}
	if (newId === providerId) return providerId;
	const saved = await commitModelsChange(
		ctx,
		() => saveProvider(providerId, newId, entry),
		`Renamed provider "${providerId}" to "${newId}".`,
	);
	return saved ? newId : undefined;
}

async function confirmAndRemove(providerId: string, ctx: ExtensionCommandContext): Promise<boolean> {
	if (!(await getProvider(providerId))) {
		ctx.ui.notify(`Provider "${providerId}" was not found in models.json.`, "warning");
		return false;
	}
	if (
		!(await ctx.ui.confirm(
			`Remove "${providerId}"?`,
			"This removes only its models.json entry. Built-in provider defaults remain available.",
		))
	) {
		return false;
	}
	return commitModelsChange(
		ctx,
		async () => {
			if (!(await removeProvider(providerId))) throw new Error(`Provider "${providerId}" no longer exists.`);
		},
		`Removed provider "${providerId}" and reloaded the model registry.`,
	);
}

async function reloadModels(ctx: ExtensionCommandContext): Promise<void> {
	await ctx.modelRegistry.refresh();
	const error = ctx.modelRegistry.getError();
	if (error) ctx.ui.notify(`models.json reload failed:\n${truncate(error, 1_500)}`, "error");
	else ctx.ui.notify("Reloaded ~/.pi/agent/models.json.", "info");
}

async function probeFlow(providerId: string, ctx: ExtensionCommandContext): Promise<void> {
	const entry = await getProvider(providerId);
	if (!entry) {
		ctx.ui.notify(`Provider "${providerId}" was not found in models.json.`, "warning");
		return;
	}

	const inheritedModel = ctx.modelRegistry.getAll().find((model) => model.provider === providerId);
	const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl : inheritedModel?.baseUrl;
	const api = typeof entry.api === "string" ? entry.api : inheritedModel?.api;
	if (!baseUrl || !api) {
		ctx.ui.notify("Probe requires an effective base URL and API.", "warning");
		return;
	}

	let resolvedApiKey: string | undefined;
	let resolvedHeaders: Record<string, string> | undefined;
	try {
		if (inheritedModel) {
			const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(inheritedModel);
			if (!resolved.ok) throw new Error(resolved.error);
			resolvedApiKey = resolved.apiKey;
			resolvedHeaders = resolved.headers;
		} else {
			resolvedApiKey = await ctx.modelRegistry.getApiKeyForProvider(providerId);
		}
	} catch (error) {
		ctx.ui.notify(`Could not resolve provider auth for probing: ${formatError(error)}`, "error");
		return;
	}
	const headers = { ...literalHeaders(entry.headers), ...resolvedHeaders };
	const apiKey = resolvedApiKey ?? literalConfigValue(entry.apiKey);

	ctx.ui.notify(`Probing ${baseUrl} …`, "info");
	const result = await probeModels({ baseUrl, api: String(api), apiKey, headers });
	if (!result.ok) {
		ctx.ui.notify(`Probe failed: ${result.error}`, "error");
		return;
	}
	if (result.models.length === 0) {
		ctx.ui.notify("The provider returned an empty model catalog.", "info");
		return;
	}

	const existingIds = new Set(Array.isArray(entry.models) ? entry.models.map((model) => model.id) : []);
	const newModels = result.models.filter((model) => !existingIds.has(model.id));
	if (newModels.length === 0) {
		ctx.ui.notify(`All ${result.models.length} probed models are already configured.`, "info");
		return;
	}
	if (result.truncated) {
		ctx.ui.notify("The catalog exceeded the 2,000-model probe limit; additional entries were omitted.", "warning");
	}

	const choice = await ctx.ui.custom(createProbeChecklist(providerId, newModels));
	if (choice.kind === "cancel" || choice.selectedIds.length === 0) return;
	const latest = await getProvider(providerId);
	if (!latest) {
		ctx.ui.notify(`Provider "${providerId}" was removed while probing.`, "error");
		return;
	}
	if (latest.models !== undefined && !Array.isArray(latest.models)) {
		ctx.ui.notify("The provider's models field is not an array; repair it before adding probe results.", "error");
		return;
	}
	const latestIds = new Set((latest.models ?? []).map((model) => model.id));
	const selected = new Set(choice.selectedIds);
	const additions = newModels
		.filter((model) => selected.has(model.id) && !latestIds.has(model.id))
		.map((model) => (model.name && model.name !== model.id ? { id: model.id, name: model.name } : { id: model.id }));
	if (additions.length === 0) return;
	latest.models = [...(latest.models ?? []), ...additions];
	await commitModelsChange(
		ctx,
		() => saveProvider(providerId, providerId, latest),
		`Added ${additions.length} model${additions.length === 1 ? "" : "s"} to "${providerId}".`,
	);
}

async function commitModelsChange(
	ctx: ExtensionCommandContext,
	mutate: () => Promise<void>,
	successMessage: string,
): Promise<boolean> {
	const snapshot = await captureModelsJsonSnapshot();
	try {
		await mutate();
		await ctx.modelRegistry.refresh();
		const registryError = ctx.modelRegistry.getError();
		if (registryError) throw new Error(`Pi rejected the updated models.json:\n${registryError}`);
		ctx.ui.notify(successMessage, "info");
		return true;
	} catch (error) {
		let rollbackError: unknown;
		try {
			await restoreModelsJsonSnapshot(snapshot);
			await ctx.modelRegistry.refresh();
		} catch (caught) {
			rollbackError = caught;
		}
		const message = rollbackError
			? `Change failed: ${formatError(error)}\nRollback also failed: ${formatError(rollbackError)}`
			: `Change failed and was rolled back: ${formatError(error)}`;
		ctx.ui.notify(truncate(message, 2_000), "error");
		return false;
	}
}

function providerStarter(starter: string): ProviderEntry {
	if (starter === "Anthropic-compatible proxy") {
		return {
			baseUrl: "https://api.anthropic.com",
			api: "anthropic-messages",
			apiKey: "$ANTHROPIC_API_KEY",
			models: [{ id: "model-id" }],
		};
	}
	if (starter === "Google AI Studio") {
		return {
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			api: "google-generative-ai",
			apiKey: "$GEMINI_API_KEY",
			models: [{ id: "model-id" }],
		};
	}
	if (starter === "Built-in provider override") return { baseUrl: "https://proxy.example.com/v1" };
	return {
		baseUrl: "http://localhost:11434/v1",
		api: "openai-completions",
		apiKey: "ollama",
		models: [{ id: "model-id" }],
	};
}

function formatProviderMenuLine(id: string, entry: ProviderEntry): string {
	const models = Array.isArray(entry.models) ? entry.models.length : 0;
	const api = typeof entry.api === "string" ? entry.api : "inherit";
	const url = typeof entry.baseUrl === "string" ? truncate(entry.baseUrl, 48) : "built-in/default URL";
	return `${id} — ${api} · ${models} custom model${models === 1 ? "" : "s"} · ${url}`;
}

function literalConfigValue(value: unknown): string | undefined {
	return typeof value === "string" && !value.startsWith("!") && !value.includes("$") ? value : undefined;
}

function literalHeaders(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === "string" && !entry[1].startsWith("!") && !entry[1].includes("$"),
		),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notifyUsage(ctx: ExtensionCommandContext, subcommand: string): void {
	const target = subcommand === "edit" || subcommand === "remove" || subcommand === "probe" ? " <provider-id>" : "";
	ctx.ui.notify(`Usage: /${COMMAND_NAME} ${subcommand}${target}`, "warning");
}

function commandDescription(subcommand: string): string {
	switch (subcommand) {
		case "file":
			return "Edit the complete models.json";
		case "add":
			return "Add a provider from a starter JSON";
		case "list":
			return "Open the provider menu";
		case "edit":
			return "Edit one provider JSON object";
		case "remove":
			return "Remove a provider";
		case "reload":
			return "Reload models.json";
		case "probe":
			return "Probe a provider's model catalog";
		default:
			return "";
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

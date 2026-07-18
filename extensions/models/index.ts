/**
 * models — structured provider/model management for ~/.pi/agent/models.json.
 *
 * /models is the primary interface: provider list → provider actions → field
 * editor / model discovery. Drafts are saved atomically and rolled back when
 * Pi rejects the resulting registry configuration.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	COMMAND_DESCRIPTION,
	COMMAND_NAME,
	NO_UI_WARNING,
	SUBCOMMANDS,
	parseArgs,
	truncate,
} from "./constants.ts";
import { createProbeChecklist } from "./dialog.ts";
import { editProvider, type SaveAttempt } from "./editor.ts";
import { probeModels } from "./probe.ts";
import {
	captureModelsJsonSnapshot,
	getProvider,
	listProviderIds,
	listProviders,
	removeProvider,
	restoreModelsJsonSnapshot,
	saveProvider,
	type ProviderEntry,
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
		return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
	}
	if (first !== "edit" && first !== "remove" && first !== "probe") return null;
	try {
		const ids = (await listProviderIds()).filter((id) => id.startsWith(rest));
		return ids.length > 0 ? ids.map((id) => ({ value: `${first} ${id}`, label: id })) : null;
	} catch {
		return null;
	}
}

async function dispatch(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = parseArgs(args);
	if (parsed.invalidSubcommand) {
		ctx.ui.notify(`Unknown /models subcommand: ${parsed.invalidSubcommand}.`, "warning");
		return;
	}
	if (!parsed.subcommand || parsed.subcommand === "list") {
		if (parsed.target) return notifyUsage(ctx, "list");
		await openProvidersMenu(ctx);
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
	if (parsed.subcommand === "edit") await editExistingProvider(parsed.target, ctx);
	if (parsed.subcommand === "remove") await confirmAndRemove(parsed.target, ctx);
	if (parsed.subcommand === "probe") await probeFlow(parsed.target, ctx);
}

async function openProvidersMenu(ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const providers = await listProviders();
		const menu = [
			...providers.map((provider) => ({
				kind: "provider" as const,
				label: formatProviderLine(provider.id, provider.entry),
				providerId: provider.id,
			})),
			{ kind: "add" as const, label: "+ Add provider" },
			{ kind: "reload" as const, label: "Reload models.json" },
			{ kind: "close" as const, label: "Close" },
		];
		const selected = await ctx.ui.select(
			"Model providers · ~/.pi/agent/models.json",
			menu.map((item) => item.label),
		);
		if (selected === undefined) return;
		const item = menu.find((candidate) => candidate.label === selected);
		if (!item || item.kind === "close") return;
		if (item.kind === "add") await addProvider(ctx);
		if (item.kind === "reload") await reloadModels(ctx);
		if (item.kind === "provider") await openProviderActions(item.providerId, ctx);
	}
}

async function openProviderActions(providerId: string, ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const entry = await getProvider(providerId);
		if (!entry) {
			ctx.ui.notify(`Provider "${providerId}" no longer exists.`, "warning");
			return;
		}
		const action = await ctx.ui.select(providerId, [
			"Configure provider and models",
			"Fetch remote model list",
			"Remove provider",
			"Back",
		]);
		if (action === undefined || action === "Back") return;
		if (action === "Configure provider and models") {
			const savedId = await editExistingProvider(providerId, ctx);
			if (savedId && savedId !== providerId) return;
		}
		if (action === "Fetch remote model list") await probeFlow(providerId, ctx);
		if (action === "Remove provider" && (await confirmAndRemove(providerId, ctx))) return;
	}
}

async function addProvider(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const result = await editProvider(ctx, {
		mode: "add",
		initialId: "",
		initialEntry: { api: "openai-completions", models: [] },
		existingIds: await listProviderIds(),
		onSave: (id, entry) =>
			commitModelsChange(
				ctx,
				() => saveProvider(undefined, id, entry),
				`Saved provider "${id}" and reloaded the model registry.`,
			),
	});
	return result.kind === "saved" ? result.id : undefined;
}

async function editExistingProvider(
	providerId: string,
	ctx: ExtensionCommandContext,
): Promise<string | undefined> {
	const entry = await getProvider(providerId);
	if (!entry) {
		ctx.ui.notify(`Provider "${providerId}" was not found in models.json.`, "warning");
		return undefined;
	}
	const result = await editProvider(ctx, {
		mode: "edit",
		initialId: providerId,
		initialEntry: entry,
		existingIds: await listProviderIds(),
		onSave: (id, updated) =>
			commitModelsChange(
				ctx,
				() => saveProvider(providerId, id, updated),
				`Saved provider "${id}" and reloaded the model registry.`,
			),
	});
	return result.kind === "saved" ? result.id : undefined;
}

async function confirmAndRemove(providerId: string, ctx: ExtensionCommandContext): Promise<boolean> {
	if (!(await getProvider(providerId))) {
		ctx.ui.notify(`Provider "${providerId}" was not found in models.json.`, "warning");
		return false;
	}
	if (!(await ctx.ui.confirm(`Remove "${providerId}"?`, "This removes its models.json entry."))) return false;
	const result = await commitModelsChange(
		ctx,
		async () => {
			if (!(await removeProvider(providerId))) throw new Error(`Provider "${providerId}" no longer exists.`);
		},
		`Removed provider "${providerId}".`,
	);
	if (!result.ok) ctx.ui.notify(result.error ?? "Provider could not be removed.", "error");
	return result.ok;
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
		ctx.ui.notify("Configure an effective base URL and API before fetching models.", "warning");
		return;
	}

	let apiKey: string | undefined;
	let resolvedHeaders: Record<string, string> | undefined;
	try {
		if (inheritedModel) {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(inheritedModel);
			if (!auth.ok) throw new Error(auth.error);
			apiKey = auth.apiKey;
			resolvedHeaders = auth.headers;
		} else {
			apiKey = await ctx.modelRegistry.getApiKeyForProvider(providerId);
		}
	} catch (error) {
		ctx.ui.notify(`Could not resolve provider authentication: ${formatError(error)}`, "error");
		return;
	}

	ctx.ui.notify(`Fetching models from ${baseUrl} …`, "info");
	const result = await probeModels({
		baseUrl,
		api: String(api),
		apiKey: apiKey ?? literalConfigValue(entry.apiKey),
		headers: { ...literalHeaders(entry.headers), ...resolvedHeaders },
	});
	if (!result.ok) {
		ctx.ui.notify(`Model fetch failed: ${result.error}`, "error");
		return;
	}
	const existing = new Set(Array.isArray(entry.models) ? entry.models.map((model) => model.id) : []);
	const available = result.models.filter((model) => !existing.has(model.id));
	if (available.length === 0) {
		ctx.ui.notify("All fetched models are already configured.", "info");
		return;
	}
	if (result.truncated) ctx.ui.notify("The remote catalog exceeded the 2,000-model limit and was truncated.", "warning");

	const choice = await ctx.ui.custom(createProbeChecklist(providerId, available));
	if (choice.kind === "cancel" || choice.selectedIds.length === 0) return;
	const latest = await getProvider(providerId);
	if (!latest || (latest.models !== undefined && !Array.isArray(latest.models))) {
		ctx.ui.notify("Provider models changed while the catalog was open; reopen the provider and try again.", "error");
		return;
	}
	const latestIds = new Set((latest.models ?? []).map((model) => model.id));
	const selected = new Set(choice.selectedIds);
	const additions = available
		.filter((model) => selected.has(model.id) && !latestIds.has(model.id))
		.map((model) => (model.name && model.name !== model.id ? { id: model.id, name: model.name } : { id: model.id }));
	if (additions.length === 0) return;
	latest.models = [...(latest.models ?? []), ...additions];
	const saved = await commitModelsChange(
		ctx,
		() => saveProvider(providerId, providerId, latest),
		`Added ${additions.length} model${additions.length === 1 ? "" : "s"} to "${providerId}".`,
	);
	if (!saved.ok) ctx.ui.notify(saved.error ?? "Fetched models could not be saved.", "error");
}

async function commitModelsChange(
	ctx: ExtensionCommandContext,
	mutate: () => Promise<void>,
	successMessage: string,
): Promise<SaveAttempt> {
	const snapshot = await captureModelsJsonSnapshot();
	try {
		await mutate();
		await ctx.modelRegistry.refresh();
		const registryError = ctx.modelRegistry.getError();
		if (registryError) throw new Error(`Pi rejected the updated models.json:\n${registryError}`);
		ctx.ui.notify(successMessage, "info");
		return { ok: true };
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
		return { ok: false, error: truncate(message, 2_000) };
	}
}

function formatProviderLine(id: string, entry: ProviderEntry): string {
	const models = Array.isArray(entry.models) ? entry.models.length : 0;
	const api = typeof entry.api === "string" ? entry.api : "inherit";
	const url = typeof entry.baseUrl === "string" ? truncate(entry.baseUrl, 48) : "built-in/default URL";
	return `${id} — ${api} · ${models} model${models === 1 ? "" : "s"} · ${url}`;
}

function literalConfigValue(value: unknown): string | undefined {
	return typeof value === "string" && !value.startsWith("!") && !value.includes("$") ? value : undefined;
}

function literalHeaders(value: unknown): Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === "string" && !entry[1].startsWith("!") && !entry[1].includes("$"),
		),
	);
}

function notifyUsage(ctx: ExtensionCommandContext, subcommand: string): void {
	const target = subcommand === "edit" || subcommand === "remove" || subcommand === "probe" ? " <provider-id>" : "";
	ctx.ui.notify(`Usage: /${COMMAND_NAME} ${subcommand}${target}`, "warning");
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

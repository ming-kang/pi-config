/**
 * models — structured provider/model management for ~/.pi/agent/models.json.
 *
 * /models is the primary interface: provider list → focused workspace → model
 * discovery. Drafts are saved atomically and rolled back when Pi rejects the
 * resulting registry configuration.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";
import {
	COMMAND_DESCRIPTION,
	COMMAND_NAME,
	NO_UI_WARNING,
	SUBCOMMANDS,
	parseArgs,
	truncate,
} from "./constants.ts";
import { createProbeChecklist, createSearchableSelector } from "./dialog.ts";
import { createProviderSetup, editProvider, type SaveAttempt } from "./editor.ts";
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

const SUBCOMMAND_DESCRIPTIONS: Record<(typeof SUBCOMMANDS)[number], string> = {
	add: "Create a provider",
	list: "Browse providers",
	edit: "Edit a provider",
	remove: "Remove a provider",
	reload: "Reload models.json",
	probe: "Fetch remote models",
};

const PROVIDER_SELECTOR_SEARCH_THRESHOLD = 12;

async function completeArguments(prefix: string): Promise<AutocompleteItem[] | null> {
	const match = prefix.match(/^(\S*)(?:\s+(.*))?$/);
	const first = (match?.[1] ?? "").toLowerCase();
	const rest = match?.[2];
	if (rest === undefined) {
		const commands = SUBCOMMANDS.filter((subcommand) => subcommand.startsWith(first)).map((value) => ({
			value,
			label: value,
			description: SUBCOMMAND_DESCRIPTIONS[value],
		}));
		try {
			const providers = fuzzyFilter(await listProviders(), first, providerSearchText).map(({ id, entry }) => ({
				value: id,
				label: id,
				description: formatProviderCompletionDescription(entry),
			}));
			const completions = [...commands, ...providers];
			return completions.length > 0 ? completions : null;
		} catch {
			return commands.length > 0 ? commands : null;
		}
	}
	if (first !== "edit" && first !== "remove" && first !== "probe") return null;
	try {
		const providers = fuzzyFilter(await listProviders(), rest, providerSearchText);
		return providers.length > 0
			? providers.map(({ id, entry }) => ({
					value: `${first} ${id}`,
					label: id,
					description: formatProviderCompletionDescription(entry),
				}))
			: null;
	} catch {
		return null;
	}
}

async function dispatch(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = parseArgs(args);
	if (parsed.providerRef) {
		await openProviderReference(parsed.providerRef, ctx);
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
	if (parsed.subcommand === "probe") {
		await probeFlow(parsed.target, ctx);
		await editExistingProvider(parsed.target, ctx, "models");
	}
}

async function openProviderReference(providerRef: string, ctx: ExtensionCommandContext): Promise<void> {
	const normalized = providerRef.trim().toLowerCase();
	const exact = (await listProviders()).filter(({ id }) => id.toLowerCase() === normalized);
	if (exact.length === 1) {
		await openProviderActions(exact[0]!.id, ctx);
		return;
	}
	await openProvidersMenu(ctx, providerRef);
}

async function openProvidersMenu(ctx: ExtensionCommandContext, initialQuery?: string): Promise<void> {
	let query = initialQuery;
	while (true) {
		const providers = await listProviders();
		const items = [
			...providers.map(({ id, entry }) => ({
				value: `provider:${id}`,
				label: id,
				description: formatProviderDescription(entry),
				searchText: providerSearchText({ id, entry }),
			})),
			{
				value: "action:add",
				label: "+ Add provider",
				description: "Create a new models.json provider",
				searchText: "add create new provider",
			},
			{
				value: "action:reload",
				label: "Reload models.json",
				description: "Refresh Pi's model registry",
				searchText: "reload refresh models json registry",
			},
		];
		const filteredItems = query ? fuzzyFilter(items, query, (item) => item.searchText) : items;
		const visibleItems = filteredItems.length > 0 ? filteredItems : items;
		const shouldUseSearch =
			ctx.mode === "tui" && (query !== undefined || items.length > PROVIDER_SELECTOR_SEARCH_THRESHOLD);
		const selected =
			shouldUseSearch
				? await ctx.ui.custom(
						createSearchableSelector({
							title: "Select model provider:",
							items,
							initialQuery: query,
							emptyMessage: "No matching providers or actions",
						}),
					)
				: await selectNativeItem(ctx, "Select model provider:", visibleItems);
		query = undefined;
		if (selected === undefined) return;
		if (selected === "action:add") await addProvider(ctx);
		else if (selected === "action:reload") await reloadModels(ctx);
		else if (selected.startsWith("provider:")) await openProviderActions(selected.slice("provider:".length), ctx);
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
			"Open workspace · models, connection, and advanced settings",
			"Remove provider",
			"Back",
		]);
		if (action === undefined || action === "Back") return;
		if (action === "Open workspace · models, connection, and advanced settings") {
			const savedId = await editExistingProvider(providerId, ctx);
			if (savedId && savedId !== providerId) return;
		}
		if (action === "Remove provider" && (await confirmAndRemove(providerId, ctx))) return;
	}
}

async function addProvider(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const draft = await createProviderSetup(ctx, await listProviderIds());
	if (!draft) return undefined;
	const saved = await commitModelsChange(
		ctx,
		() => saveProvider(undefined, draft.id, draft.entry),
		`Created provider "${draft.id}". Finding available models…`,
	);
	if (!saved.ok) {
		ctx.ui.notify(saved.error ?? "Provider could not be created.", "error");
		return undefined;
	}
	await probeFlow(draft.id, ctx);
	return (await editExistingProvider(draft.id, ctx, "models")) ?? draft.id;
}

async function editExistingProvider(
	providerId: string,
	ctx: ExtensionCommandContext,
	initialSection?: "models",
): Promise<string | undefined> {
	const entry = await getProvider(providerId);
	if (!entry) {
		ctx.ui.notify(`Provider "${providerId}" was not found in models.json.`, "warning");
		return undefined;
	}
	const result = await editProvider(ctx, {
		initialId: providerId,
		initialEntry: entry,
		existingIds: await listProviderIds(),
		initialSection,
		onSave: (originalId, id, updated) =>
			commitModelsChange(
				ctx,
				() => saveProvider(originalId, id, updated),
				`Saved provider "${id}" and reloaded the model registry.`,
			),
	});
	if (result.kind === "discover") {
		await probeFlow(result.id, ctx);
		return (await editExistingProvider(result.id, ctx, "models")) ?? result.id;
	}
	return result.id;
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
	while (true) {
		const entry = await getProvider(providerId);
		if (!entry) {
			ctx.ui.notify(`Provider "${providerId}" was not found in models.json.`, "warning");
			return;
		}
		const inheritedModel = ctx.modelRegistry.getAll().find((model) => model.provider === providerId);
		const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl : inheritedModel?.baseUrl;
		const api = typeof entry.api === "string" ? entry.api : inheritedModel?.api;
		if (!baseUrl || !api) {
			const action = await selectProbeFailureAction(ctx, "Configure an effective Base URL and API protocol before fetching models.");
			if (action === "edit") await editExistingProvider(providerId, ctx);
			if (action === "manual") await addManualModels(providerId, ctx);
			if (action === "retry") continue;
			return;
		}

		if (api === "anthropic-messages") {
			ctx.ui.notify("Anthropic Messages has no public model-list endpoint. Add model IDs manually.", "info");
			await addManualModels(providerId, ctx);
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
			const action = await selectProbeFailureAction(ctx, `Could not resolve provider authentication: ${formatError(error)}`);
			if (action === "edit") await editExistingProvider(providerId, ctx);
			if (action === "manual") await addManualModels(providerId, ctx);
			if (action === "retry") continue;
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
			const action = await selectProbeFailureAction(ctx, `Model fetch failed: ${result.error}`);
			if (action === "edit") await editExistingProvider(providerId, ctx);
			if (action === "manual") await addManualModels(providerId, ctx);
			if (action === "retry") continue;
			return;
		}
		const existing = new Set(Array.isArray(entry.models) ? entry.models.map((model) => model.id) : []);
		const available = result.models.filter((model) => !existing.has(model.id));
		if (available.length === 0) {
			ctx.ui.notify("The remote catalog has no models that are not already configured.", "info");
			return;
		}
		if (result.truncated) ctx.ui.notify("The remote catalog exceeded the 2,000-model limit and was truncated.", "warning");

		let selectedIds: string[];
		if (ctx.mode === "tui") {
			const choice = await ctx.ui.custom(createProbeChecklist(providerId, available));
			selectedIds = choice.kind === "save" ? choice.selectedIds : [];
		} else {
			selectedIds = (await ctx.ui.confirm(
				`Add ${available.length} fetched model${available.length === 1 ? "" : "s"}?`,
				"This UI can select individual models in the terminal; this mode adds the complete fetched set.",
			))
				? available.map((model) => model.id)
				: [];
		}
		if (selectedIds.length === 0) return;
		await appendModels(providerId, selectedIds, available, ctx);
		return;
	}
}

async function selectProbeFailureAction(
	ctx: ExtensionCommandContext,
	message: string,
): Promise<"retry" | "edit" | "manual" | "back" | undefined> {
	return selectNativeItem(ctx, message, [
		{ value: "retry", label: "Retry" },
		{ value: "edit", label: "Edit provider connection" },
		{ value: "manual", label: "Add model IDs manually" },
		{ value: "back", label: "Back" },
	]);
}

async function addManualModels(providerId: string, ctx: ExtensionCommandContext): Promise<void> {
	const entry = await getProvider(providerId);
	if (!entry || (entry.models !== undefined && !Array.isArray(entry.models))) {
		ctx.ui.notify("Provider models changed; reopen the provider and try again.", "error");
		return;
	}
	const existing = new Set((entry.models ?? []).map((model) => model.id));
	let value: string | undefined;
	while (true) {
		value = await ctx.ui.input("Model IDs · comma-separated", "model-a, model-b, model-c");
		if (value === undefined) return;
		const ids = parseManualModelIds(value);
		const duplicate = ids.find((id, index) => ids.indexOf(id) !== index || existing.has(id));
		if (ids.length === 0) {
			ctx.ui.notify("Enter at least one model ID.", "warning");
			continue;
		}
		if (duplicate) {
			ctx.ui.notify(`Model "${duplicate}" already exists in this provider.`, "warning");
			continue;
		}
		await appendModels(providerId, ids, ids.map((id) => ({ id })), ctx);
		return;
	}
}

async function appendModels(
	providerId: string,
	selectedIds: readonly string[],
	available: ReadonlyArray<{ id: string; name?: string }>,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const latest = await getProvider(providerId);
	if (!latest || (latest.models !== undefined && !Array.isArray(latest.models))) {
		ctx.ui.notify("Provider models changed while the catalog was open; reopen the provider and try again.", "error");
		return;
	}
	const latestIds = new Set((latest.models ?? []).map((model) => model.id));
	const selected = new Set(selectedIds);
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
	if (!saved.ok) ctx.ui.notify(saved.error ?? "Models could not be saved.", "error");
}

function parseManualModelIds(value: string): string[] {
	return value
		.split(/[,\r\n]+/)
		.map((id) => id.trim())
		.filter(Boolean);
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

function formatProviderDescription(entry: ProviderEntry): string {
	const models = Array.isArray(entry.models) ? entry.models.length : 0;
	const api = typeof entry.api === "string" ? entry.api : "inherit";
	const url = typeof entry.baseUrl === "string" ? truncate(entry.baseUrl, 48) : "built-in/default URL";
	return `${api} · ${models} model${models === 1 ? "" : "s"} · ${url}`;
}

function formatProviderCompletionDescription(entry: ProviderEntry): string {
	const models = Array.isArray(entry.models) ? entry.models.length : 0;
	return `${models} model${models === 1 ? "" : "s"}`;
}

function providerSearchText(provider: { id: string; entry: ProviderEntry }): string {
	const { id, entry } = provider;
	return `${id} ${typeof entry.api === "string" ? entry.api : ""} ${
		typeof entry.baseUrl === "string" ? entry.baseUrl : ""
	}`;
}

async function selectNativeItem<T extends string>(
	ctx: ExtensionCommandContext,
	title: string,
	items: ReadonlyArray<{ value: T; label: string; description?: string }>,
): Promise<T | undefined> {
	const labels = items.map((item) => (item.description ? `${item.label} — ${item.description}` : item.label));
	const selected = await ctx.ui.select(title, labels);
	if (selected === undefined) return undefined;
	return items[labels.indexOf(selected)]?.value;
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

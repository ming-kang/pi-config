/**
 * models — structured provider/model management for ~/.pi/agent/models.json.
 *
 * /models is the primary interface: provider list → focused workspace → model
 * discovery. Drafts are saved atomically and rolled back when Pi rejects the
 * resulting registry configuration.
 */

import { BorderedLoader, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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
	reload: "Reload providers",
	fetch: "Fetch models from a provider",
};

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
	const providerCommand = first === "probe" ? "fetch" : first;
	if (providerCommand !== "edit" && providerCommand !== "remove" && providerCommand !== "fetch") return null;
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
	if (parsed.subcommand === "fetch") {
		await probeFlow(parsed.target, ctx);
		await editExistingProvider(parsed.target, ctx, "models");
	}
}

async function openProviderReference(providerRef: string, ctx: ExtensionCommandContext): Promise<void> {
	const normalized = providerRef.trim().toLowerCase();
	const exact = (await listProviders()).filter(({ id }) => id.toLowerCase() === normalized);
	if (exact.length === 1) {
		await editExistingProvider(exact[0]!.id, ctx);
		return;
	}
	await openProvidersMenu(ctx, providerRef);
}

async function openProvidersMenu(ctx: ExtensionCommandContext, initialQuery?: string): Promise<void> {
	let query = initialQuery;
	let cursorValue: string | undefined;
	while (true) {
		const providers = await listProviders();
		const items = [
			{
				value: "action:add",
				label: "+ Add provider",
				description: "Create a new connection",
				searchText: "add create new provider connection",
			},
			...providers.map(({ id, entry }) => ({
				value: `provider:${id}`,
				label: id,
				description: formatProviderDescription(entry),
				searchText: providerSearchText({ id, entry }),
			})),
			{
				value: "action:reload",
				label: "Reload providers",
				description: "Refresh the provider list",
				searchText: "reload refresh providers models",
			},
		];
		const filteredItems = query ? fuzzyFilter(items, query, (item) => item.searchText) : items;
		const visibleItems = filteredItems.length > 0 ? filteredItems : items;
		const selected =
			ctx.mode === "tui"
				? await ctx.ui.custom(
						createSearchableSelector({
							title: "Model providers",
							subtitle:
								providers.length === 0
									? "No providers yet. Start with Add provider."
									: `${providers.length} provider${providers.length === 1 ? "" : "s"} · Enter opens`,
							items,
							initialQuery: query,
							initialValue: cursorValue,
							maxVisible: 11,
							emptyMessage: "No matching providers or actions",
						}),
					)
				: await selectNativeItem(ctx, "Model providers", visibleItems);
		query = undefined;
		if (selected === undefined) return;
		cursorValue = selected;
		if (selected === "action:add") {
			const providerId = await addProvider(ctx);
			if (providerId) cursorValue = `provider:${providerId}`;
		} else if (selected === "action:reload") {
			await reloadModels(ctx);
		} else if (selected.startsWith("provider:")) {
			const providerId = await editExistingProvider(selected.slice("provider:".length), ctx);
			if (providerId) cursorValue = `provider:${providerId}`;
		}
	}
}

async function addProvider(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const draft = await createProviderSetup(ctx, await listProviderIds());
	if (!draft) return undefined;
	const saved = await commitModelsChange(
		ctx,
		() => saveProvider(undefined, draft.id, draft.entry),
		`Created provider "${draft.id}".`,
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
		ctx.ui.notify(`Provider "${providerId}" not found.`, "warning");
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
				`Saved provider "${id}".`,
			),
	});
	if (result.kind === "discover") {
		await probeFlow(result.id, ctx);
		return (await editExistingProvider(result.id, ctx, "models")) ?? result.id;
	}
	if (result.kind === "remove") {
		await confirmAndRemove(result.id, ctx, true);
		return undefined;
	}
	return result.id;
}

async function confirmAndRemove(
	providerId: string,
	ctx: ExtensionCommandContext,
	confirmationAlreadyGiven = false,
): Promise<boolean> {
	if (!(await getProvider(providerId))) {
		ctx.ui.notify(`Provider "${providerId}" not found.`, "warning");
		return false;
	}
	if (
		!confirmationAlreadyGiven &&
		!(await ctx.ui.confirm(`Remove provider "${providerId}"?`, `Provider "${providerId}" and its models will be removed.`))
	)
		return false;
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
	if (error) ctx.ui.notify(`Reload failed:\n${truncate(error, 1_500)}`, "error");
	else ctx.ui.notify("Reloaded providers.", "info");
}

async function probeFlow(providerId: string, ctx: ExtensionCommandContext): Promise<void> {
	while (true) {
		const entry = await getProvider(providerId);
		if (!entry) {
			ctx.ui.notify(`Provider "${providerId}" not found.`, "warning");
			return;
		}
		const inheritedModel = ctx.modelRegistry.getAll().find((model) => model.provider === providerId);
		const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl : inheritedModel?.baseUrl;
		const api = typeof entry.api === "string" ? entry.api : inheritedModel?.api;
		if (!baseUrl || !api) {
			const action = await selectProbeFailureAction(ctx, "Set Base URL and API protocol before fetching models.");
			if (action === "edit") await editExistingProvider(providerId, ctx);
			if (action === "manual") await addManualModels(providerId, ctx);
			if (action === "retry") continue;
			return;
		}

		if (api === "anthropic-messages") {
			ctx.ui.notify("Anthropic Messages has no catalog endpoint. Add model IDs manually.", "info");
			await addManualModels(providerId, ctx);
			return;
		}

		let apiKey: string | undefined;
		let resolvedHeaders: Record<string, string> | undefined;
		try {
			if (inheritedModel) {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(inheritedModel);
				if (auth.ok === false) throw new Error(auth.error);
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

		const probeOptions = {
			baseUrl,
			api: String(api),
			apiKey: apiKey ?? literalConfigValue(entry.apiKey),
			headers: { ...literalHeaders(entry.headers), ...resolvedHeaders },
		};
		const result =
			ctx.mode === "tui"
				? await ctx.ui.custom<Awaited<ReturnType<typeof probeModels>> | undefined>((tui, theme, _keybindings, done) => {
						const loader = new BorderedLoader(tui, theme, `Fetching models from ${baseUrl}`, { cancellable: true });
						let settled = false;
						const finish = (value: Awaited<ReturnType<typeof probeModels>> | undefined) => {
							if (settled) return;
							settled = true;
							loader.dispose();
							done(value);
						};
						loader.onAbort = () => finish(undefined);
						void probeModels({ ...probeOptions, signal: loader.signal })
							.then(finish)
							.catch((error) => finish({ ok: false, error: formatError(error) }));
						return loader;
					})
				: (ctx.ui.notify(`Fetching models from ${baseUrl} …`, "info"), await probeModels(probeOptions));
		if (result === undefined) return;
		if (result.ok === false) {
			const action = await selectProbeFailureAction(ctx, `Model fetch failed: ${result.error}`);
			if (action === "edit") await editExistingProvider(providerId, ctx);
			if (action === "manual") await addManualModels(providerId, ctx);
			if (action === "retry") continue;
			return;
		}
		const existing = new Set(Array.isArray(entry.models) ? entry.models.map((model) => model.id) : []);
		const available = result.models.filter((model) => !existing.has(model.id));
		if (available.length === 0) {
			ctx.ui.notify("All fetched models are already configured.", "info");
			return;
		}
		if (result.truncated) ctx.ui.notify("Fetched more than 2,000 models; only the first 2,000 are shown.", "warning");

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
	return selectNativeItem(
		ctx,
		message,
		[
			{ value: "retry", label: "Retry" },
			{ value: "edit", label: "Edit provider" },
			{ value: "manual", label: "Add manually" },
			{ value: "back", label: "Back" },
		],
		"probe-failure",
	);
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

const nativeSelectorMemory = new Map<string, string>();

async function selectNativeItem<T extends string>(
	ctx: ExtensionCommandContext,
	title: string,
	items: ReadonlyArray<{ value: T; label: string; description?: string }>,
	memoryKey = title,
): Promise<T | undefined> {
	if (ctx.mode === "tui") {
		const remembered = nativeSelectorMemory.get(memoryKey) as T | undefined;
		const selected = await ctx.ui.custom(
			createSearchableSelector({
				title,
				items,
				initialValue: remembered,
				maxVisible: Math.min(10, Math.max(1, items.length)),
			}),
		);
		if (selected !== undefined) nativeSelectorMemory.set(memoryKey, selected);
		return selected;
	}
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
	const target = subcommand === "edit" || subcommand === "remove" || subcommand === "fetch" ? " <provider-id>" : "";
	ctx.ui.notify(`Usage: /${COMMAND_NAME} ${subcommand}${target}`, "warning");
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

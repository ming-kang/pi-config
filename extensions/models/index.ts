/**
 * models — manage custom providers in ~/.pi/agent/models.json
 *
 * A Pi-native menu for the custom-provider workflow. Replaces hand-editing
 * the JSON file with a single-screen form-driven UI:
 *
 *   /models                  → provider list (+ Add new)
 *   /models add              → open empty provider form
 *   /models list             → provider list (same as no-arg)
 *   /models edit <name>      → open provider form pre-filled
 *   /models remove <name>    → confirm + delete from models.json
 *   /models reload           → re-read models.json without restarting
 *   /models probe <name>     → fetch /v1/models, pick which to register
 *
 * Sub-editors (input prompts, select pickers, confirm dialogs, headers and
 * models sub-forms) are opened as overlays within a single ctx.ui.custom
 * invocation — no nested dialog stacks.
 *
 * Persistence: writes go straight to ~/.pi/agent/models.json via an atomic
 * temp+rename, then ctx.modelRegistry.refresh() picks up the change without
 * requiring /model or restart.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	COMMAND_DESCRIPTION,
	COMMAND_NAME,
	NO_UI_WARNING,
	SUBCOMMANDS,
	parseArgs,
} from "./constants.ts";
import {
	createProbeChecklist,
	createProviderActionsMenu,
	createProvidersMenu,
	type ProviderAction,
	type ProvidersMenuResult,
} from "./dialog.ts";
import { createProviderForm } from "./models-form.ts";
import { probeModels } from "./probe.ts";
import {
	getProvider,
	listProviderIds,
	removeProvider as removeProviderFromFile,
	upsertProvider,
} from "./store.ts";

export default function modelsExtension(pi: ExtensionAPI) {
	pi.registerCommand(COMMAND_NAME, {
		description: COMMAND_DESCRIPTION,
		getArgumentCompletions: (prefix) => {
			const filtered = SUBCOMMANDS.filter((s) => s.startsWith(prefix));
			if (filtered.length === 0) return null;
			return filtered.map((value) => ({ value, label: `/${COMMAND_NAME} ${value}` }));
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify(NO_UI_WARNING, "warning");
				return;
			}
			const { subcommand, target } = parseArgs(args);
			await dispatch(subcommand, target, ctx);
		},
	});
}

// ============================================================================
// Dispatch — routes by subcommand, with smart fallbacks
// ============================================================================

async function dispatch(
	sub: ReturnType<typeof parseArgs>["subcommand"],
	target: string | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	// No args, or `list` → open top-level providers menu.
	if (!sub || sub === "list") return openProvidersMenu(ctx);
	if (sub === "add") return openAddForm(ctx);
	if (sub === "reload") return reloadModels(ctx);
	if (sub === "edit" || sub === "remove" || sub === "probe") {
		if (!target) {
			ctx.ui.notify(`Usage: /${COMMAND_NAME} ${sub} <provider-id>`, "warning");
			return;
		}
		if (sub === "edit") return openEditForm(target, ctx);
		if (sub === "remove") return confirmAndRemove(target, ctx);
		if (sub === "probe") return probeFlow(target, ctx);
	}
}

// ============================================================================
// Top-level menu — when user picks a provider, show action menu
// ============================================================================

async function openProvidersMenu(ctx: ExtensionCommandContext): Promise<void> {
	const ids = await listProviderIds();
	const providers: Array<{ id: string; entry: Awaited<ReturnType<typeof getProvider>> }> = [];
	for (const id of ids) {
		const entry = await getProvider(id);
		if (entry) providers.push({ id, entry });
	}

	const result = (await ctx.ui.custom(createProvidersMenu(
		providers.filter((p) => p.entry !== undefined).map((p) => ({ id: p.id, entry: p.entry! })),
	))) as ProvidersMenuResult;

	if (result.kind === "add") return openAddForm(ctx);
	if (result.kind === "pick") {
		const entry = await getProvider(result.providerId);
		if (!entry) {
			ctx.ui.notify(`Provider "${result.providerId}" disappeared from models.json.`, "warning");
			return openProvidersMenu(ctx);
		}
		return openProviderActions(result.providerId, entry, ctx);
	}
	// cancel → fall through
}

async function openProviderActions(
	providerId: string,
	entry: NonNullable<Awaited<ReturnType<typeof getProvider>>>,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const action = (await ctx.ui.custom(
		createProviderActionsMenu(providerId, entry),
	)) as ProviderAction | undefined;

	switch (action) {
		case "edit":
			return openEditForm(providerId, ctx);
		case "probe":
			return probeFlow(providerId, ctx);
		case "remove":
			return confirmAndRemove(providerId, ctx);
		case "back":
		case undefined:
			return openProvidersMenu(ctx);
	}
}

// ============================================================================
// Add flow
// ============================================================================

async function openAddForm(ctx: ExtensionCommandContext): Promise<void> {
	const existingIds = await listProviderIds();
	const result = (await ctx.ui.custom(
		createProviderForm({
			mode: "add",
			existingIds,
			initialId: "",
			initialEntry: {},
			onSave: async (id, entry) => {
				await upsertProvider(id, entry);
				await ctx.modelRegistry.refresh();
				ctx.ui.notify(`Saved "${id}" — refresh complete.`, "info");
			},
			onCancel: () => {},
		}),
	)) as { saved?: true; cancelled?: true };

	if (result?.saved) {
		// Refresh the menu so the new entry shows up; only do this on Add to give
		// the user a confirmation moment.
		await openProvidersMenu(ctx);
	}
}

// ============================================================================
// Edit flow
// ============================================================================

async function openEditForm(providerId: string, ctx: ExtensionCommandContext): Promise<void> {
	const entry = await getProvider(providerId);
	if (!entry) {
		ctx.ui.notify(`Provider "${providerId}" not found in models.json.`, "warning");
		return openProvidersMenu(ctx);
	}
	const existingIds = await listProviderIds();

	const result = (await ctx.ui.custom(
		createProviderForm({
			mode: "edit",
			existingIds,
			initialId: providerId,
			initialEntry: entry,
			onSave: async (id, updated) => {
				// If id changed, remove the old one first to avoid orphans.
				if (id !== providerId) {
					await removeProviderFromFile(providerId);
				}
				await upsertProvider(id, updated);
				await ctx.modelRegistry.refresh();
				ctx.ui.notify(`Saved "${id}" — refresh complete.`, "info");
			},
			onCancel: () => {},
		}),
	)) as { saved?: true; cancelled?: true };

	void result;
}

// ============================================================================
// Remove flow
// ============================================================================

async function confirmAndRemove(providerId: string, ctx: ExtensionCommandContext): Promise<void> {
	const ok = await ctx.ui.confirm(
		`Remove "${providerId}"?`,
		`This deletes the provider entry from ~/.pi/agent/models.json. Models stay registered for this session; /reload (or restart) to apply everywhere.`,
	);
	if (!ok) {
		ctx.ui.notify("Cancelled.", "info");
		return;
	}
	try {
		await removeProviderFromFile(providerId);
		await ctx.modelRegistry.refresh();
		ctx.ui.notify(`Removed "${providerId}".`, "info");
	} catch (err) {
		ctx.ui.notify(
			`Failed to remove: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

// ============================================================================
// Reload — re-read models.json without restart
// ============================================================================

async function reloadModels(ctx: ExtensionCommandContext): Promise<void> {
	try {
		await ctx.modelRegistry.refresh();
		const err = ctx.modelRegistry.getError();
		if (err) {
			ctx.ui.notify(`Reload warning: ${err}`, "warning");
		} else {
			ctx.ui.notify("Reloaded ~/.pi/agent/models.json.", "info");
		}
	} catch (err) {
		ctx.ui.notify(
			`Reload failed: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

// ============================================================================
// Probe — fetch /v1/models, multi-select, append selected as new models
// ============================================================================

async function probeFlow(providerId: string, ctx: ExtensionCommandContext): Promise<void> {
	const entry = await getProvider(providerId);
	if (!entry) {
		ctx.ui.notify(`Provider "${providerId}" not found.`, "warning");
		return openProvidersMenu(ctx);
	}
	if (!entry.baseUrl) {
		ctx.ui.notify(`"${providerId}" has no baseUrl — edit it first.`, "warning");
		return;
	}

	ctx.ui.notify(`Probing ${entry.baseUrl}/models …`, "info");
	const result = await probeModels({
		baseUrl: entry.baseUrl,
		apiKey: entry.apiKey,
		api: entry.api ?? "openai-completions",
		headers: entry.headers,
	});

	if (!result.ok) {
		ctx.ui.notify(`Probe failed: ${result.error}`, "error");
		return openProviderActions(providerId, entry, ctx);
	}

	const existingIds = new Set((entry.models ?? []).map((m) => m.id));
	const newModels = result.models.filter((m) => !existingIds.has(m.id));

	if (newModels.length === 0) {
		ctx.ui.notify(
			`All ${result.models.length} probed models are already registered for "${providerId}".`,
			"info",
		);
		return openProviderActions(providerId, entry, ctx);
	}

	const choice = (await ctx.ui.custom(createProbeChecklist(providerId, newModels))) as
		| { kind: "save"; selectedIds: string[] }
		| { kind: "cancel" }
		| undefined;

	if (!choice || choice.kind === "cancel") {
		ctx.ui.notify("Probe cancelled — no changes made.", "info");
		return openProviderActions(providerId, entry, ctx);
	}

	const idSet = new Set(choice.selectedIds);
	const appended: Array<{ id: string; name?: string }> = [];
	for (const probed of newModels) {
		if (!idSet.has(probed.id)) continue;
		entry.models = entry.models ?? [];
		entry.models.push({
			id: probed.id,
			name: probed.name ?? probed.id,
			reasoning: false,
			input: ["text"],
		});
		appended.push({ id: probed.id, name: probed.name });
	}

	if (appended.length === 0) {
		ctx.ui.notify("No models selected — nothing to save.", "info");
		return openProviderActions(providerId, entry, ctx);
	}

	try {
		await upsertProvider(providerId, entry);
		await ctx.modelRegistry.refresh();
		ctx.ui.notify(`Added ${appended.length} model(s) to "${providerId}".`, "info");
	} catch (err) {
		ctx.ui.notify(
			`Save failed: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
	return openProviderActions(providerId, entry, ctx);
}
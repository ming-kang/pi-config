/** Browse-first provider workspace and focused model editors built from Pi-native dialogs. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { API_CHOICES, DEFAULTS, isValidProviderId, MODEL_LIMIT_PRESETS, truncate } from "./constants.ts";
import { createModelWorkspace, createSearchableSelector, createTextInput, type ModelWorkspaceResult } from "./dialog.ts";
import type {
	Cost,
	CostTier,
	ModelEntry,
	ModelOverride,
	ProviderEntry,
	ThinkingLevel,
	ThinkingLevelMap,
} from "./store.ts";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const COMPAT_FIELDS = [
	"supportsStore",
	"supportsDeveloperRole",
	"supportsReasoningEffort",
	"supportsUsageInStreaming",
	"maxTokensField",
	"requiresToolResultName",
	"requiresAssistantAfterToolResult",
	"requiresThinkingAsText",
	"requiresReasoningContentOnAssistantMessages",
	"thinkingFormat",
	"chatTemplateKwargs",
	"cacheControlFormat",
	"sendSessionAffinityHeaders",
	"sessionAffinityFormat",
	"supportsStrictMode",
	"deferredToolsMode",
	"supportsLongCacheRetention",
	"openRouterRouting",
	"vercelGatewayRouting",
	"supportsEagerToolInputStreaming",
	"supportsCacheControlOnTools",
	"forceAdaptiveThinking",
	"allowEmptySignature",
] as const;

const MENU_CURSOR_MEMORY = new Map<string, string>();

export interface SaveAttempt {
	ok: boolean;
	error?: string;
}

export interface ProviderEditorOptions {
	initialId: string;
	initialEntry: ProviderEntry;
	existingIds: readonly string[];
	initialSection?: "models";
	onSave: (originalId: string, id: string, entry: ProviderEntry) => Promise<SaveAttempt>;
}

export type ProviderEditorResult =
	| { kind: "discover"; id: string }
	| { kind: "remove"; id: string }
	| { kind: "closed"; id: string };

interface MenuOption<T extends string> {
	key: T;
	label: string;
}

interface EditResult<T> {
	changed: boolean;
	value?: T;
}

const REMOVE_MODEL = Symbol("remove-model");
const REMOVE_OVERRIDE = Symbol("remove-override");

export interface NewProviderDraft {
	id: string;
	entry: ProviderEntry;
}

/**
 * Provider creation is guided through the required connection choices before
 * exposing a compact review screen. API type is a protocol choice, not a
 * provider identity.
 */
export async function createProviderSetup(
	ctx: ExtensionCommandContext,
	existingIds: readonly string[],
): Promise<NewProviderDraft | undefined> {
	let id = "";
	const entry: ProviderEntry = {};
	const cancel = async (): Promise<boolean> =>
		ctx.ui.confirm("Discard new provider?", "The connection details have not been saved.");

	while (!id) {
		const value = await promptText(ctx, "Provider ID · step 1 of 4", id, "my-provider", (candidate) =>
			validateProviderId(candidate.trim(), existingIds),
		);
		if (value !== undefined) id = value.trim();
		else if (await cancel()) return undefined;
	}
	while (!entry.baseUrl) {
		const value = await promptRequiredUrl(ctx, "Base URL · step 2 of 4", entry.baseUrl);
		if (value !== undefined) entry.baseUrl = value;
		else if (await cancel()) return undefined;
	}
	while (!entry.api) {
		const value = await chooseRequiredApi(ctx, "API protocol · step 3 of 4", entry.api);
		if (value.changed && value.value) entry.api = value.value;
		else if (value.value === undefined && (await cancel())) return undefined;
	}
	while (true) {
		const completed = await chooseProviderSetupAuthentication(ctx, id, entry);
		if (completed) break;
		if (await cancel()) return undefined;
	}

	while (true) {
		const choice = await selectKey(ctx, "Review new provider", [
			{ key: "id", label: summaryRow("Provider ID", id) },
			{ key: "baseUrl", label: summaryRow("Base URL", entry.baseUrl) },
			{ key: "api", label: summaryRow("API protocol", formatApi(entry.api)) },
			{ key: "auth", label: summaryRow("Authentication", summarizeSetupAuthentication(entry)) },
			{ key: "create", label: "Create provider and fetch models" },
			{ key: "cancel", label: "Discard" },
		]);
		if (choice === undefined || choice === "cancel") {
			if (await cancel()) return undefined;
			continue;
		}
		if (choice === "id") {
			const value = await promptText(ctx, "Provider ID", id, "my-provider", (candidate) =>
				validateProviderId(candidate.trim(), existingIds),
			);
			if (value !== undefined) id = value.trim();
			continue;
		}
		if (choice === "baseUrl") {
			const value = await promptRequiredUrl(ctx, "Provider base URL", entry.baseUrl);
			if (value !== undefined) entry.baseUrl = value;
			continue;
		}
		if (choice === "api") {
			const value = await chooseRequiredApi(ctx, "Provider API protocol", entry.api);
			if (value.changed && value.value) entry.api = value.value;
			continue;
		}
		if (choice === "auth") {
			await chooseProviderSetupAuthentication(ctx, id, entry);
			continue;
		}
		if (choice === "create") return { id, entry: structuredClone(entry) };
	}
}

async function chooseProviderSetupAuthentication(
	ctx: ExtensionCommandContext,
	providerId: string,
	entry: ProviderEntry,
): Promise<boolean> {
	const choice = await selectKey(ctx, "Authentication · step 4 of 4", [
		{ key: "environment", label: "Environment variable · recommended" },
		{ key: "advanced", label: "Advanced · literal, interpolation, or command" },
		{ key: "later", label: "Configure later · keyless server or /login" },
	]);
	if (choice === undefined) return false;
	if (choice === "later") {
		delete entry.apiKey;
		return true;
	}
	if (choice === "advanced") {
		const value = await editSecret(ctx, entry.apiKey);
		if (!value.changed) return entry.apiKey !== undefined;
		setOptional(entry, "apiKey", value.value);
		return entry.apiKey !== undefined;
	}

	const current = extractEnvironmentVariable(entry.apiKey) ?? suggestEnvironmentVariable(providerId);
	const value = await promptText(ctx, "API key environment variable", current, "MY_PROVIDER_API_KEY", (candidate) => {
		const normalized = normalizeEnvironmentVariable(candidate);
		return /^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)
			? undefined
			: "Use an environment variable name such as MY_PROVIDER_API_KEY.";
	});
	if (value === undefined) return false;
	entry.apiKey = `$${normalizeEnvironmentVariable(value)}`;
	return true;
}

export async function editProvider(
	ctx: ExtensionCommandContext,
	opts: ProviderEditorOptions,
): Promise<ProviderEditorResult> {
	let baseline = { id: opts.initialId, entry: structuredClone(opts.initialEntry) };
	let persistedId = opts.initialId;
	let id = baseline.id;
	const entry = structuredClone(baseline.entry);
	const knownIds = new Set(opts.existingIds);
	const providerWorkspaceMemoryKey = `provider-workspace:${opts.initialId}`;

	const save = async (): Promise<boolean> => {
		if (jsonEqual(baseline, { id, entry })) return true;
		const errors = validateProvider(id, entry, [...knownIds], persistedId);
		if (errors.length > 0) {
			ctx.ui.notify(errors.join("\n"), "error");
			return false;
		}
		const result = await opts.onSave(persistedId, id, structuredClone(entry));
		if (!result.ok) {
			ctx.ui.notify(result.error ?? "Provider could not be saved.", "error");
			return false;
		}
		knownIds.delete(persistedId);
		knownIds.add(id);
		persistedId = id;
		baseline = { id, entry: structuredClone(entry) };
		return true;
	};
	const openModels = async (): Promise<boolean> => {
		if (entry.models !== undefined && !Array.isArray(entry.models)) {
			ctx.ui.notify("The existing models field is not an array; fix it externally before using the model workspace.", "error");
			return false;
		}
		const discover = await editModelsWorkspace(ctx, entry, {
			dirty: () => !jsonEqual(baseline, { id, entry }),
			onSave: save,
		});
		return discover && (await save());
	};
	let openModelsOnStart = opts.initialSection === "models";

	while (true) {
		if (openModelsOnStart) {
			openModelsOnStart = false;
			if (await openModels()) return { kind: "discover", id: persistedId };
		}
		const dirty = !jsonEqual(baseline, { id, entry });
		const models = Array.isArray(entry.models) ? entry.models : [];
		const workspaceOptions: MenuOption<string>[] = [
			{ key: "models", label: `Models · ${models.length}` },
			{ key: "id", label: summaryRow("Provider ID", id) },
			{ key: "baseUrl", label: summaryRow("Base URL", entry.baseUrl ?? "Not set") },
			{ key: "api", label: summaryRow("API protocol", formatApi(entry.api)) },
			{ key: "apiKey", label: summaryRow("API key", formatSecret(entry.apiKey)) },
			{ key: "auth", label: summaryRow("Advanced authentication", summarizeAuthenticationAdvanced(entry)) },
			{ key: "headers", label: `Headers · ${countLabel(entry.headers, "header")}` },
			{ key: "compat", label: `Compatibility · ${countLabel(entry.compat, "setting")}` },
			{ key: "overrides", label: `Built-in model overrides · ${countLabel(entry.modelOverrides, "override")}` },
			{ key: "save", label: dirty ? "Save changes" : "Save changes · up to date" },
			{ key: "remove", label: "Remove provider" },
			{ key: "back", label: "Back" },
		];
		const choice = await selectProviderWorkspaceKey(ctx, id, providerWorkspaceMemoryKey, dirty, workspaceOptions);

		if (choice === undefined || choice === "back") {
			if (!dirty) return { kind: "closed", id: persistedId };
			const leave = await selectKey(ctx, "Unsaved provider changes", [
				{ key: "save", label: "Save and leave" },
				{ key: "discard", label: "Discard and leave" },
				{ key: "continue", label: "Continue editing" },
			]);
			if (leave === "save" && (await save())) return { kind: "closed", id: persistedId };
			if (leave === "discard") return { kind: "closed", id: persistedId };
			continue;
		}

		switch (choice) {
			case "models": {
				if (await openModels()) return { kind: "discover", id: persistedId };
				break;
			}
			case "id": {
				const value = await promptText(ctx, "Provider ID", id, "my-provider", (candidate) =>
					validateProviderId(candidate.trim(), [...knownIds], persistedId),
				);
				if (value !== undefined) id = value.trim();
				break;
			}
			case "baseUrl": {
				const value = await promptOptionalUrl(ctx, "Provider base URL", entry.baseUrl);
				if (value.changed) setOptional(entry, "baseUrl", value.value);
				break;
			}
			case "api": {
				const value = await chooseApi(ctx, "Provider default API", entry.api);
				if (value.changed) setOptional(entry, "api", value.value);
				break;
			}
			case "apiKey": {
				const value = await editSecret(ctx, entry.apiKey);
				if (value.changed) setOptional(entry, "apiKey", value.value);
				break;
			}
			case "auth":
				await editProviderAuthentication(ctx, entry);
				break;
			case "headers": {
				const value = await editHeaders(ctx, "Provider headers", entry.headers);
				if (value.changed) setOptionalRecord(entry, "headers", value.value);
				break;
			}
			case "compat": {
				const value = await editCompat(ctx, "Provider compatibility", entry.compat);
				if (value.changed) setOptionalRecord(entry, "compat", value.value);
				break;
			}
			case "overrides": {
				const value = await editModelOverrides(ctx, entry.modelOverrides);
				if (value.changed) setOptionalRecord(entry, "modelOverrides", value.value);
				break;
			}
			case "save":
				await save();
				break;
			case "remove": {
				const confirmed = await ctx.ui.confirm(
					"Remove provider?",
					`Provider "${persistedId}" and its models will be removed. Unsaved changes will be discarded.`,
				);
				if (confirmed) return { kind: "remove", id: persistedId };
				break;
			}
		}
	}
}

async function editProviderAuthentication(ctx: ExtensionCommandContext, entry: ProviderEntry): Promise<void> {
	while (true) {
		const choice = await selectKey(ctx, "Provider authentication", [
			{ key: "oauth", label: `OAuth · ${entry.oauth ?? "Not set"}` },
			{ key: "authHeader", label: `Send Bearer auth header · ${formatOptionalBoolean(entry.authHeader)}` },
			{ key: "back", label: "Back" },
		]);
		if (choice === undefined || choice === "back") return;
		if (choice === "oauth") {
			const selected = await selectKey(ctx, "OAuth", [
				{ key: "unset", label: "Not set" },
				{ key: "radius", label: "Radius OAuth" },
			]);
			if (selected === "unset") delete entry.oauth;
			if (selected === "radius") entry.oauth = "radius";
		}
		if (choice === "authHeader") {
			const value = await chooseOptionalBoolean(ctx, "Authorization: Bearer <apiKey>", entry.authHeader);
			if (value.changed) setOptional(entry, "authHeader", value.value);
		}
	}
}

interface ModelWorkspaceOptions {
	dirty: () => boolean;
	onSave: () => Promise<boolean>;
}

async function editModelsWorkspace(
	ctx: ExtensionCommandContext,
	entry: ProviderEntry,
	opts: ModelWorkspaceOptions,
): Promise<boolean> {
	const models = entry.models ?? (entry.models = []);
	let selectedIds: string[] = [];
	let cursorId: string | undefined;
	while (true) {
		const result =
			ctx.mode === "tui"
				? await ctx.ui.custom(
						createModelWorkspace(
							`Models · ${models.length}`,
							models.map((model) => ({
								id: model.id,
								label: `${model.id || "(missing id)"} — ${summarizeModel(model)}`,
								searchText: `${model.id} ${model.name ?? ""} ${summarizeModel(model)}`,
							})),
							selectedIds,
							opts.dirty(),
							cursorId,
						),
					)
				: await selectModelWorkspaceFallback(ctx, models, selectedIds, cursorId);
		selectedIds = result.selectedIds;
		cursorId = result.cursorId;
		if (result.kind === "back") return false;
		if (result.kind === "save") {
			await opts.onSave();
			continue;
		}
		if (result.kind === "edit") {
			const index = models.findIndex((model) => model.id === result.id);
			const current = models[index];
			if (!current) continue;
			const originalId = current.id;
			const updated = await editModel(ctx, current, models.filter((_, candidate) => candidate !== index).map((model) => model.id));
			if (updated === REMOVE_MODEL) {
				models.splice(index, 1);
				selectedIds = selectedIds.filter((selected) => selected !== originalId);
				cursorId = models[index]?.id ?? models[index - 1]?.id;
			} else if (updated && updated.id !== originalId) {
				models[index] = updated;
				selectedIds = selectedIds.map((selected) => (selected === originalId ? updated.id : selected));
				cursorId = updated.id;
			}
			continue;
		}
		if (result.kind === "discover") return true;
		if (result.kind === "add") {
			const added = await addModelIds(ctx, models);
			selectedIds = [...new Set([...selectedIds, ...added])];
			continue;
		}
		if (result.kind === "bulk") {
			await bulkEditModels(ctx, models.filter((model) => selectedIds.includes(model.id)));
			continue;
		}
		if (result.kind === "remove") {
			if (await ctx.ui.confirm("Remove selected models?", `Remove ${selectedIds.length} model${selectedIds.length === 1 ? "" : "s"} from this provider?`)) {
				cursorId = removeSelectedModels(models, selectedIds, cursorId);
				selectedIds = [];
			}
			continue;
		}
		if (result.kind !== "actions") continue;

		const actionOptions: MenuOption<string>[] = [
			{
				key: "discover",
				label: opts.dirty() ? "Fetch from server · saves pending changes first" : "Fetch from server",
			},
			{ key: "add", label: "Add model IDs" },
			...(selectedIds.length
				? [
					{ key: "bulk", label: `Bulk edit ${selectedIds.length} model${selectedIds.length === 1 ? "" : "s"}` },
					{ key: "remove", label: `Remove ${selectedIds.length} model${selectedIds.length === 1 ? "" : "s"}` },
					{ key: "clear", label: "Clear selection" },
				]
				: []),
			{ key: "back", label: "Back to models" },
		];
		const action = await selectKey(ctx, `Model actions${selectedIds.length ? ` · ${selectedIds.length} selected` : ""}`, actionOptions);
		if (action === undefined || action === "back") continue;
		if (action === "discover") return true;
		if (action === "add") {
			const added = await addModelIds(ctx, models);
			selectedIds = [...new Set([...selectedIds, ...added])];
		}
		if (action === "bulk") {
			await bulkEditModels(ctx, models.filter((model) => selectedIds.includes(model.id)));
		}
		if (action === "remove") {
			if (await ctx.ui.confirm("Remove selected models?", `Remove ${selectedIds.length} model${selectedIds.length === 1 ? "" : "s"} from this provider?`)) {
				cursorId = removeSelectedModels(models, selectedIds, cursorId);
				selectedIds = [];
			}
		}
		if (action === "clear") selectedIds = [];
	}
}

async function selectModelWorkspaceFallback(
	ctx: ExtensionCommandContext,
	models: readonly ModelEntry[],
	selectedIds: readonly string[],
	cursorId: string | undefined,
): Promise<ModelWorkspaceResult> {
	const labels = models.map((model) => `${model.id} — ${summarizeModel(model)}`);
	labels.push("Model actions", "Save changes", "Back");
	const choice = await ctx.ui.select(`Models · ${models.length}`, labels);
	if (choice === "Model actions") return { kind: "actions", selectedIds: [...selectedIds], cursorId };
	if (choice === "Save changes") return { kind: "save", selectedIds: [...selectedIds], cursorId };
	if (choice === undefined || choice === "Back") return { kind: "back", selectedIds: [...selectedIds], cursorId };
	const index = labels.indexOf(choice);
	const model = models[index];
	return model
		? { kind: "edit", id: model.id, selectedIds: [...selectedIds], cursorId: model.id }
		: { kind: "back", selectedIds: [...selectedIds], cursorId };
}

function removeSelectedModels(
	models: ModelEntry[],
	selectedIds: readonly string[],
	cursorId: string | undefined,
): string | undefined {
	const selected = new Set(selectedIds);
	const cursorIndex = cursorId === undefined ? 0 : models.findIndex((model) => model.id === cursorId);
	const cursorRemoved = cursorId !== undefined && selected.has(cursorId);
	for (let index = models.length - 1; index >= 0; index--) {
		if (selected.has(models[index]!.id)) models.splice(index, 1);
	}
	if (!cursorRemoved && cursorId !== undefined && models.some((model) => model.id === cursorId)) return cursorId;
	const nextIndex = Math.min(Math.max(cursorIndex, 0), models.length - 1);
	return models[nextIndex]?.id;
}

async function addModelIds(ctx: ExtensionCommandContext, models: ModelEntry[]): Promise<string[]> {
	const existing = new Set(models.map((model) => model.id));
	const value = await promptText(
		ctx,
		"Model IDs · comma-separated",
		"",
		"model-a, model-b, model-c",
		(candidate) => {
			const ids = parseModelIds(candidate);
			if (ids.length === 0) return "Enter at least one model ID.";
			const duplicate = ids.find((id, index) => ids.indexOf(id) !== index || existing.has(id));
			return duplicate ? `Model "${duplicate}" already exists in this provider.` : undefined;
		},
	);
	if (value === undefined) return [];
	const ids = parseModelIds(value);
	for (const id of ids) models.push({ id });
	ctx.ui.notify(`Added ${ids.length} model${ids.length === 1 ? "" : "s"}.`, "info");
	return ids;
}

async function bulkEditModels(ctx: ExtensionCommandContext, models: ModelEntry[]): Promise<void> {
	if (models.length === 0) {
		ctx.ui.notify("Add at least one model before using bulk edit.", "warning");
		return;
	}
	const selected = () => models;
	while (true) {
		const choice = await selectKey(ctx, `Bulk edit · ${selected().length} model${selected().length === 1 ? "" : "s"}`, [
			{ key: "reasoning", label: "Reasoning support" },
			{ key: "input", label: "Input types" },
			{ key: "limitPreset", label: "Limit preset" },
			{ key: "context", label: "Context window" },
			{ key: "maxTokens", label: "Maximum output tokens" },
			{ key: "thinking", label: "Thinking level mapping" },
			{ key: "back", label: "Done" },
		]);
		if (choice === undefined || choice === "back") return;
		if (choice === "reasoning") {
			const value = await chooseBulkOptionalBoolean(ctx, "Reasoning support for selected models");
			if (value.changed) for (const model of selected()) setOptional(model, "reasoning", value.value);
		}
		if (choice === "input") {
			const value = await chooseBulkInput(ctx);
			if (value.changed) {
				for (const model of selected()) {
					setOptional(model, "input", value.value ? [...value.value] : undefined);
				}
			}
		}
		if (choice === "limitPreset") {
			await applyModelLimitPreset(ctx, "Limit preset for selected models", selected());
		}
		if (choice === "context") {
			const value = await promptBulkOptionalInteger(ctx, "Context window for selected models");
			if (value.changed) for (const model of selected()) setOptional(model, "contextWindow", value.value);
		}
		if (choice === "maxTokens") {
			const value = await promptBulkOptionalInteger(ctx, "Maximum output tokens for selected models");
			if (value.changed) for (const model of selected()) setOptional(model, "maxTokens", value.value);
		}
		if (choice === "thinking") await editBulkThinkingMaps(ctx, selected());
	}
}

async function applyModelLimitPreset(
	ctx: ExtensionCommandContext,
	title: string,
	models: readonly ModelEntry[],
): Promise<void> {
	const options: MenuOption<string>[] = MODEL_LIMIT_PRESETS.map((preset) => ({
		key: preset.value,
		label: preset.label,
	}));
	options.push(
		{ key: "clear", label: "Clear both · Pi fallback" },
		{ key: "back", label: "Back" },
	);
	const selected = await selectKey(ctx, title, options);
	if (selected === undefined || selected === "back") return;
	const preset = MODEL_LIMIT_PRESETS.find((candidate) => candidate.value === selected);
	for (const model of models) {
		setOptional(model, "contextWindow", preset?.contextWindow);
		setOptional(model, "maxTokens", preset?.maxTokens);
	}
}

async function chooseBulkOptionalBoolean(ctx: ExtensionCommandContext, title: string): Promise<EditResult<boolean>> {
	const selected = await selectKey(ctx, title, [
		{ key: "unset", label: "Default" },
		{ key: "true", label: "True" },
		{ key: "false", label: "False" },
	]);
	if (selected === undefined) return { changed: false };
	return { changed: true, value: selected === "unset" ? undefined : selected === "true" };
}

async function chooseBulkInput(ctx: ExtensionCommandContext): Promise<EditResult<ModelEntry["input"]>> {
	const selected = await selectKey(ctx, "Input types for selected models", [
		{ key: "unset", label: "Default · text" },
		{ key: "text", label: "Text only" },
		{ key: "image", label: "Text + image" },
	]);
	if (selected === undefined) return { changed: false };
	const value = selected === "unset" ? undefined : selected === "image" ? (["text", "image"] as const) : (["text"] as const);
	return { changed: true, value: value ? [...value] : undefined };
}

async function promptBulkOptionalInteger(ctx: ExtensionCommandContext, title: string): Promise<EditResult<number>> {
	const value = await promptText(ctx, `${title} · empty clears`, "", undefined, (candidate) => {
		if (!candidate.trim()) return undefined;
		const number = Number(candidate);
		return Number.isSafeInteger(number) && number > 0 ? undefined : "Use a positive integer.";
	});
	if (value === undefined) return { changed: false };
	return { changed: true, value: value.trim() ? Number(value) : undefined };
}

async function editModel(
	ctx: ExtensionCommandContext,
	model: ModelEntry,
	otherIds: readonly string[],
): Promise<ModelEntry | typeof REMOVE_MODEL | undefined> {
	while (true) {
		const choice = await selectKey(ctx, `Model · ${model.id || "new"}`, [
			{ key: "id", label: summaryRow("Model ID", model.id || "required") },
			{ key: "name", label: summaryRow("Model name", model.name ?? "Not set") },
			{ key: "reasoning", label: summaryRow("Reasoning support", formatOptionalBoolean(model.reasoning)) },
			{ key: "input", label: summaryRow("Input types", formatInput(model.input)) },
			{ key: "limitPreset", label: summaryRow("Limit preset", summarizeModelLimitPreset(model)) },
			{
				key: "context",
				label: summaryRow(
					"Context window",
					model.contextWindow?.toLocaleString() ?? `Pi fallback · ${DEFAULTS.contextWindow.toLocaleString()}`,
				),
			},
			{
				key: "maxTokens",
				label: summaryRow(
					"Maximum output tokens",
					model.maxTokens?.toLocaleString() ?? `Pi fallback · ${DEFAULTS.maxTokens.toLocaleString()}`,
				),
			},
			{ key: "thinking", label: summaryRow("Thinking level mapping", summarizeThinkingMap(model.thinkingLevelMap)) },
			{ key: "api", label: summaryRow("API override", formatApi(model.api)) },
			{ key: "cost", label: summaryRow("Token cost", model.cost ? "configured" : "zero defaults") },
			{ key: "compat", label: summaryRow("Compatibility", countLabel(model.compat, "setting")) },
			{ key: "remove", label: "Remove model" },
			{ key: "done", label: "Done" },
		]);

		if (choice === undefined || choice === "done") return model;
		switch (choice) {
			case "id": {
				const value = await promptText(ctx, "Model ID", model.id, "model-id", (candidate) => {
					const trimmed = candidate.trim();
					if (!trimmed) return "Model ID is required.";
					if (otherIds.includes(trimmed)) return "That model ID already exists in this provider.";
					return undefined;
				});
				if (value !== undefined) model.id = value.trim();
				break;
			}
			case "name": {
				const value = await promptOptionalText(ctx, "Model name", model.name);
				if (value.changed) setOptional(model, "name", value.value);
				break;
			}
			case "reasoning": {
				const value = await chooseOptionalBoolean(ctx, "Reasoning support", model.reasoning);
				if (value.changed) setOptional(model, "reasoning", value.value);
				break;
			}
			case "input": {
				const value = await chooseInput(ctx, model.input);
				if (value.changed) setOptional(model, "input", value.value);
				break;
			}
			case "limitPreset":
				await applyModelLimitPreset(ctx, "Model limit preset", [model]);
				break;
			case "context": {
				const value = await promptOptionalInteger(ctx, "Context window", model.contextWindow);
				if (value.changed) setOptional(model, "contextWindow", value.value);
				break;
			}
			case "maxTokens": {
				const value = await promptOptionalInteger(ctx, "Maximum output tokens", model.maxTokens);
				if (value.changed) setOptional(model, "maxTokens", value.value);
				break;
			}
			case "thinking":
				await editModelThinkingMap(ctx, model);
				break;
			case "api": {
				const value = await chooseApi(ctx, "Model API override", model.api);
				if (value.changed) setOptional(model, "api", value.value);
				break;
			}
			case "cost": {
				const value = await editCost(ctx, model.cost, false);
				if (value.changed) setOptional(model, "cost", value.value);
				break;
			}
			case "compat": {
				const value = await editCompat(ctx, "Model compatibility", model.compat);
				if (value.changed) setOptionalRecord(model, "compat", value.value);
				break;
			}
			case "remove":
				if (await ctx.ui.confirm("Remove model?", `Remove "${model.id}" from this provider?`)) return REMOVE_MODEL;
				break;
		}
	}
}

async function editModelOverrides(
	ctx: ExtensionCommandContext,
	initial: Record<string, ModelOverride> | undefined,
): Promise<EditResult<Record<string, ModelOverride>>> {
	const original = structuredClone(initial ?? {});
	const working = structuredClone(original);

	while (true) {
		const ids = Object.keys(working).sort();
		const options: MenuOption<string>[] = ids.map((id) => ({ key: `override:${id}`, label: `${id} — ${summarizeOverride(working[id]!)}` }));
		options.push(
			{ key: "add", label: "+ Add model override" },
			{ key: "done", label: "Done" },
			{ key: "cancel", label: "Discard override changes" },
		);
		const choice = await selectSearchableKey(ctx, `Model overrides · ${ids.length}`, options);
		if (choice === undefined || choice === "cancel") {
			if (jsonEqual(original, working) || (await ctx.ui.confirm("Discard override changes?", "Unsaved override changes will be lost."))) {
				return { changed: false };
			}
			continue;
		}
		if (choice === "done") return { changed: !jsonEqual(original, working), value: working };
		if (choice === "add") {
			const id = await promptText(ctx, "Model ID to override", "", "provider-model-id", (value) => {
				const trimmed = value.trim();
				if (!trimmed) return "Model ID is required.";
				if (trimmed in working) return "That override already exists.";
				return undefined;
			});
			if (id !== undefined) {
				const updated = await editOverride(ctx, id.trim(), {}, Object.keys(working));
				if (updated !== undefined && updated !== REMOVE_OVERRIDE) working[updated.id] = updated.override;
			}
			continue;
		}
		if (!choice.startsWith("override:")) continue;
		const id = choice.slice("override:".length);
		const updated = await editOverride(ctx, id, working[id]!, ids.filter((candidate) => candidate !== id));
		if (updated === REMOVE_OVERRIDE) delete working[id];
		else if (updated !== undefined) {
			if (updated.id !== id) delete working[id];
			working[updated.id] = updated.override;
		}
	}
}

async function editOverride(
	ctx: ExtensionCommandContext,
	initialId: string,
	initial: ModelOverride,
	otherIds: readonly string[],
): Promise<{ id: string; override: ModelOverride } | typeof REMOVE_OVERRIDE | undefined> {
	const original = { id: initialId, override: structuredClone(initial) };
	let id = initialId;
	const override = structuredClone(initial);

	while (true) {
		const dirty = !jsonEqual(original, { id, override });
		const choice = await selectKey(ctx, `Override · ${id}${dirty ? " · unsaved" : ""}`, [
			{ key: "id", label: `Model ID · ${id}` },
			{ key: "name", label: `Model name · ${override.name ?? "unchanged"}` },
			{ key: "capabilities", label: `Capabilities · ${summarizeCapabilities(override)}` },
			{ key: "limits", label: `Limits · ${summarizeOverrideLimits(override)}` },
			{ key: "advanced", label: `Advanced · ${summarizeOverrideAdvanced(override)}` },
			{ key: "save", label: "Save override" },
			{ key: "remove", label: "Remove override" },
			{ key: "cancel", label: "Discard override changes" },
		]);
		if (choice === undefined || choice === "cancel") {
			if (!dirty || (await ctx.ui.confirm("Discard override changes?", "All unsaved changes will be lost."))) return undefined;
			continue;
		}
		switch (choice) {
			case "id": {
				const value = await promptText(ctx, "Model ID to override", id, "provider-model-id", (candidate) => {
					const trimmed = candidate.trim();
					if (!trimmed) return "Model ID is required.";
					if (trimmed !== initialId && otherIds.includes(trimmed)) return "That override already exists.";
					return undefined;
				});
				if (value !== undefined) id = value.trim();
				break;
			}
			case "name": {
				const value = await promptOptionalText(ctx, "Override model name", override.name);
				if (value.changed) setOptional(override, "name", value.value);
				break;
			}
			case "capabilities":
				await editOverrideCapabilities(ctx, override);
				break;
			case "limits":
				await editOverrideLimits(ctx, override);
				break;
			case "advanced":
				await editOverrideAdvanced(ctx, override);
				break;
			case "remove":
				if (await ctx.ui.confirm("Remove override?", `Remove the override for "${id}"?`)) return REMOVE_OVERRIDE;
				break;
			case "save": {
				if (!id) {
					ctx.ui.notify("Model ID is required.", "error");
					break;
				}
				return { id, override };
			}
		}
	}
}

async function editOverrideCapabilities(ctx: ExtensionCommandContext, override: ModelOverride): Promise<void> {
	while (true) {
		const choice = await selectKey(ctx, "Override capabilities", [
			{ key: "reasoning", label: `Reasoning support · ${formatOptionalBoolean(override.reasoning)}` },
			{ key: "input", label: `Input types · ${formatInput(override.input)}` },
			{ key: "back", label: "Back" },
		]);
		if (choice === undefined || choice === "back") return;
		if (choice === "reasoning") {
			const value = await chooseOptionalBoolean(ctx, "Override reasoning", override.reasoning);
			if (value.changed) setOptional(override, "reasoning", value.value);
		}
		if (choice === "input") {
			const value = await chooseInput(ctx, override.input);
			if (value.changed) setOptional(override, "input", value.value);
		}
	}
}

async function editOverrideLimits(ctx: ExtensionCommandContext, override: ModelOverride): Promise<void> {
	while (true) {
		const choice = await selectKey(ctx, "Override limits", [
			{ key: "context", label: `Context window · ${override.contextWindow?.toLocaleString() ?? "unchanged"}` },
			{ key: "maxTokens", label: `Maximum output tokens · ${override.maxTokens?.toLocaleString() ?? "unchanged"}` },
			{ key: "back", label: "Back" },
		]);
		if (choice === undefined || choice === "back") return;
		if (choice === "context") {
			const value = await promptOptionalInteger(ctx, "Override context window", override.contextWindow);
			if (value.changed) setOptional(override, "contextWindow", value.value);
		}
		if (choice === "maxTokens") {
			const value = await promptOptionalInteger(ctx, "Override max output tokens", override.maxTokens);
			if (value.changed) setOptional(override, "maxTokens", value.value);
		}
	}
}

async function editOverrideAdvanced(ctx: ExtensionCommandContext, override: ModelOverride): Promise<void> {
	while (true) {
		const choice = await selectKey(ctx, "Override advanced settings", [
			{ key: "thinking", label: `Thinking level map · ${countLabel(override.thinkingLevelMap, "level")}` },
			{ key: "cost", label: `Token cost · ${override.cost ? "configured" : "unchanged"}` },
			{ key: "headers", label: `Headers · ${countLabel(override.headers, "header")}` },
			{ key: "compat", label: `Compatibility · ${countLabel(override.compat, "setting")}` },
			{ key: "back", label: "Back" },
		]);
		if (choice === undefined || choice === "back") return;
		if (choice === "thinking") {
			const value = await editThinkingMap(ctx, override.thinkingLevelMap);
			if (value.changed) setOptionalRecord(override, "thinkingLevelMap", value.value);
		}
		if (choice === "cost") {
			const value = await editCost(ctx, override.cost, true);
			if (value.changed) setOptional(override, "cost", value.value);
		}
		if (choice === "headers") {
			const value = await editHeaders(ctx, "Override headers", override.headers);
			if (value.changed) setOptionalRecord(override, "headers", value.value);
		}
		if (choice === "compat") {
			const value = await editCompat(ctx, "Override compatibility", override.compat);
			if (value.changed) setOptionalRecord(override, "compat", value.value);
		}
	}
}

async function editHeaders(
	ctx: ExtensionCommandContext,
	title: string,
	initial: Record<string, string> | undefined,
): Promise<EditResult<Record<string, string>>> {
	const original = structuredClone(initial ?? {});
	const working = structuredClone(original);
	while (true) {
		const names = Object.keys(working).sort();
		const options: MenuOption<string>[] = names.map((name) => ({
			key: `header:${name}`,
			label: `${name}: ${truncate(working[name]!, 60)}`,
		}));
		options.push(
			{ key: "add", label: "+ Add header" },
			{ key: "done", label: "Done" },
			{ key: "cancel", label: "Discard header changes" },
		);
		const choice = await selectKey(ctx, `${title} · ${names.length}`, options);
		if (choice === undefined || choice === "cancel") {
			if (jsonEqual(original, working) || (await ctx.ui.confirm("Discard header changes?", "Unsaved header changes will be lost."))) {
				return { changed: false };
			}
			continue;
		}
		if (choice === "done") return { changed: !jsonEqual(original, working), value: working };
		if (choice === "add") {
			const name = await promptText(ctx, "Header name", "", "x-api-key", (value) => {
				const trimmed = value.trim();
				if (!trimmed) return "Header name is required.";
				if (trimmed in working) return "That header already exists.";
				return undefined;
			});
			if (name === undefined) continue;
			const value = await promptText(ctx, `Header value · ${name.trim()}`, "", "$HEADER_VALUE");
			if (value !== undefined) working[name.trim()] = value;
			continue;
		}
		if (!choice.startsWith("header:")) continue;
		const name = choice.slice("header:".length);
		const action = await selectKey(ctx, name, [
			{ key: "value", label: "Edit value" },
			{ key: "rename", label: "Rename header" },
			{ key: "remove", label: "Remove header" },
			{ key: "back", label: "Back" },
		]);
		if (action === "value") {
			const value = await promptText(ctx, `Header value · ${name}`, working[name] ?? "");
			if (value !== undefined) working[name] = value;
		}
		if (action === "rename") {
			const renamed = await promptText(ctx, "Header name", name, "x-api-key", (value) => {
				const trimmed = value.trim();
				if (!trimmed) return "Header name is required.";
				if (trimmed !== name && trimmed in working) return "That header already exists.";
				return undefined;
			});
			if (renamed !== undefined && renamed.trim() !== name) {
				working[renamed.trim()] = working[name]!;
				delete working[name];
			}
		}
		if (action === "remove") delete working[name];
	}
}

async function editCompat(
	ctx: ExtensionCommandContext,
	title: string,
	initial: Record<string, unknown> | undefined,
): Promise<EditResult<Record<string, unknown>>> {
	const original = structuredClone(initial ?? {});
	const working = structuredClone(original);
	while (true) {
		const keys = Object.keys(working)
			.filter((key) => (COMPAT_FIELDS as readonly string[]).includes(key))
			.sort();
		const preserved = Object.keys(working).length - keys.length;
		const options: MenuOption<string>[] = keys.map((key) => ({
			key: `field:${key}`,
			label: `${key}: ${truncate(JSON.stringify(working[key]), 60)}`,
		}));
		options.push(
			{ key: "known", label: "+ Add documented compatibility field" },
			...(preserved ? [{ key: "preserved", label: `${preserved} undocumented field${preserved === 1 ? "" : "s"} preserved unchanged` }] : []),
			{ key: "done", label: "Done" },
			{ key: "cancel", label: "Discard compatibility changes" },
		);
		const choice = await selectKey(ctx, `${title} · ${keys.length}`, options);
		if (choice === undefined || choice === "cancel") {
			if (jsonEqual(original, working) || (await ctx.ui.confirm("Discard compatibility changes?", "Unsaved compatibility changes will be lost."))) {
				return { changed: false };
			}
			continue;
		}
		if (choice === "done") return { changed: !jsonEqual(original, working), value: working };
		if (choice === "known") {
			const available = COMPAT_FIELDS.filter((field) => !(field in working));
			const selected = await selectKey(
				ctx,
				"Documented compatibility field",
				available.map((field) => ({ key: field, label: field })),
			);
			if (selected) {
				const value = await editCompatValue(ctx, selected, undefined);
				if (value.changed) {
					if (value.value === undefined) delete working[selected];
					else working[selected] = value.value;
				}
			}
			continue;
		}
		if (choice === "preserved") continue;
		if (!choice.startsWith("field:")) continue;
		const key = choice.slice("field:".length);
		const action = await selectKey(ctx, key, [
			{ key: "edit", label: "Edit value" },
			{ key: "remove", label: "Remove field" },
			{ key: "back", label: "Back" },
		]);
		if (action === "edit") {
			const value = await editCompatValue(ctx, key, working[key]);
			if (value.changed) {
				if (value.value === undefined) delete working[key];
				else working[key] = value.value;
			}
		}
		if (action === "remove") delete working[key];
	}
}

async function editCompatValue(ctx: ExtensionCommandContext, key: string, current: unknown): Promise<EditResult<unknown>> {
	if (isLikelyBooleanCompat(key)) {
		const value = await chooseOptionalBoolean(ctx, key, typeof current === "boolean" ? current : undefined);
		return value.changed ? { changed: true, value: value.value } : { changed: false };
	}
	return promptJsonValue(ctx, `Compatibility value · ${key}`, current);
}

async function editThinkingMap(
	ctx: ExtensionCommandContext,
	initial: ThinkingLevelMap | undefined,
): Promise<EditResult<ThinkingLevelMap>> {
	const original = structuredClone(initial ?? {});
	const working = structuredClone(original);
	while (true) {
		const options: MenuOption<string>[] = [
			{ key: "preset", label: "Apply mapping preset" },
			...THINKING_LEVELS.map((level) => ({
				key: level,
				label: summaryRow(level, formatThinkingMapping(level, working[level])),
			})),
		];
		options.push(
			{ key: "done", label: "Done" },
			{ key: "cancel", label: "Discard thinking-map changes" },
		);
		const choice = await selectKey(ctx, "Thinking level mapping · Pi level → provider value", options);
		if (choice === undefined || choice === "cancel") {
			if (jsonEqual(original, working) || (await ctx.ui.confirm("Discard thinking-map changes?", "Unsaved changes will be lost."))) {
				return { changed: false };
			}
			continue;
		}
		if (choice === "done") return { changed: !jsonEqual(original, working), value: working };
		if (choice === "preset") {
			const preset = await selectKey(ctx, "Thinking mapping preset", [
				{ key: "highMax", label: "High / Max only · minimal–high → high, xhigh/max → max" },
				{ key: "identity", label: "Identity through Max · explicitly enable xhigh and max" },
				{ key: "clear", label: "Clear all mappings · restore Pi defaults" },
				{ key: "back", label: "Back" },
			]);
			if (preset === "highMax") applyThinkingPreset(working, "highMax");
			if (preset === "identity") applyThinkingPreset(working, "identity");
			if (preset === "clear") clearThinkingMap(working);
			continue;
		}
		if (!THINKING_LEVELS.includes(choice as ThinkingLevel)) continue;
		const level = choice as ThinkingLevel;
		const action = await selectKey(ctx, `Thinking level · ${level}`, [
			{ key: "value", label: "Map to provider value" },
			{ key: "unsupported", label: "Hide this Pi level" },
			{ key: "unset", label: "Use Pi default" },
			{ key: "back", label: "Back" },
		]);
		if (action === "value") {
			const value = await promptText(ctx, `Provider value · ${level}`, typeof working[level] === "string" ? working[level]! : level);
			if (value !== undefined) working[level] = value;
		}
		if (action === "unsupported") working[level] = null;
		if (action === "unset") delete working[level];
	}
}

async function editModelThinkingMap(ctx: ExtensionCommandContext, model: ModelEntry): Promise<void> {
	if (model.reasoning !== true) {
		if (!(await ctx.ui.confirm("Enable reasoning?", "Thinking-level mappings only take effect when this model supports reasoning."))) return;
	}
	const value = await editThinkingMap(ctx, model.thinkingLevelMap);
	if (!value.changed) return;
	model.reasoning = true;
	setOptionalRecord(model, "thinkingLevelMap", value.value);
}

type BulkThinkingAction =
	| { kind: "unchanged" }
	| { kind: "default" }
	| { kind: "hidden" }
	| { kind: "value"; value: string };

type BulkThinkingActions = Partial<Record<ThinkingLevel, BulkThinkingAction>>;

async function editBulkThinkingMaps(ctx: ExtensionCommandContext, models: ModelEntry[]): Promise<void> {
	if (models.length === 0) return;
	const working: BulkThinkingActions = Object.fromEntries(
		THINKING_LEVELS.map((level) => [level, { kind: "unchanged" }]),
	) as BulkThinkingActions;
	while (true) {
		const options: MenuOption<string>[] = [
			{ key: "preset", label: "Apply mapping preset to selected models" },
			...THINKING_LEVELS.map((level) => ({
				key: level,
				label: summaryRow(level, formatBulkThinkingAction(working[level])),
			})),
			{ key: "done", label: "Apply to selected models" },
			{ key: "cancel", label: "Cancel bulk mapping" },
		];
		const choice = await selectKey(ctx, `Bulk thinking mapping · ${models.length} selected`, options);
		if (choice === undefined || choice === "cancel") return;
		if (choice === "preset") {
			const preset = await selectKey(ctx, "Bulk mapping preset", [
				{ key: "highMax", label: "High / Max only" },
				{ key: "identity", label: "Identity through Max" },
				{ key: "clear", label: "Clear mappings on selected models" },
				{ key: "back", label: "Back" },
			]);
			if (preset === "highMax") applyBulkThinkingPreset(working, "highMax");
			if (preset === "identity") applyBulkThinkingPreset(working, "identity");
			if (preset === "clear") applyBulkThinkingPreset(working, "clear");
			continue;
		}
		if (choice === "done") {
			if (!Object.values(working).some((action) => action?.kind !== "unchanged")) return;
			if (
				models.some((model) => model.reasoning !== true) &&
				!(await ctx.ui.confirm("Enable reasoning on selected models?", "The mapping requires reasoning support and will enable it for every selected model."))
			)
				continue;
			for (const model of models) {
				model.reasoning = true;
				const map = structuredClone(model.thinkingLevelMap ?? {});
				for (const level of THINKING_LEVELS) {
					const action = working[level];
					if (!action || action.kind === "unchanged") continue;
					if (action.kind === "default") delete map[level];
					if (action.kind === "hidden") map[level] = null;
					if (action.kind === "value") map[level] = action.value;
				}
				setOptionalRecord(model, "thinkingLevelMap", map);
			}
			return;
		}
		if (!THINKING_LEVELS.includes(choice as ThinkingLevel)) continue;
		const level = choice as ThinkingLevel;
		const action = await selectKey(ctx, `Bulk mapping · ${level}`, [
			{ key: "unchanged", label: "Leave unchanged" },
			{ key: "default", label: "Use Pi default" },
			{ key: "hidden", label: "Hide this Pi level" },
			{ key: "value", label: "Map to provider value" },
			{ key: "back", label: "Back" },
		]);
		if (action === "unchanged") working[level] = { kind: "unchanged" };
		if (action === "default") working[level] = { kind: "default" };
		if (action === "hidden") working[level] = { kind: "hidden" };
		if (action === "value") {
			const value = await promptText(ctx, `Provider value · ${level}`, level, undefined, (candidate) =>
				candidate.trim() ? undefined : "Provider value cannot be empty.",
			);
			if (value !== undefined) working[level] = { kind: "value", value: value.trim() };
		}
	}
}

async function editCost(
	ctx: ExtensionCommandContext,
	initial: Partial<Cost> | undefined,
	partial: boolean,
): Promise<EditResult<Cost>> {
	const original = structuredClone(initial);
	let working: Partial<Cost> | undefined = initial ? structuredClone(initial) : undefined;
	while (true) {
		const choice = await selectKey(ctx, partial ? "Cost override" : "Model token cost", [
			{ key: "input", label: `Input             ${formatRate(working?.input, partial)}` },
			{ key: "output", label: `Output            ${formatRate(working?.output, partial)}` },
			{ key: "cacheRead", label: `Cache read        ${formatRate(working?.cacheRead, partial)}` },
			{ key: "cacheWrite", label: `Cache write       ${formatRate(working?.cacheWrite, partial)}` },
			{ key: "tiers", label: `Pricing tiers     ${working?.tiers?.length ?? 0}` },
			{ key: "clear", label: "Clear cost configuration" },
			{ key: "done", label: "Done" },
			{ key: "cancel", label: "Discard cost changes" },
		]);
		if (choice === undefined || choice === "cancel") {
			if (jsonEqual(original, working) || (await ctx.ui.confirm("Discard cost changes?", "Unsaved cost changes will be lost."))) {
				return { changed: false };
			}
			continue;
		}
		if (choice === "clear") {
			working = undefined;
			continue;
		}
		if (choice === "done") {
			if (working && !partial) {
				working.input ??= 0;
				working.output ??= 0;
				working.cacheRead ??= 0;
				working.cacheWrite ??= 0;
			}
			return { changed: !jsonEqual(original, working), value: working as Cost | undefined };
		}
		if (choice === "tiers") {
			const value = await editCostTiers(ctx, working?.tiers);
			if (value.changed) {
				working ??= {};
				if (value.value?.length) working.tiers = value.value;
				else delete working.tiers;
			}
			continue;
		}
		if (choice === "input" || choice === "output" || choice === "cacheRead" || choice === "cacheWrite") {
			const value = await promptOptionalNumber(ctx, `Cost · ${choice}`, working?.[choice]);
			if (value.changed) {
				working ??= {};
				if (value.value === undefined) delete working[choice];
				else working[choice] = value.value;
			}
		}
	}
}

async function editCostTiers(
	ctx: ExtensionCommandContext,
	initial: CostTier[] | undefined,
): Promise<EditResult<CostTier[]>> {
	const original = structuredClone(initial ?? []);
	const working = structuredClone(original);
	while (true) {
		const options: MenuOption<string>[] = working.map((tier, index) => ({
			key: `tier:${index}`,
			label: `Above ${tier.inputTokensAbove.toLocaleString()} tokens — in ${tier.input}, out ${tier.output}`,
		}));
		options.push(
			{ key: "add", label: "+ Add pricing tier" },
			{ key: "done", label: "Done" },
			{ key: "cancel", label: "Discard tier changes" },
		);
		const choice = await selectKey(ctx, `Pricing tiers · ${working.length}`, options);
		if (choice === undefined || choice === "cancel") {
			if (jsonEqual(original, working) || (await ctx.ui.confirm("Discard pricing-tier changes?", "Unsaved changes will be lost."))) {
				return { changed: false };
			}
			continue;
		}
		if (choice === "done") return { changed: !jsonEqual(original, working), value: working };
		if (choice === "add") {
			const tier = await editCostTier(ctx, { inputTokensAbove: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			if (tier) working.push(tier);
			continue;
		}
		if (!choice.startsWith("tier:")) continue;
		const index = Number.parseInt(choice.slice("tier:".length), 10);
		const tier = working[index];
		if (!tier) continue;
		const action = await selectKey(ctx, `Tier above ${tier.inputTokensAbove.toLocaleString()}`, [
			{ key: "edit", label: "Edit tier" },
			{ key: "remove", label: "Remove tier" },
			{ key: "back", label: "Back" },
		]);
		if (action === "edit") {
			const updated = await editCostTier(ctx, tier);
			if (updated) working[index] = updated;
		}
		if (action === "remove") working.splice(index, 1);
	}
}

async function editCostTier(ctx: ExtensionCommandContext, initial: CostTier): Promise<CostTier | undefined> {
	const original = structuredClone(initial);
	const tier = structuredClone(initial);
	while (true) {
		const choice = await selectKey(ctx, "Pricing tier", [
			{ key: "threshold", label: `Input tokens above  ${tier.inputTokensAbove}` },
			{ key: "input", label: `Input rate          ${tier.input}` },
			{ key: "output", label: `Output rate         ${tier.output}` },
			{ key: "cacheRead", label: `Cache read rate     ${tier.cacheRead}` },
			{ key: "cacheWrite", label: `Cache write rate    ${tier.cacheWrite}` },
			{ key: "save", label: "Save tier" },
			{ key: "cancel", label: "Discard tier changes" },
		]);
		if (choice === undefined || choice === "cancel") {
			if (jsonEqual(original, tier) || (await ctx.ui.confirm("Discard tier changes?", "Unsaved changes will be lost."))) return undefined;
			continue;
		}
		if (choice === "save") return tier;
		const key = choice === "threshold" ? "inputTokensAbove" : choice;
		if (key === "inputTokensAbove" || key === "input" || key === "output" || key === "cacheRead" || key === "cacheWrite") {
			const value = await promptNumber(ctx, `Pricing tier · ${key}`, tier[key]);
			if (value !== undefined) tier[key] = value;
		}
	}
}

async function chooseApi(ctx: ExtensionCommandContext, title: string, current: string | undefined): Promise<EditResult<string>> {
	const options: MenuOption<string>[] = [{ key: "unset", label: "Default" }];
	for (const api of API_CHOICES) options.push({ key: api.value, label: api.label });
	if (current && !API_CHOICES.some((api) => api.value === current)) options.push({ key: current, label: `Keep current: ${current}` });
	const selected = await selectKey(ctx, title, options);
	if (selected === undefined) return { changed: false };
	const value = selected === "unset" ? undefined : selected;
	return { changed: value !== current, value };
}

async function chooseRequiredApi(
	ctx: ExtensionCommandContext,
	title: string,
	current: string | undefined,
): Promise<EditResult<string>> {
	const options: MenuOption<string>[] = API_CHOICES.map((api) => ({ key: api.value, label: api.label }));
	const selected = await selectKey(ctx, title, options);
	if (selected === undefined) return { changed: false };
	return { changed: selected !== current, value: selected };
}

async function chooseOptionalBoolean(
	ctx: ExtensionCommandContext,
	title: string,
	current: boolean | undefined,
): Promise<EditResult<boolean>> {
	const selected = await selectKey(ctx, title, [
		{ key: "unset", label: "Default" },
		{ key: "true", label: "True" },
		{ key: "false", label: "False" },
	]);
	if (selected === undefined) return { changed: false };
	const value = selected === "unset" ? undefined : selected === "true";
	return { changed: value !== current, value };
}

async function chooseInput(
	ctx: ExtensionCommandContext,
	current: ModelEntry["input"],
): Promise<EditResult<ModelEntry["input"]>> {
	const selected = await selectKey(ctx, "Input types", [
		{ key: "unset", label: "Default · text" },
		{ key: "text", label: "Text only" },
		{ key: "image", label: "Text + image" },
	]);
	if (selected === undefined) return { changed: false };
	const value = selected === "unset" ? undefined : selected === "image" ? (["text", "image"] as const) : (["text"] as const);
	return { changed: !jsonEqual(current, value), value: value ? [...value] : undefined };
}

async function editSecret(ctx: ExtensionCommandContext, current: string | undefined): Promise<EditResult<string>> {
	if (current !== undefined) {
		const action = await selectKey(ctx, `API key · ${formatSecret(current)}`, [
			{ key: "replace", label: "Replace API key config" },
			{ key: "clear", label: "Clear API key config" },
			{ key: "back", label: "Back" },
		]);
		if (action === "clear") return { changed: true };
		if (action !== "replace") return { changed: false };
	}
	const value = await promptText(ctx, "API key config", "", "$PROVIDER_API_KEY", (candidate) =>
		candidate.length > 0 ? undefined : "API key config cannot be empty.",
	);
	return value === undefined ? { changed: false } : { changed: value !== current, value };
}

async function promptOptionalText(
	ctx: ExtensionCommandContext,
	title: string,
	current: string | undefined,
): Promise<EditResult<string>> {
	const value = await promptText(ctx, `${title} · empty clears`, current ?? "");
	if (value === undefined) return { changed: false };
	const normalized = value.trim() || undefined;
	return { changed: normalized !== current, value: normalized };
}

async function promptOptionalUrl(
	ctx: ExtensionCommandContext,
	title: string,
	current: string | undefined,
): Promise<EditResult<string>> {
	const value = await promptText(ctx, `${title} · empty clears`, current ?? "", "https://api.example.com/v1", (candidate) => {
		const trimmed = candidate.trim();
		if (!trimmed) return undefined;
		try {
			const url = new URL(trimmed);
			return url.protocol === "http:" || url.protocol === "https:" ? undefined : "Use an http(s) URL.";
		} catch {
			return "Use a valid http(s) URL.";
		}
	});
	if (value === undefined) return { changed: false };
	const normalized = value.trim() || undefined;
	return { changed: normalized !== current, value: normalized };
}

async function promptRequiredUrl(
	ctx: ExtensionCommandContext,
	title: string,
	current: string | undefined,
): Promise<string | undefined> {
	const value = await promptText(ctx, title, current ?? "", "https://api.example.com/v1", (candidate) => {
		const trimmed = candidate.trim();
		if (!trimmed) return "Base URL is required.";
		return isHttpUrl(trimmed) ? undefined : "Use a valid http(s) URL.";
	});
	return value === undefined ? undefined : value.trim();
}

async function promptOptionalInteger(
	ctx: ExtensionCommandContext,
	title: string,
	current: number | undefined,
): Promise<EditResult<number>> {
	const value = await promptText(ctx, `${title} · empty clears`, current?.toString() ?? "", undefined, (candidate) => {
		if (!candidate.trim()) return undefined;
		const number = Number(candidate);
		return Number.isSafeInteger(number) && number > 0 ? undefined : "Use a positive integer.";
	});
	if (value === undefined) return { changed: false };
	const normalized = value.trim() ? Number(value) : undefined;
	return { changed: normalized !== current, value: normalized };
}

async function promptOptionalNumber(
	ctx: ExtensionCommandContext,
	title: string,
	current: number | undefined,
): Promise<EditResult<number>> {
	const value = await promptText(ctx, `${title} · empty clears`, current?.toString() ?? "", undefined, (candidate) => {
		if (!candidate.trim()) return undefined;
		const number = Number(candidate);
		return Number.isFinite(number) && number >= 0 ? undefined : "Use a non-negative number.";
	});
	if (value === undefined) return { changed: false };
	const normalized = value.trim() ? Number(value) : undefined;
	return { changed: normalized !== current, value: normalized };
}

async function promptNumber(ctx: ExtensionCommandContext, title: string, current: number): Promise<number | undefined> {
	const value = await promptText(ctx, title, current.toString(), undefined, (candidate) => {
		const number = Number(candidate);
		return Number.isFinite(number) && number >= 0 ? undefined : "Use a non-negative number.";
	});
	return value === undefined ? undefined : Number(value);
}

async function promptJsonValue(
	ctx: ExtensionCommandContext,
	title: string,
	current: unknown,
): Promise<EditResult<unknown>> {
	let parsed: unknown;
	const value = await promptText(ctx, `${title} · JSON value`, current === undefined ? "" : JSON.stringify(current), 'true, "value", or {"key":"value"}', (candidate) => {
		if (!candidate.trim()) return "A JSON value is required.";
		try {
			parsed = JSON.parse(candidate);
			return undefined;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	});
	if (value === undefined) return { changed: false };
	return { changed: !jsonEqual(current, parsed), value: parsed };
}

async function promptText(
	ctx: ExtensionCommandContext,
	title: string,
	initial = "",
	placeholder?: string,
	validate?: (value: string) => string | undefined,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		while (true) {
			const hints = [placeholder, initial ? `current: ${initial}` : undefined].filter(Boolean).join(" · ");
			const value = await ctx.ui.input(title, hints || undefined);
			if (value === undefined) return undefined;
			const error = validate?.(value);
			if (!error) return value;
			ctx.ui.notify(error, "error");
		}
	}
	return ctx.ui.custom(createTextInput({ title, initial, placeholder, validate }));
}

function menuCursorMemoryKey(title: string): string {
	let key = title;
	while (true) {
		const stable = key.replace(/ · unsaved$/, "").replace(/ · \d+(?: selected| models?)?$/, "");
		if (stable === key) return key;
		key = stable;
	}
}

async function selectKey<T extends string>(
	ctx: ExtensionCommandContext,
	title: string,
	options: readonly MenuOption<T>[],
	memoryKey = menuCursorMemoryKey(title),
): Promise<T | undefined> {
	if (ctx.mode !== "tui") {
		const labels = options.map((option) => option.label);
		const selected = await ctx.ui.select(title, labels);
		if (selected === undefined) return undefined;
		return options[labels.indexOf(selected)]?.key;
	}
	const selected = await ctx.ui.custom(
		createSearchableSelector({
			title,
			items: options.map((option) => ({
				value: option.key,
				label: option.label,
				searchText: `${option.key} ${option.label}`,
			})),
			initialValue: MENU_CURSOR_MEMORY.get(memoryKey) as T | undefined,
			maxVisible: Math.min(12, Math.max(1, options.length)),
		}),
	);
	if (selected !== undefined) MENU_CURSOR_MEMORY.set(memoryKey, selected);
	return selected;
}

async function selectSearchableKey<T extends string>(
	ctx: ExtensionCommandContext,
	title: string,
	options: readonly MenuOption<T>[],
): Promise<T | undefined> {
	return selectKey(ctx, title, options);
}

async function selectProviderWorkspaceKey(
	ctx: ExtensionCommandContext,
	providerId: string,
	memoryKey: string,
	dirty: boolean,
	options: readonly MenuOption<string>[],
): Promise<string | undefined> {
	const title = `Provider · ${providerId}`;
	if (ctx.mode !== "tui") return selectKey(ctx, `${title}${dirty ? " · unsaved" : ""}`, options, memoryKey);
	const selected = await ctx.ui.custom(
		createSearchableSelector({
			title,
			subtitle: dirty
				? "Unsaved changes · Enter opens · Ctrl+S saves"
				: "Up to date · Enter opens · Ctrl+S saves",
			items: options.map((option) => ({
				value: option.key,
				label: option.label,
				searchText: `${option.key} ${option.label}`,
			})),
			initialValue: MENU_CURSOR_MEMORY.get(memoryKey),
			maxVisible: 12,
			saveValue: "save",
		}),
	);
	if (selected !== undefined) MENU_CURSOR_MEMORY.set(memoryKey, selected);
	return selected;
}

function validateProvider(
	id: string,
	entry: ProviderEntry,
	existingIds: readonly string[],
	initialId: string,
): string[] {
	const errors: string[] = [];
	const idError = validateProviderId(id, existingIds, initialId);
	if (idError) errors.push(idError);
	if (entry.baseUrl !== undefined && !isHttpUrl(entry.baseUrl)) errors.push("Provider base URL must be a valid http(s) URL.");
	if (entry.oauth === "radius" && !entry.baseUrl) errors.push("Radius OAuth requires a base URL.");
	if (entry.models !== undefined && !Array.isArray(entry.models)) errors.push("models must be an array.");
	if (Array.isArray(entry.models)) {
		const seen = new Set<string>();
		for (const model of entry.models) {
			for (const error of validateModel(model, [])) errors.push(`${model.id || "Model"}: ${error}`);
			if (seen.has(model.id)) errors.push(`Duplicate model ID: "${model.id}".`);
			seen.add(model.id);
		}
	}
	return errors;
}

function validateModel(model: ModelEntry, otherIds: readonly string[]): string[] {
	const errors: string[] = [];
	if (!model.id?.trim()) errors.push("Model ID is required.");
	if (otherIds.includes(model.id)) errors.push(`Model ID "${model.id}" already exists.`);
	if (model.contextWindow !== undefined && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0)) {
		errors.push("Context window must be a positive integer.");
	}
	if (model.maxTokens !== undefined && (!Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0)) {
		errors.push("Maximum output tokens must be a positive integer.");
	}
	if (model.cost) {
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			if (!Number.isFinite(model.cost[key]) || model.cost[key] < 0) errors.push(`Cost ${key} must be non-negative.`);
		}
	}
	return errors;
}

function setOptional<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
	if (value === undefined) delete target[key];
	else target[key] = value;
}

function setOptionalRecord<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
	if (value === undefined || (isRecord(value) && Object.keys(value).length === 0)) delete target[key];
	else target[key] = value;
}

function formatApi(api: string | undefined): string {
	return API_CHOICES.find((choice) => choice.value === api)?.label ?? api ?? "Default";
}

function summarizeSetupAuthentication(entry: ProviderEntry): string {
	const environmentVariable = extractEnvironmentVariable(entry.apiKey);
	if (environmentVariable) return `Environment variable · $${environmentVariable}`;
	if (typeof entry.apiKey === "string" && entry.apiKey.startsWith("!")) return "Advanced · command";
	if (typeof entry.apiKey === "string" && entry.apiKey.includes("$")) return "Advanced · interpolation";
	if (typeof entry.apiKey === "string" && entry.apiKey) return "Advanced · literal value";
	return "Configure later · keyless server or /login";
}

function summarizeAuthenticationAdvanced(entry: ProviderEntry): string {
	const parts: string[] = [];
	if (entry.oauth === "radius") parts.push("Radius OAuth");
	if (entry.authHeader !== undefined) parts.push(`Bearer header ${entry.authHeader ? "enabled" : "disabled"}`);
	return parts.length > 0 ? parts.join(" · ") : "Default";
}

function extractEnvironmentVariable(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(value.trim());
	return match?.[1] ?? match?.[2];
}

function suggestEnvironmentVariable(providerId: string): string {
	let prefix = providerId
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!prefix) prefix = "PROVIDER";
	if (/^[0-9]/.test(prefix)) prefix = `PROVIDER_${prefix}`;
	return `${prefix}_API_KEY`;
}

function normalizeEnvironmentVariable(value: string): string {
	const trimmed = value.trim();
	const braced = /^\$\{(.*)\}$/.exec(trimmed);
	if (braced) return braced[1]!.trim();
	return trimmed.startsWith("$") ? trimmed.slice(1).trim() : trimmed;
}

function formatSecret(value: unknown): string {
	if (typeof value !== "string" || !value) return "Not set";
	if (value.startsWith("!")) return `Command · ${truncate(value.slice(1), 32)}`;
	if (value.includes("$")) return `Variable · ${truncate(value, 32)}`;
	return `Literal · ${value.length} chars`;
}

function formatOptionalBoolean(value: boolean | undefined): string {
	return value === undefined ? "Default" : value ? "true" : "false";
}

function formatInput(value: ModelEntry["input"]): string {
	if (!Array.isArray(value)) return "Default · text";
	return value.includes("image") ? "text + image" : "text";
}

function summarizeCapabilities(model: Pick<ModelEntry, "reasoning" | "input">): string {
	const reasoning = model.reasoning === true ? "reasoning" : model.reasoning === false ? "no reasoning" : "default";
	const input = Array.isArray(model.input) && model.input.includes("image") ? "vision" : "text";
	return `${reasoning} · ${input}`;
}

function summarizeOverrideLimits(override: ModelOverride): string {
	const context = override.contextWindow ? `${compactNumber(override.contextWindow)} context` : "context unchanged";
	const output = override.maxTokens ? `${compactNumber(override.maxTokens)} output` : "output unchanged";
	return `${context} · ${output}`;
}

function summarizeOverrideAdvanced(override: ModelOverride): string {
	const parts: string[] = [];
	if (override.thinkingLevelMap && Object.keys(override.thinkingLevelMap).length) parts.push("thinking map");
	if (override.cost) parts.push("cost");
	if (override.headers && Object.keys(override.headers).length) parts.push("headers");
	if (override.compat && Object.keys(override.compat).length) parts.push("compat");
	return parts.length > 0 ? parts.join(", ") : "rare overrides";
}

function summaryRow(label: string, value: string): string {
	return `${label.padEnd(24)} ${truncate(value, 72)}`;
}

function validateProviderId(id: string, existingIds: readonly string[], currentId?: string): string | undefined {
	if (!isValidProviderId(id)) return "Provider ID is required and cannot contain / or control characters.";
	const normalized = id.toLocaleLowerCase();
	const duplicate = existingIds.some(
		(candidate) => candidate !== currentId && candidate.toLocaleLowerCase() === normalized,
	);
	return duplicate ? `Provider "${id}" already exists.` : undefined;
}

function formatThinkingMapping(level: ThinkingLevel, value: string | null | undefined): string {
	if (value === null) return "Hidden";
	if (typeof value === "string") return `→ ${value}`;
	if (level === "xhigh" || level === "max") return "Unmapped";
	return "Pi default";
}

function summarizeThinkingMap(map: ThinkingLevelMap | undefined): string {
	if (!map || Object.keys(map).length === 0) return "Pi defaults";
	const mapped = Object.values(map).filter((value) => typeof value === "string").length;
	const hidden = Object.values(map).filter((value) => value === null).length;
	return [mapped ? `${mapped} mapped` : undefined, hidden ? `${hidden} hidden` : undefined].filter(Boolean).join(" · ") || "Pi defaults";
}

function applyThinkingPreset(map: ThinkingLevelMap, preset: "highMax" | "identity"): void {
	if (preset === "highMax") {
		for (const level of ["minimal", "low", "medium", "high"] as const) map[level] = "high";
		map.xhigh = "max";
		map.max = "max";
		return;
	}
	for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) map[level] = level;
}

function clearThinkingMap(map: ThinkingLevelMap): void {
	for (const level of THINKING_LEVELS) delete map[level];
}

function formatBulkThinkingAction(action: BulkThinkingAction | undefined): string {
	if (!action || action.kind === "unchanged") return "Unchanged";
	if (action.kind === "default") return "Pi default";
	if (action.kind === "hidden") return "Hidden";
	return `→ ${action.value}`;
}

function applyBulkThinkingPreset(
	actions: BulkThinkingActions,
	preset: "highMax" | "identity" | "clear",
): void {
	for (const level of THINKING_LEVELS) actions[level] = { kind: "unchanged" };
	if (preset === "clear") {
		for (const level of THINKING_LEVELS) actions[level] = { kind: "default" };
		return;
	}
	if (preset === "highMax") {
		for (const level of ["minimal", "low", "medium", "high"] as const) actions[level] = { kind: "value", value: "high" };
		actions.xhigh = { kind: "value", value: "max" };
		actions.max = { kind: "value", value: "max" };
		return;
	}
	for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
		actions[level] = { kind: "value", value: level };
	}
}

function formatRate(value: number | undefined, partial: boolean): string {
	return value === undefined ? (partial ? "unchanged" : "default 0") : value.toString();
}

function countLabel(value: unknown, noun: string): string {
	const count = isRecord(value) ? Object.keys(value).length : 0;
	return count === 0 ? "none" : `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function summarizeModelLimitPreset(model: Pick<ModelEntry, "contextWindow" | "maxTokens">): string {
	if (model.contextWindow === undefined && model.maxTokens === undefined) return "Pi fallback";
	return MODEL_LIMIT_PRESETS.find(
		(preset) => preset.contextWindow === model.contextWindow && preset.maxTokens === model.maxTokens,
	)?.label ?? "Custom";
}

function summarizeModel(model: ModelEntry): string {
	const parts: string[] = [];
	if (model.name && model.name !== model.id) parts.push(model.name);
	if (model.reasoning) parts.push("reasoning");
	if (Array.isArray(model.input) && model.input.includes("image")) parts.push("vision");
	if (model.contextWindow) parts.push(`${compactNumber(model.contextWindow)} ctx`);
	return parts.length > 0 ? truncate(parts.join(" · "), 70) : "defaults";
}

function parseModelIds(value: string): string[] {
	return value
		.split(/[,\r\n]+/)
		.map((id) => id.trim())
		.filter(Boolean);
}

function formatUrlLabel(value: string): string {
	try {
		const url = new URL(value);
		return `${url.host}${url.pathname.replace(/\/$/, "")}`;
	} catch {
		return value;
	}
}

function summarizeOverride(override: ModelOverride): string {
	const keys = Object.keys(override);
	return keys.length === 0 ? "empty" : `${keys.length} field${keys.length === 1 ? "" : "s"}`;
}

function compactNumber(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}m`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
	return value.toString();
}

function isLikelyBooleanCompat(key: string): boolean {
	return /^(supports|requires|force|allow|send)/.test(key);
}

function isHttpUrl(value: unknown): boolean {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Structured provider and model editors built from Pi-native dialogs. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { API_CHOICES, DEFAULTS, isValidProviderId, truncate } from "./constants.ts";
import { createTextInput } from "./dialog.ts";
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
	"supportsToolReferences",
	"supportsToolSearch",
] as const;

export interface SaveAttempt {
	ok: boolean;
	error?: string;
}

export interface ProviderEditorOptions {
	mode: "add" | "edit";
	initialId: string;
	initialEntry: ProviderEntry;
	existingIds: readonly string[];
	onSave: (id: string, entry: ProviderEntry) => Promise<SaveAttempt>;
}

export type ProviderEditorResult = { kind: "saved"; id: string } | { kind: "cancel" };

interface MenuOption<T extends string> {
	key: T;
	label: string;
}

interface EditResult<T> {
	changed: boolean;
	value?: T;
}

export async function editProvider(
	ctx: ExtensionCommandContext,
	opts: ProviderEditorOptions,
): Promise<ProviderEditorResult> {
	const initial = { id: opts.initialId, entry: structuredClone(opts.initialEntry) };
	let id = initial.id;
	const entry = structuredClone(initial.entry);

	while (true) {
		const dirty = !jsonEqual(initial, { id, entry });
		const models = Array.isArray(entry.models) ? entry.models : [];
		const choice = await selectKey(ctx, `Provider · ${id || "new"}${dirty ? " · unsaved" : ""}`, [
			{ key: "id", label: `Provider ID          ${id || "required"}` },
			{ key: "name", label: `Display name         ${entry.name ?? "default = ID"}` },
			{ key: "api", label: `Default API          ${formatApi(entry.api)}` },
			{ key: "baseUrl", label: `Base URL             ${entry.baseUrl ?? "not set / inherit"}` },
			{ key: "apiKey", label: `API key config       ${formatSecret(entry.apiKey)}` },
			{ key: "oauth", label: `OAuth                ${entry.oauth ?? "not set"}` },
			{ key: "authHeader", label: `Bearer auth header   ${formatOptionalBoolean(entry.authHeader)}` },
			{ key: "headers", label: `Headers              ${countLabel(entry.headers, "header")}` },
			{ key: "compat", label: `Compatibility        ${countLabel(entry.compat, "setting")}` },
			{ key: "overrides", label: `Model overrides      ${countLabel(entry.modelOverrides, "override")}` },
			{ key: "models", label: `Models               ${models.length} model${models.length === 1 ? "" : "s"}` },
			{ key: "save", label: "Save provider" },
			{ key: "cancel", label: "Discard changes" },
		]);

		if (choice === undefined || choice === "cancel") {
			if (!dirty || (await ctx.ui.confirm("Discard provider changes?", "All unsaved changes will be lost."))) {
				return { kind: "cancel" };
			}
			continue;
		}

		switch (choice) {
			case "id": {
				const value = await promptText(ctx, "Provider ID", id, "my-provider", (candidate) => {
					const trimmed = candidate.trim();
					if (!isValidProviderId(trimmed)) return "Use 1–64 letters, digits, _ or -.";
					if (trimmed !== opts.initialId && opts.existingIds.includes(trimmed)) return "That provider ID already exists.";
					return undefined;
				});
				if (value !== undefined) id = value.trim();
				break;
			}
			case "name": {
				const value = await promptOptionalText(ctx, "Provider display name", entry.name);
				if (value.changed) setOptional(entry, "name", value.value);
				break;
			}
			case "api": {
				const value = await chooseApi(ctx, "Provider default API", entry.api);
				if (value.changed) setOptional(entry, "api", value.value);
				break;
			}
			case "baseUrl": {
				const value = await promptOptionalUrl(ctx, "Provider base URL", entry.baseUrl);
				if (value.changed) setOptional(entry, "baseUrl", value.value);
				break;
			}
			case "apiKey": {
				const value = await editSecret(ctx, entry.apiKey);
				if (value.changed) setOptional(entry, "apiKey", value.value);
				break;
			}
			case "oauth": {
				const selected = await selectKey(ctx, "OAuth", [
					{ key: "unset", label: "Not set" },
					{ key: "radius", label: "Radius OAuth" },
				]);
				if (selected === "unset") delete entry.oauth;
				if (selected === "radius") entry.oauth = "radius";
				break;
			}
			case "authHeader": {
				const value = await chooseOptionalBoolean(ctx, "Authorization: Bearer <apiKey>", entry.authHeader);
				if (value.changed) setOptional(entry, "authHeader", value.value);
				break;
			}
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
			case "models": {
				if (entry.models !== undefined && !Array.isArray(entry.models)) {
					ctx.ui.notify("The existing models field is not an array; fix it externally before using the model menu.", "error");
					break;
				}
				const value = await editModels(ctx, entry.models);
				if (value.changed) setOptionalArray(entry, "models", value.value);
				break;
			}
			case "save": {
				const errors = validateProvider(id, entry, opts.existingIds, opts.initialId);
				if (errors.length > 0) {
					ctx.ui.notify(errors.join("\n"), "error");
					break;
				}
				const result = await opts.onSave(id, structuredClone(entry));
				if (!result.ok) {
					ctx.ui.notify(result.error ?? "Provider could not be saved.", "error");
					break;
				}
				return { kind: "saved", id };
			}
		}
	}
}

async function editModels(
	ctx: ExtensionCommandContext,
	initial: ModelEntry[] | undefined,
): Promise<EditResult<ModelEntry[]>> {
	const original = structuredClone(initial ?? []);
	const working = structuredClone(original);

	while (true) {
		const options: MenuOption<string>[] = working.map((model, index) => ({
			key: `model:${index}`,
			label: `${model.id || "(missing id)"} — ${summarizeModel(model)}`,
		}));
		options.push(
			{ key: "add", label: "+ Add model" },
			{ key: "done", label: "Done" },
			{ key: "cancel", label: "Cancel model changes" },
		);
		const choice = await selectKey(ctx, `Models · ${working.length}`, options);
		if (choice === undefined || choice === "cancel") {
			if (jsonEqual(original, working) || (await ctx.ui.confirm("Discard model changes?", "Unsaved model changes will be lost."))) {
				return { changed: false };
			}
			continue;
		}
		if (choice === "done") return { changed: !jsonEqual(original, working), value: working };
		if (choice === "add") {
			const model = await editModel(ctx, { id: "" }, working.map((entry) => entry.id));
			if (model) working.push(model);
			continue;
		}
		if (!choice.startsWith("model:")) continue;
		const index = Number.parseInt(choice.slice("model:".length), 10);
		const current = working[index];
		if (!current) continue;
		const action = await selectKey(ctx, current.id || `Model ${index + 1}`, [
			{ key: "edit", label: "Edit model fields" },
			{ key: "remove", label: "Remove model" },
			{ key: "back", label: "Back" },
		]);
		if (action === "edit") {
			const updated = await editModel(
				ctx,
				current,
				working.filter((_, candidate) => candidate !== index).map((entry) => entry.id),
			);
			if (updated) working[index] = updated;
		}
		if (action === "remove" && (await ctx.ui.confirm("Remove model?", `Remove "${current.id}" from this provider?`))) {
			working.splice(index, 1);
		}
	}
}

async function editModel(
	ctx: ExtensionCommandContext,
	initial: ModelEntry,
	otherIds: readonly string[],
): Promise<ModelEntry | undefined> {
	const original = structuredClone(initial);
	const model = structuredClone(initial);

	while (true) {
		const dirty = !jsonEqual(original, model);
		const choice = await selectKey(ctx, `Model · ${model.id || "new"}${dirty ? " · unsaved" : ""}`, [
			{ key: "id", label: `Model ID            ${model.id || "required"}` },
			{ key: "name", label: `Display name        ${model.name ?? "default = ID"}` },
			{ key: "api", label: `API override        ${formatApi(model.api)}` },
			{ key: "baseUrl", label: `Base URL override   ${model.baseUrl ?? "inherit"}` },
			{ key: "reasoning", label: `Reasoning           ${formatOptionalBoolean(model.reasoning)}` },
			{ key: "thinking", label: `Thinking map        ${countLabel(model.thinkingLevelMap, "level")}` },
			{ key: "input", label: `Input types         ${formatInput(model.input)}` },
			{ key: "context", label: `Context window      ${model.contextWindow?.toLocaleString() ?? `default ${DEFAULTS.contextWindow.toLocaleString()}`}` },
			{ key: "maxTokens", label: `Max output tokens   ${model.maxTokens?.toLocaleString() ?? `default ${DEFAULTS.maxTokens.toLocaleString()}`}` },
			{ key: "cost", label: `Token cost          ${model.cost ? "configured" : "zero defaults"}` },
			{ key: "headers", label: `Headers             ${countLabel(model.headers, "header")}` },
			{ key: "compat", label: `Compatibility       ${countLabel(model.compat, "setting")}` },
			{ key: "save", label: "Save model" },
			{ key: "cancel", label: "Discard model changes" },
		]);

		if (choice === undefined || choice === "cancel") {
			if (!dirty || (await ctx.ui.confirm("Discard model changes?", "All unsaved changes will be lost."))) return undefined;
			continue;
		}
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
				const value = await promptOptionalText(ctx, "Model display name", model.name);
				if (value.changed) setOptional(model, "name", value.value);
				break;
			}
			case "api": {
				const value = await chooseApi(ctx, "Model API override", model.api);
				if (value.changed) setOptional(model, "api", value.value);
				break;
			}
			case "baseUrl": {
				const value = await promptOptionalUrl(ctx, "Model base URL override", model.baseUrl);
				if (value.changed) setOptional(model, "baseUrl", value.value);
				break;
			}
			case "reasoning": {
				const value = await chooseOptionalBoolean(ctx, "Reasoning support", model.reasoning);
				if (value.changed) setOptional(model, "reasoning", value.value);
				break;
			}
			case "thinking": {
				const value = await editThinkingMap(ctx, model.thinkingLevelMap);
				if (value.changed) setOptionalRecord(model, "thinkingLevelMap", value.value);
				break;
			}
			case "input": {
				const value = await chooseInput(ctx, model.input);
				if (value.changed) setOptional(model, "input", value.value);
				break;
			}
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
			case "cost": {
				const value = await editCost(ctx, model.cost, false);
				if (value.changed) setOptional(model, "cost", value.value);
				break;
			}
			case "headers": {
				const value = await editHeaders(ctx, "Model headers", model.headers);
				if (value.changed) setOptionalRecord(model, "headers", value.value);
				break;
			}
			case "compat": {
				const value = await editCompat(ctx, "Model compatibility", model.compat);
				if (value.changed) setOptionalRecord(model, "compat", value.value);
				break;
			}
			case "save": {
				const errors = validateModel(model, otherIds);
				if (errors.length > 0) {
					ctx.ui.notify(errors.join("\n"), "error");
					break;
				}
				return model;
			}
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
			{ key: "cancel", label: "Cancel override changes" },
		);
		const choice = await selectKey(ctx, `Model overrides · ${ids.length}`, options);
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
				if (updated) working[updated.id] = updated.override;
			}
			continue;
		}
		if (!choice.startsWith("override:")) continue;
		const id = choice.slice("override:".length);
		const action = await selectKey(ctx, id, [
			{ key: "edit", label: "Edit override fields" },
			{ key: "remove", label: "Remove override" },
			{ key: "back", label: "Back" },
		]);
		if (action === "edit") {
			const updated = await editOverride(ctx, id, working[id]!, ids.filter((candidate) => candidate !== id));
			if (updated) {
				if (updated.id !== id) delete working[id];
				working[updated.id] = updated.override;
			}
		}
		if (action === "remove" && (await ctx.ui.confirm("Remove override?", `Remove the override for "${id}"?`))) {
			delete working[id];
		}
	}
}

async function editOverride(
	ctx: ExtensionCommandContext,
	initialId: string,
	initial: ModelOverride,
	otherIds: readonly string[],
): Promise<{ id: string; override: ModelOverride } | undefined> {
	const original = { id: initialId, override: structuredClone(initial) };
	let id = initialId;
	const override = structuredClone(initial);

	while (true) {
		const dirty = !jsonEqual(original, { id, override });
		const choice = await selectKey(ctx, `Override · ${id}${dirty ? " · unsaved" : ""}`, [
			{ key: "id", label: `Model ID            ${id}` },
			{ key: "name", label: `Display name        ${override.name ?? "unchanged"}` },
			{ key: "reasoning", label: `Reasoning           ${formatOptionalBoolean(override.reasoning)}` },
			{ key: "thinking", label: `Thinking map        ${countLabel(override.thinkingLevelMap, "level")}` },
			{ key: "input", label: `Input types         ${formatInput(override.input)}` },
			{ key: "context", label: `Context window      ${override.contextWindow?.toLocaleString() ?? "unchanged"}` },
			{ key: "maxTokens", label: `Max output tokens   ${override.maxTokens?.toLocaleString() ?? "unchanged"}` },
			{ key: "cost", label: `Token cost          ${override.cost ? "configured" : "unchanged"}` },
			{ key: "headers", label: `Headers             ${countLabel(override.headers, "header")}` },
			{ key: "compat", label: `Compatibility       ${countLabel(override.compat, "setting")}` },
			{ key: "save", label: "Save override" },
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
				const value = await promptOptionalText(ctx, "Override display name", override.name);
				if (value.changed) setOptional(override, "name", value.value);
				break;
			}
			case "reasoning": {
				const value = await chooseOptionalBoolean(ctx, "Override reasoning", override.reasoning);
				if (value.changed) setOptional(override, "reasoning", value.value);
				break;
			}
			case "thinking": {
				const value = await editThinkingMap(ctx, override.thinkingLevelMap);
				if (value.changed) setOptionalRecord(override, "thinkingLevelMap", value.value);
				break;
			}
			case "input": {
				const value = await chooseInput(ctx, override.input);
				if (value.changed) setOptional(override, "input", value.value);
				break;
			}
			case "context": {
				const value = await promptOptionalInteger(ctx, "Override context window", override.contextWindow);
				if (value.changed) setOptional(override, "contextWindow", value.value);
				break;
			}
			case "maxTokens": {
				const value = await promptOptionalInteger(ctx, "Override max output tokens", override.maxTokens);
				if (value.changed) setOptional(override, "maxTokens", value.value);
				break;
			}
			case "cost": {
				const value = await editCost(ctx, override.cost, true);
				if (value.changed) setOptional(override, "cost", value.value);
				break;
			}
			case "headers": {
				const value = await editHeaders(ctx, "Override headers", override.headers);
				if (value.changed) setOptionalRecord(override, "headers", value.value);
				break;
			}
			case "compat": {
				const value = await editCompat(ctx, "Override compatibility", override.compat);
				if (value.changed) setOptionalRecord(override, "compat", value.value);
				break;
			}
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
			{ key: "cancel", label: "Cancel header changes" },
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
		const keys = Object.keys(working).sort();
		const options: MenuOption<string>[] = keys.map((key) => ({
			key: `field:${key}`,
			label: `${key}: ${truncate(JSON.stringify(working[key]), 60)}`,
		}));
		options.push(
			{ key: "known", label: "+ Add documented compatibility field" },
			{ key: "custom", label: "+ Add custom compatibility field" },
			{ key: "done", label: "Done" },
			{ key: "cancel", label: "Cancel compatibility changes" },
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
			const selected = await ctx.ui.select("Documented compatibility field", [...available]);
			if (selected) {
				const value = await editCompatValue(ctx, selected, undefined);
				if (value.changed) {
					if (value.value === undefined) delete working[selected];
					else working[selected] = value.value;
				}
			}
			continue;
		}
		if (choice === "custom") {
			const key = await promptText(ctx, "Compatibility field name", "", "providerSpecificOption", (value) => {
				const trimmed = value.trim();
				if (!trimmed) return "Field name is required.";
				if (trimmed in working) return "That field already exists.";
				return undefined;
			});
			if (key !== undefined) {
				const value = await promptJsonValue(ctx, `Value · ${key.trim()}`, undefined);
				if (value.changed) working[key.trim()] = value.value;
			}
			continue;
		}
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
		const options: MenuOption<string>[] = THINKING_LEVELS.map((level) => ({
			key: level,
			label: `${level.padEnd(8)} ${formatThinkingValue(working[level])}`,
		}));
		options.push(
			{ key: "done", label: "Done" },
			{ key: "cancel", label: "Cancel thinking-map changes" },
		);
		const choice = await selectKey(ctx, "Thinking level map", options);
		if (choice === undefined || choice === "cancel") {
			if (jsonEqual(original, working) || (await ctx.ui.confirm("Discard thinking-map changes?", "Unsaved changes will be lost."))) {
				return { changed: false };
			}
			continue;
		}
		if (choice === "done") return { changed: !jsonEqual(original, working), value: working };
		if (!THINKING_LEVELS.includes(choice as ThinkingLevel)) continue;
		const level = choice as ThinkingLevel;
		const action = await selectKey(ctx, `Thinking level · ${level}`, [
			{ key: "value", label: "Set provider value" },
			{ key: "unsupported", label: "Mark unsupported (null)" },
			{ key: "unset", label: "Use default / remove mapping" },
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
			{ key: "cancel", label: "Cancel cost changes" },
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
			{ key: "cancel", label: "Cancel tier changes" },
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
	const options: MenuOption<string>[] = [{ key: "unset", label: "Not set / inherit" }];
	for (const api of API_CHOICES) options.push({ key: api.value, label: api.label });
	if (current && !API_CHOICES.some((api) => api.value === current)) options.push({ key: current, label: `Keep current: ${current}` });
	const selected = await selectKey(ctx, title, options);
	if (selected === undefined) return { changed: false };
	const value = selected === "unset" ? undefined : selected;
	return { changed: value !== current, value };
}

async function chooseOptionalBoolean(
	ctx: ExtensionCommandContext,
	title: string,
	current: boolean | undefined,
): Promise<EditResult<boolean>> {
	const selected = await selectKey(ctx, title, [
		{ key: "unset", label: "Not set / inherit" },
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
		{ key: "unset", label: 'Not set (defaults to ["text"])' },
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
	return ctx.ui.custom(createTextInput({ title, initial, placeholder, validate }));
}

async function selectKey<T extends string>(
	ctx: ExtensionCommandContext,
	title: string,
	options: readonly MenuOption<T>[],
): Promise<T | undefined> {
	const labels = options.map((option) => option.label);
	const selected = await ctx.ui.select(title, labels);
	if (selected === undefined) return undefined;
	return options[labels.indexOf(selected)]?.key;
}

function validateProvider(
	id: string,
	entry: ProviderEntry,
	existingIds: readonly string[],
	initialId: string,
): string[] {
	const errors: string[] = [];
	if (!isValidProviderId(id)) errors.push("Provider ID must use 1–64 letters, digits, _ or -.");
	if (id !== initialId && existingIds.includes(id)) errors.push(`Provider "${id}" already exists.`);
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
	if (model.baseUrl !== undefined && !isHttpUrl(model.baseUrl)) errors.push("Base URL override must be a valid http(s) URL.");
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

function setOptionalArray<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
	if (value === undefined || (Array.isArray(value) && value.length === 0)) delete target[key];
	else target[key] = value;
}

function formatApi(api: string | undefined): string {
	return API_CHOICES.find((choice) => choice.value === api)?.label ?? api ?? "not set / inherit";
}

function formatSecret(value: unknown): string {
	if (typeof value !== "string" || !value) return "not set";
	if (value.startsWith("!")) return `command: ${truncate(value.slice(1), 32)}`;
	if (value.includes("$")) return `environment/interpolated: ${truncate(value, 32)}`;
	return `configured (${value.length} chars)`;
}

function formatOptionalBoolean(value: boolean | undefined): string {
	return value === undefined ? "not set / inherit" : value ? "true" : "false";
}

function formatInput(value: ModelEntry["input"]): string {
	if (!Array.isArray(value)) return "not set / default text";
	return value.includes("image") ? "text + image" : "text";
}

function formatThinkingValue(value: string | null | undefined): string {
	return value === undefined ? "default" : value === null ? "unsupported" : value;
}

function formatRate(value: number | undefined, partial: boolean): string {
	return value === undefined ? (partial ? "unchanged" : "default 0") : value.toString();
}

function countLabel(value: unknown, noun: string): string {
	const count = isRecord(value) ? Object.keys(value).length : 0;
	return count === 0 ? "none" : `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function summarizeModel(model: ModelEntry): string {
	const parts: string[] = [];
	if (model.name && model.name !== model.id) parts.push(model.name);
	if (model.reasoning) parts.push("reasoning");
	if (Array.isArray(model.input) && model.input.includes("image")) parts.push("vision");
	if (model.contextWindow) parts.push(`${compactNumber(model.contextWindow)} ctx`);
	return parts.length > 0 ? truncate(parts.join(" · "), 70) : "defaults";
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

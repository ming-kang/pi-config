/**
 * models — models-form
 *
 * Single-screen menu-driven forms for editing providers and models. The
 * provider form is the top-level screen; the model form is the same
 * primitive reused for each model row. Sub-editors (Input, Confirm,
 * SelectList) are opened as overlays within the same Container tree.
 *
 * One form = one ctx.ui.custom invocation. Nested screens are managed
 * internally by swapping the rendered output.
 *
 * Working state convention: id is held alongside the entry, not inside it
 * (Pi keys providers by id at the JSON object level, not as a field).
 */

import {
	DynamicBorder,
	getSelectListTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Focusable,
	Input,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	API_CHOICES,
	DEFAULTS,
	findApiChoice,
	formatHeaders,
	formatModelLine,
	HINTS,
	isPositiveInteger,
	isValidProviderId,
	isValidUrl,
} from "./constants.ts";
import { createConfirm, createInputPrompt } from "./dialog.ts";
import type { ModelEntry, ProviderEntry } from "./store.ts";

// ============================================================================
// Common result types
// ============================================================================

/** Universal "saved with a value" / "cancelled" envelope. */
export type SavedOrCancel<T> = { saved?: T; cancelled?: true };

// ============================================================================
// Row primitive — declarative spec for a single-screen form
// ============================================================================

export type Row =
	| {
			kind: "field";
			id: string;
			label: string;
			value: () => string;
			description?: string;
			edit: () => EditorFactory;
	  }
	| {
			kind: "action";
			id: string;
			label: string;
			color: "success" | "warning" | "accent";
			activate: () => void;
	  }
	| { kind: "separator" };

export type EditorFactory = (
	tui: TUI,
	theme: Theme,
	kb: unknown,
	done: (result: unknown) => void,
) => Container;

interface RenderState {
	title: string;
	rows: Row[];
	focus: number;
	status?: string;
	dirty: boolean;
}

function renderRows(state: RenderState, theme: Theme, width: number): string[] {
	const lines: string[] = [];
	const dirtyMark = state.dirty ? theme.fg("warning", "  [unsaved]") : "";
	lines.push(theme.fg("accent", theme.bold(state.title)) + dirtyMark);
	lines.push("");
	for (let i = 0; i < state.rows.length; i++) {
		const row = state.rows[i]!;
		const focused = i === state.focus;
		if (row.kind === "separator") {
			lines.push(theme.fg("dim", "  ────────────────────────────────────────────"));
			continue;
		}
		const prefix = focused ? theme.fg("accent", "▶ ") : "  ";
		if (row.kind === "field") {
			const labelText = focused
				? theme.fg("accent", row.label.padEnd(18))
				: theme.fg("text", row.label.padEnd(18));
			const valText = focused
				? theme.fg("accent", row.value())
				: theme.fg("muted", row.value());
			lines.push(`${prefix}${labelText}  ${valText}`);
			if (focused && row.description) {
				for (const dl of wrapText(row.description, Math.max(20, width - 8))) {
					lines.push(theme.fg("muted", `      ${dl}`));
				}
			}
		} else {
			const colorFn = theme.fg.bind(theme, row.color);
			const labelText = focused ? colorFn(theme.bold(row.label)) : colorFn(row.label);
			lines.push(`${prefix}${labelText}`);
		}
	}
	if (state.status) {
		lines.push("");
		lines.push(theme.fg("warning", `  ${state.status}`));
	}
	lines.push("");
	lines.push(theme.fg("dim", `  ${state.dirty ? HINTS.formUnsaved : HINTS.form}`));
	return lines;
}

function wrapText(s: string, max: number): string[] {
	if (max <= 0) return [s];
	if (s.length <= max) return [s];
	const out: string[] = [];
	let rest = s;
	while (rest.length > max) {
		const cut = rest.lastIndexOf(" ", max);
		const idx = cut > max / 2 ? cut : max;
		out.push(rest.slice(0, idx));
		rest = rest.slice(idx).trimStart();
	}
	if (rest) out.push(rest);
	return out;
}

// ============================================================================
// Sub-screen state — a form can have at most one open editor at a time
// ============================================================================

interface SubScreen {
	component: Container;
	onClose: (result: unknown) => void;
}

// ============================================================================
// Provider form — the main entry point
// ============================================================================

export interface ProviderFormOptions {
	mode: "add" | "edit";
	existingIds: string[];
	initialId: string;
	initialEntry: ProviderEntry;
	onSave: (id: string, entry: ProviderEntry) => void;
	onCancel: () => void;
}

interface WorkingProvider {
	id: string;
	entry: ProviderEntry;
}

export function createProviderForm(
	opts: ProviderFormOptions,
): (tui: TUI, theme: Theme, kb: unknown, done: (r: SavedOrCancel<true>) => void) => Container {
	return (tui, theme, _kb, doneOuter) => {
		const working: WorkingProvider = {
			id: opts.initialId,
			entry: JSON.parse(JSON.stringify(opts.initialEntry)),
		};
		working.entry.models ??= [];
		working.entry.headers ??= {};

		let focus = 0;
		let dirty = false;
		let status: string | undefined;
		let sub: SubScreen | null = null;

		const markDirty = () => {
			dirty = true;
			status = undefined;
		};

		const apiChoice = () => findApiChoice(working.entry.api ?? "openai-completions");

		const openSub = (factory: EditorFactory, onResult: (result: unknown) => void) => {
			sub = {
				component: factory(tui, theme, _kb, (result) => {
					const closer = sub?.onClose;
					sub = null;
					closer?.(result);
					onResult(result);
					refresh();
				}),
				onClose: onResult,
			};
			refresh();
		};

		const buildRows = (): Row[] => [
			{
				kind: "field",
				id: "id",
				label: "Provider ID",
				description: "Identifier used in /model <id>/<model>. Allowed: letters, digits, _ and -.",
				value: () => working.id || (opts.mode === "add" ? "(new — pick an id)" : "(unnamed)"),
				edit: () =>
					createInputPrompt({
						title: "Provider ID",
						initial: working.id,
						placeholder: "my-provider",
						validate: (v) => {
							if (!isValidProviderId(v)) return "Use letters/digits/_/- only, ≤ 64 chars.";
							if (opts.mode === "add" && opts.existingIds.includes(v)) return "This id already exists.";
							if (opts.mode === "edit" && v !== opts.initialId && opts.existingIds.includes(v)) {
								return "This id already exists.";
							}
							return undefined;
						},
					}),
			},
			{
				kind: "field",
				id: "api",
				label: "API",
				description: "Determines request format. Use OpenAI-compatible for Ollama/LM Studio/vLLM/etc.",
				value: () => apiChoice()?.label ?? working.entry.api ?? "?",
				edit: () =>
					createSelectEditor(
						"API",
						API_CHOICES.map((c) => ({ value: c.value, label: c.label, description: c.description })),
						working.entry.api,
					),
			},
			{
				kind: "field",
				id: "baseUrl",
				label: "Base URL",
				description: "API endpoint. Required for custom providers.",
				value: () => working.entry.baseUrl ?? "(not set)",
				edit: () =>
					createInputPrompt({
						title: "Base URL",
						initial: working.entry.baseUrl ?? "",
						placeholder: apiChoice()?.baseUrlPlaceholder,
						validate: (v) => (isValidUrl(v) ? undefined : "Must be a valid http(s) URL."),
					}),
			},
			{
				kind: "field",
				id: "apiKey",
				label: "API Key",
				description: "Saved verbatim into models.json (literal, $ENV_VAR, or !command — your choice).",
				value: () => maskKey(working.entry.apiKey),
				edit: () => createInputPrompt({ title: "API Key", initial: working.entry.apiKey ?? "", placeholder: "sk-…" }),
			},
			{
				kind: "field",
				id: "headers",
				label: "Headers",
				description: "Custom request headers. Sub-editor lets you add/edit/remove pairs.",
				value: () => formatHeaders(working.entry.headers),
				edit: () => createHeaderSubEditor(working.entry.headers ?? {}),
			},
			{
				kind: "field",
				id: "models",
				label: "Models",
				description: "Models exposed under this provider. Sub-editor lets you add/edit/remove.",
				value: () => `${working.entry.models?.length ?? 0} model${working.entry.models?.length === 1 ? "" : "s"}`,
				edit: () => createModelListSubEditor(working.entry.models ?? []),
			},
			{ kind: "separator" },
			{
				kind: "action",
				id: "discard",
				label: "Discard changes",
				color: "warning",
				activate: () => {
					openSub(
						createConfirm("Discard changes?", `All unsaved edits to "${working.id}" will be lost.`),
						(answer) => {
							if (answer === "yes") doneOuter({ cancelled: true });
						},
					);
				},
			},
			{
				kind: "action",
				id: "save",
				label: "Save & close",
				color: "success",
				activate: () => {
					const err = validateProvider(working, opts);
					if (err) {
						status = err;
						refresh();
						return;
					}
					opts.onSave(working.id, stripDefaults(working.entry));
					doneOuter({ saved: true });
				},
			},
		];

		const rows = buildRows();

		const applyField = (id: string, value: unknown) => {
			switch (id) {
				case "id":
					working.id = String(value ?? "").trim();
					break;
				case "api":
					working.entry.api = String(value ?? "openai-completions");
					break;
				case "baseUrl":
					working.entry.baseUrl = String(value ?? "").trim();
					break;
				case "apiKey":
					working.entry.apiKey = String(value ?? "");
					break;
				case "headers":
				case "models":
					// Sub-editors mutate the working state by reference; nothing to apply here.
					break;
				default:
					break;
			}
		};

		const container = new Container() as Container & { render: (w: number) => string[] };

		const refresh = () => {
			container.invalidate();
			tui.requestRender();
		};

		container.render = (width: number): string[] => {
			const state: RenderState = {
				title: `Provider · ${working.id || "(unnamed)"}`,
				rows,
				focus,
				status,
				dirty,
			};
			if (sub) {
				return [
					...renderRows(state, theme, width),
					"",
					theme.fg("dim", "  ─── sub-editor ───"),
					...sub.component.render(width),
				];
			}
			return renderRows(state, theme, width);
		};

		container.handleInput = (data: string) => {
			if (sub) {
				sub.component.handleInput?.(data);
				return;
			}
			if (matchesKey(data, Key.down)) {
				focus = moveFocus(rows, focus, 1);
				status = undefined;
				refresh();
				return;
			}
			if (matchesKey(data, Key.up)) {
				focus = moveFocus(rows, focus, -1);
				status = undefined;
				refresh();
				return;
			}
			if (matchesKey(data, Key.shift("tab"))) {
				focus = moveFocus(rows, focus, -1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.tab)) {
				focus = moveFocus(rows, focus, 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter) || data === " ") {
				const row = rows[focus]!;
				if (row.kind === "field") {
					openSub(row.edit(), (result) => {
						if (result && typeof result === "object" && "saved" in (result as object)) {
							const r = result as { saved?: unknown };
							if (r.saved !== undefined) {
								applyField(row.id, r.saved);
								markDirty();
							}
						}
					});
				} else if (row.kind === "action") {
					row.activate();
				}
				return;
			}
			if (matchesKey(data, Key.escape) || data === "\x1b") {
				const saveRow = rows.find((r) => r.kind === "action" && r.id === "save");
				if (saveRow?.kind === "action") saveRow.activate();
				return;
			}
			if (matchesKey(data, Key.ctrl("s"))) {
				const saveRow = rows.find((r) => r.kind === "action" && r.id === "save");
				if (saveRow?.kind === "action") saveRow.activate();
				return;
			}
		};

		return container;
	};
}

// ============================================================================
// Model form (per-model editor)
// ============================================================================

export interface ModelFormOptions {
	onSave: (model: ModelEntry) => void;
	onCancel: () => void;
}

export function createModelForm(
	initial: ModelEntry,
	opts: ModelFormOptions,
): EditorFactory {
	return (tui, theme, _kb, doneOuter) => {
		const working: ModelEntry = JSON.parse(JSON.stringify(initial));
		working.input ??= ["text"];
		working.reasoning ??= false;

		let focus = 0;
		let status: string | undefined;
		let sub: SubScreen | null = null;

		const openSub = (factory: EditorFactory, onResult: (result: unknown) => void) => {
			sub = {
				component: factory(tui, theme, _kb, (result) => {
					const closer = sub?.onClose;
					sub = null;
					closer?.(result);
					onResult(result);
					refresh();
				}),
				onClose: onResult,
			};
			refresh();
		};

		const buildRows = (): Row[] => [
			{
				kind: "field",
				id: "id",
				label: "Model ID",
				description: "Identifier sent to the API.",
				value: () => working.id || "(required)",
				edit: () =>
					createInputPrompt({
						title: "Model ID",
						initial: working.id ?? "",
						placeholder: "claude-sonnet-4-20250514",
						validate: (v) => (v.trim() ? undefined : "Model id is required."),
					}),
			},
			{
				kind: "field",
				id: "name",
				label: "Display name",
				description: "Optional. Defaults to model id.",
				value: () => working.name ?? "(default = id)",
				edit: () => createInputPrompt({ title: "Display name", initial: working.name ?? "" }),
			},
			{
				kind: "field",
				id: "reasoning",
				label: "Reasoning",
				description: "Whether this model supports extended thinking.",
				value: () => (working.reasoning ? "yes" : "no"),
				edit: () =>
					createSelectEditor(
						"Reasoning",
						[
							{ value: "no", label: "No" },
							{ value: "yes", label: "Yes" },
						],
						working.reasoning ? "yes" : "no",
					),
			},
			{
				kind: "field",
				id: "input",
				label: "Image input",
				description: "Whether this model accepts image attachments.",
				value: () => ((working.input ?? []).includes("image") ? "yes" : "no"),
				edit: () =>
					createSelectEditor(
						"Image input",
						[
							{ value: "no", label: "Text only" },
							{ value: "yes", label: "Text + image" },
						],
						(working.input ?? []).includes("image") ? "yes" : "no",
					),
			},
			{
				kind: "field",
				id: "contextWindow",
				label: "Context window",
				description: `Maximum input tokens. Default ${DEFAULTS.contextWindow.toLocaleString()}.`,
				value: () => (working.contextWindow ?? DEFAULTS.contextWindow).toLocaleString(),
				edit: () =>
					createInputPrompt({
						title: "Context window",
						initial: String(working.contextWindow ?? DEFAULTS.contextWindow),
						validate: (v) => {
							const n = Number(v);
							return isPositiveInteger(n) ? undefined : "Must be a positive integer.";
						},
					}),
			},
			{
				kind: "field",
				id: "maxTokens",
				label: "Max output tokens",
				description: `Maximum output tokens. Default ${DEFAULTS.maxTokens.toLocaleString()}.`,
				value: () => (working.maxTokens ?? DEFAULTS.maxTokens).toLocaleString(),
				edit: () =>
					createInputPrompt({
						title: "Max output tokens",
						initial: String(working.maxTokens ?? DEFAULTS.maxTokens),
						validate: (v) => {
							const n = Number(v);
							return isPositiveInteger(n) ? undefined : "Must be a positive integer.";
						},
					}),
			},
			{ kind: "separator" },
			{
				kind: "action",
				id: "discard",
				label: "Discard",
				color: "warning",
				activate: () => {
					openSub(
						createConfirm("Discard model?", `Changes to "${working.id}" will be lost.`),
						(answer) => {
							if (answer === "yes") doneOuter({ cancelled: true });
						},
					);
				},
			},
			{
				kind: "action",
				id: "save",
				label: "Save model",
				color: "success",
				activate: () => {
					if (!working.id?.trim()) {
						status = "Model id is required.";
						refresh();
						return;
					}
					if (working.contextWindow !== undefined && !isPositiveInteger(working.contextWindow)) {
						status = "Context window must be a positive integer.";
						refresh();
						return;
					}
					if (working.maxTokens !== undefined && !isPositiveInteger(working.maxTokens)) {
						status = "Max output tokens must be a positive integer.";
						refresh();
						return;
					}
					const cleaned = stripModelDefaults(working);
					opts.onSave(cleaned);
					doneOuter({ saved: cleaned });
				},
			},
		];

		const rows = buildRows();

		const applyField = (id: string, value: unknown) => {
			switch (id) {
				case "id":
					working.id = String(value ?? "").trim();
					break;
				case "name":
					working.name = String(value ?? "").trim();
					break;
				case "reasoning":
					working.reasoning = value === "yes";
					break;
				case "input":
					working.input = value === "yes" ? ["text", "image"] : ["text"];
					break;
				case "contextWindow":
					working.contextWindow = Number(value);
					break;
				case "maxTokens":
					working.maxTokens = Number(value);
					break;
			}
		};

		const container = new Container() as Container & { render: (w: number) => string[] };
		const refresh = () => {
			container.invalidate();
			tui.requestRender();
		};

		container.render = (width: number): string[] => {
			const state: RenderState = {
				title: `Model · ${working.id || "(unnamed)"}`,
				rows,
				focus,
				status,
				dirty: true,
			};
			if (sub) {
				return [
					...renderRows(state, theme, width),
					"",
					theme.fg("dim", "  ─── sub-editor ───"),
					...sub.component.render(width),
				];
			}
			return renderRows(state, theme, width);
		};

		container.handleInput = (data: string) => {
			if (sub) {
				sub.component.handleInput?.(data);
				return;
			}
			if (matchesKey(data, Key.down)) {
				focus = moveFocus(rows, focus, 1);
				status = undefined;
				refresh();
				return;
			}
			if (matchesKey(data, Key.up)) {
				focus = moveFocus(rows, focus, -1);
				status = undefined;
				refresh();
				return;
			}
			if (matchesKey(data, Key.shift("tab"))) {
				focus = moveFocus(rows, focus, -1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.tab)) {
				focus = moveFocus(rows, focus, 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter) || data === " ") {
				const row = rows[focus]!;
				if (row.kind === "field") {
					openSub(row.edit(), (result) => {
						if (result && typeof result === "object" && "saved" in (result as object)) {
							const r = result as { saved?: unknown };
							if (r.saved !== undefined) {
								applyField(row.id, r.saved);
								status = undefined;
							}
						}
					});
				} else if (row.kind === "action") {
					row.activate();
				}
				return;
			}
			if (matchesKey(data, Key.escape) || data === "\x1b") {
				const saveRow = rows.find((r) => r.kind === "action" && r.id === "save");
				if (saveRow?.kind === "action") saveRow.activate();
				return;
			}
		};

		return container;
	};
}

// ============================================================================
// Headers sub-editor — list of name:value rows + [+ Add]
// ============================================================================

function createHeaderSubEditor(initial: Record<string, string>): EditorFactory {
	return (tui, theme, _kb, doneOuter) => {
		const working: Record<string, string> = { ...initial };
		let focus = 0;
		let sub: SubScreen | null = null;

		const openSub = (factory: EditorFactory, onResult: (result: unknown) => void) => {
			sub = {
				component: factory(tui, theme, _kb, (result) => {
					const closer = sub?.onClose;
					sub = null;
					closer?.(result);
					onResult(result);
					refresh();
				}),
				onClose: onResult,
			};
			refresh();
		};

		const buildRows = (): Row[] => {
			const entries = Object.entries(working);
			const rows: Row[] = entries.map(([name, value], idx) => ({
				kind: "field",
				id: `header-${idx}`,
				label: name,
				description: "Enter to edit · Backspace to delete (when focused)",
				value: () => value || "(empty)",
				edit: () => buildHeaderEditSubmenu(name, working, (newValue) => {
					if (newValue === undefined) {
						delete working[name];
					} else {
						working[name] = newValue;
					}
				}),
			}));
			rows.push({
				kind: "action",
				id: "header-add",
				label: "+ Add header",
				color: "success",
				activate: () => {
					openSub(buildHeaderAddSubmenu(working), (result) => {
						if (result && typeof result === "object" && "saved" in (result as object)) {
							const r = result as { saved?: { name: string; value: string } };
							if (r.saved) {
								working[r.saved.name] = r.saved.value;
							}
						}
					});
				},
			});
			rows.push({
				kind: "action",
				id: "header-done",
				label: "✓ Done",
				color: "accent",
				activate: () => doneOuter({ saved: { ...working } }),
			});
			return rows;
		};

		const rows = buildRows();

		const container = new Container() as Container & { render: (w: number) => string[] };
		const refresh = () => {
			container.invalidate();
			tui.requestRender();
		};

		container.render = (width: number): string[] => {
			const state: RenderState = {
				title: `Headers  ·  ${Object.keys(working).length} entries`,
				rows,
				focus,
				dirty: false,
			};
			if (sub) {
				return [
					...renderRows(state, theme, width),
					"",
					theme.fg("dim", "  ─── sub-editor ───"),
					...sub.component.render(width),
				];
			}
			return renderRows(state, theme, width);
		};

		container.handleInput = (data: string) => {
			if (sub) {
				sub.component.handleInput?.(data);
				return;
			}
			if (matchesKey(data, Key.down)) {
				focus = moveFocus(rows, focus, 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.up)) {
				focus = moveFocus(rows, focus, -1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.shift("tab"))) {
				focus = moveFocus(rows, focus, -1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.tab)) {
				focus = moveFocus(rows, focus, 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				const row = rows[focus];
				if (row?.kind === "field" && row.id.startsWith("header-")) {
					const idx = Number.parseInt(row.id.slice("header-".length), 10);
					const entries = Object.entries(working);
					const entry = entries[idx];
					if (entry) {
						delete working[entry[0]];
						focus = Math.max(0, focus - 1);
						// Rebuild rows after mutation.
						const fresh = buildRows();
						rows.length = 0;
						rows.push(...fresh);
						refresh();
					}
				}
				return;
			}
			if (matchesKey(data, Key.enter) || data === " ") {
				const row = rows[focus]!;
				if (row.kind === "field") {
					openSub(row.edit(), () => {
						const fresh = buildRows();
						rows.length = 0;
						rows.push(...fresh);
					});
				} else if (row.kind === "action") {
					row.activate();
				}
				return;
			}
			if (matchesKey(data, Key.escape) || data === "\x1b") {
				doneOuter({ saved: { ...working } });
				return;
			}
		};

		return container;
	};
}

function buildHeaderEditSubmenu(
	name: string,
	working: Record<string, string>,
	onSave: (newValue: string | undefined) => void,
): EditorFactory {
	return (_tui, theme, _kb, done) => {
		const input = new Input();
		input.setValue(working[name] ?? "");
		const error = new Text("", 0, 0);
		const wrap = new Container();
		wrap.addChild(new DynamicBorder());
		wrap.addChild(new Text(theme.fg("accent", theme.bold(`Header: ${name}`)), 1, 0));
		wrap.addChild(new Spacer(1));
		wrap.addChild(input);
		wrap.addChild(error);
		wrap.addChild(new Spacer(1));
		wrap.addChild(new Text(theme.fg("dim", "  Enter to save (empty deletes) · Esc to cancel"), 0, 0));
		wrap.addChild(new DynamicBorder());

		input.onSubmit = () => {
			const v = input.getValue();
			onSave(v === "" ? undefined : v);
			done({ saved: { name, value: v } });
		};
		input.onEscape = () => done({ cancelled: true });

		wrap.handleInput = (data: string) => {
			error.setText("");
			input.handleInput(data);
		};
		return wrap;
	};
}

function buildHeaderAddSubmenu(working: Record<string, string>): EditorFactory {
	return (_tui, theme, _kb, done) => {
		const input = new Input();
		input.setValue("");
		const error = new Text("", 0, 0);
		const wrap = new Container();
		wrap.addChild(new DynamicBorder());
		wrap.addChild(new Text(theme.fg("accent", theme.bold("New header")), 1, 0));
		wrap.addChild(new Text(theme.fg("muted", '  Format: "name: value"'), 0, 0));
		wrap.addChild(new Spacer(1));
		wrap.addChild(input);
		wrap.addChild(error);
		wrap.addChild(new Spacer(1));
		wrap.addChild(new Text(theme.fg("dim", "  Enter to save · Esc to cancel"), 0, 0));
		wrap.addChild(new DynamicBorder());

		const submit = () => {
			const raw = input.getValue().trim();
			if (!raw) {
				done({ cancelled: true });
				return;
			}
			const idx = raw.indexOf(":");
			if (idx <= 0) {
				error.setText(theme.fg("error", '  Expected "name: value" (e.g. "User-Agent: foo")'));
				return;
			}
			const name = raw.slice(0, idx).trim();
			const value = raw.slice(idx + 1).trim();
			if (!name) {
				error.setText(theme.fg("error", "  Header name is empty"));
				return;
			}
			if (name in working) {
				error.setText(theme.fg("error", `  Header "${name}" already exists — edit it instead`));
				return;
			}
			done({ saved: { name, value } });
		};

		input.onSubmit = () => submit();
		input.onEscape = () => done({ cancelled: true });

		wrap.handleInput = (data: string) => {
			error.setText("");
			input.handleInput(data);
		};
		return wrap;
	};
}

// ============================================================================
// Model list sub-editor — list of models + [+ Add model]
// ============================================================================

function createModelListSubEditor(models: ModelEntry[]): EditorFactory {
	return (tui, theme, _kb, doneOuter) => {
		let focus = 0;
		let sub: SubScreen | null = null;

		const openSub = (factory: EditorFactory, onResult: (result: unknown) => void) => {
			sub = {
				component: factory(tui, theme, _kb, (result) => {
					const closer = sub?.onClose;
					sub = null;
					closer?.(result);
					onResult(result);
					refresh();
				}),
				onClose: onResult,
			};
			refresh();
		};

		const buildRows = (): Row[] => {
			const rows: Row[] = models.map((m, idx) => ({
				kind: "field",
				id: `model-${idx}`,
				label: formatModelLine(m),
				description: "Enter to edit · Backspace to remove",
				value: () => summarizeModel(m),
				edit: () =>
					createModelForm(m, {
						onSave: (updated) => {
							models[idx] = updated;
						},
						onCancel: () => {},
					}),
			}));
			rows.push({
				kind: "action",
				id: "model-add",
				label: "+ Add model",
				color: "success",
				activate: () => {
					openSub(
						createModelForm({ id: "" }, { onSave: (saved) => models.push(saved), onCancel: () => {} }),
						(result) => {
							if (result && typeof result === "object" && "saved" in (result as object)) {
								const r = result as { saved?: ModelEntry };
								if (r.saved && r.saved.id) models.push(r.saved);
							}
							const fresh = buildRows();
							rows.length = 0;
							rows.push(...fresh);
						},
					);
				},
			});
			rows.push({
				kind: "action",
				id: "model-done",
				label: "✓ Done",
				color: "accent",
				activate: () => doneOuter({ saved: models }),
			});
			return rows;
		};

		const rows = buildRows();

		const container = new Container() as Container & { render: (w: number) => string[] };
		const refresh = () => {
			container.invalidate();
			tui.requestRender();
		};

		container.render = (width: number): string[] => {
			const state: RenderState = {
				title: `Models  ·  ${models.length} entr${models.length === 1 ? "y" : "ies"}`,
				rows,
				focus,
				dirty: false,
			};
			if (sub) {
				return [
					...renderRows(state, theme, width),
					"",
					theme.fg("dim", "  ─── sub-editor ───"),
					...sub.component.render(width),
				];
			}
			return renderRows(state, theme, width);
		};

		container.handleInput = (data: string) => {
			if (sub) {
				sub.component.handleInput?.(data);
				return;
			}
			if (matchesKey(data, Key.down)) {
				focus = moveFocus(rows, focus, 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.up)) {
				focus = moveFocus(rows, focus, -1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.shift("tab"))) {
				focus = moveFocus(rows, focus, -1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.tab)) {
				focus = moveFocus(rows, focus, 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				const row = rows[focus];
				if (row?.kind === "field" && row.id.startsWith("model-")) {
					const idx = Number.parseInt(row.id.slice("model-".length), 10);
					if (Number.isFinite(idx) && idx >= 0 && idx < models.length) {
						models.splice(idx, 1);
						focus = Math.max(0, focus - 1);
						const fresh = buildRows();
						rows.length = 0;
						rows.push(...fresh);
						refresh();
					}
				}
				return;
			}
			if (matchesKey(data, Key.enter) || data === " ") {
				const row = rows[focus]!;
				if (row.kind === "field") {
					openSub(row.edit(), () => {
						const fresh = buildRows();
						rows.length = 0;
						rows.push(...fresh);
					});
				} else if (row.kind === "action") {
					row.activate();
				}
				return;
			}
			if (matchesKey(data, Key.escape) || data === "\x1b") {
				doneOuter({ saved: models });
				return;
			}
		};

		return container;
	};
}

// ============================================================================
// Tiny select editor — used for API type, reasoning, image input
// ============================================================================

function createSelectEditor(
	title: string,
	items: Array<{ value: string; label: string; description?: string }>,
	current: string,
): EditorFactory {
	return (_tui, theme, _kb, done) => {
		const selectItems: SelectItem[] = items.map((i) => ({
			value: i.value,
			label: i.label,
			description: i.description,
		}));
		const list = new SelectList(selectItems, Math.min(selectItems.length, 8), getSelectListTheme());
		const idx = items.findIndex((i) => i.value === current);
		if (idx >= 0) list.setSelectedIndex(idx);
		list.onSelect = (item) => done({ saved: item.value });
		list.onCancel = () => done({ cancelled: true });

		const wrap = new Container();
		wrap.addChild(new DynamicBorder());
		wrap.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		wrap.addChild(new Spacer(1));
		wrap.addChild(list);
		wrap.addChild(new Spacer(1));
		wrap.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to cancel"), 0, 0));
		wrap.addChild(new DynamicBorder());
		return wrap;
	};
}

// ============================================================================
// Helpers
// ============================================================================

function moveFocus(rows: Row[], from: number, delta: number): number {
	const n = rows.length;
	if (n === 0) return 0;
	let i = from;
	for (let step = 0; step < n; step++) {
		i = (i + delta + n) % n;
		if (rows[i]!.kind !== "separator") return i;
	}
	return from;
}

function validateProvider(p: WorkingProvider, opts: ProviderFormOptions): string | undefined {
	if (!p.id) return "Provider id is required.";
	if (!isValidProviderId(p.id)) return "Provider id must use letters/digits/_/- only, ≤ 64 chars.";
	if (opts.mode === "add" && opts.existingIds.includes(p.id)) return "This provider id already exists.";
	if (!p.entry.api) return "API is required.";
	if (!p.entry.baseUrl || !isValidUrl(p.entry.baseUrl)) return "Base URL must be a valid http(s) URL.";
	if (!Array.isArray(p.entry.models) || p.entry.models.length === 0) {
		return "At least one model is required — add one in the Models sub-editor.";
	}
	for (const m of p.entry.models) {
		if (!m.id?.trim()) return "Every model needs an id.";
	}
	return undefined;
}

function stripDefaults(entry: ProviderEntry): ProviderEntry {
	const out: ProviderEntry = { ...entry };
	if (!out.name) delete out.name;
	if (!out.baseUrl) delete out.baseUrl;
	if (!out.apiKey) delete out.apiKey;
	if (out.headers && Object.keys(out.headers).length === 0) delete out.headers;
	return out;
}

function stripModelDefaults(entry: ModelEntry): ModelEntry {
	const out: ModelEntry = { id: entry.id };
	if (entry.name && entry.name !== entry.id) out.name = entry.name;
	if (entry.reasoning) out.reasoning = true;
	if ((entry.input ?? ["text"]).includes("image")) out.input = ["text", "image"];
	if (entry.contextWindow && entry.contextWindow !== DEFAULTS.contextWindow) {
		out.contextWindow = entry.contextWindow;
	}
	if (entry.maxTokens && entry.maxTokens !== DEFAULTS.maxTokens) {
		out.maxTokens = entry.maxTokens;
	}
	return out;
}

function summarizeModel(m: ModelEntry): string {
	const parts: string[] = [];
	if (m.reasoning) parts.push("reasoning");
	if ((m.input ?? []).includes("image")) parts.push("vision");
	if (m.contextWindow) parts.push(`${(m.contextWindow / 1000).toFixed(0)}k ctx`);
	if (m.maxTokens) parts.push(`${(m.maxTokens / 1000).toFixed(0)}k out`);
	return parts.join(" · ");
}

function maskKey(k: string | undefined): string {
	if (!k) return "(not set)";
	if (k.length <= 8) return k;
	return `${k.slice(0, 4)}…${k.slice(-4)} (${k.length} chars)`;
}

// Focusable no-op implementations so the Container is composable.
const _focusable: Focusable = {
	focused: false,
};
void _focusable;
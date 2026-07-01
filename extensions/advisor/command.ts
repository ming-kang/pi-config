import { getSupportedThinkingLevels, type Api, type Model, type ThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ADVISOR_TOOL_NAME } from "./constants.ts";
import { findAvailableModel, modelKey, saveAdvisorConfig } from "./config.ts";
import { getAdvisorEffort, getAdvisorModel, setAdvisorEffort, setAdvisorModel } from "./restore.ts";
import { SearchSelectorComponent } from "../shared/search-selector.ts";
import { requireInteractiveUI } from "../shared/extension-ui.ts";

// ============================================================================
// Advisor menu: choice types + item builders
// ============================================================================
//
// The /advisor command's searchable selector uses these builders. They live
// with the command (the only caller) so a reader sees the menu shape next to
// the command that uses it — splitting them into their own file added friction
// without adding clarity.

export type AdvisorMenuChoice =
	| { kind: "model"; modelKey: string }
	| { kind: "no-advisor" }
	| { kind: "manual" };

export interface AdvisorMenuItem {
	choice: AdvisorMenuChoice;
	label: string;
	selectionLabel: string;
	searchText: string;
	detail?: string;
	current?: boolean;
}

function modelChoice(model: Model<Api>, current: boolean): AdvisorMenuItem {
	const key = modelKey(model);
	const label = model.name;
	const detail = key;
	return {
		choice: { kind: "model", modelKey: key },
		label,
		selectionLabel: `${label} (${detail})${current ? " [current]" : ""}`,
		searchText: `${label} ${detail} ${model.provider} ${model.id} ${model.provider}/${model.id} ${current ? "current" : ""}`,
		detail,
		current,
	};
}

function noAdvisorChoice(current: boolean): AdvisorMenuItem {
	return {
		choice: { kind: "no-advisor" },
		label: "No advisor",
		selectionLabel: current ? "No advisor [current]" : "No advisor (disable)",
		searchText: `${current ? "current " : ""}no advisor disable off`,
		detail: "Disables the advisor tool",
		current,
	};
}

function manualChoice(): AdvisorMenuItem {
	return {
		choice: { kind: "manual" },
		label: "Enter provider/model manually",
		selectionLabel: "Enter provider/model manually",
		searchText: "enter provider model manually",
		detail: "Open a provider/model prompt",
	};
}

function sortedModels(models: Model<Api>[]): Model<Api>[] {
	return [...models].sort((a, b) => `${a.provider}/${a.name}`.localeCompare(`${b.provider}/${b.name}`));
}

export function buildAdvisorMenuItems(available: Model<Api>[], current: Model<Api> | undefined): AdvisorMenuItem[] {
	const currentKey = current ? modelKey(current) : undefined;
	const items: AdvisorMenuItem[] = [];
	const ordered = sortedModels(available);

	if (current) {
		items.push(modelChoice(current, true));
		items.push(noAdvisorChoice(false));
		for (const model of ordered) {
			if (modelKey(model) === currentKey) continue;
			items.push(modelChoice(model, false));
		}
	} else {
		items.push(noAdvisorChoice(true));
		for (const model of ordered) {
			items.push(modelChoice(model, false));
		}
	}

	items.push(manualChoice());
	return items;
}

export function formatCurrentReviewerLabel(model: Model<Api> | undefined, effort: ThinkingLevel | undefined): string {
	if (!model) return "No advisor";
	return effort ? `${model.name} · ${effort}` : model.name;
}

// ============================================================================
// /advisor command handler
// ============================================================================

async function pickManualModel(ctx: ExtensionContext): Promise<Model<Api> | undefined> {
	const value = (await ctx.ui.input("Advisor model", "provider/model"))?.trim();
	if (!value) return undefined;
	const model = findAvailableModel(ctx, value);
	if (!model) ctx.ui.notify(`Unknown or unauthenticated model: ${value}`, "warning");
	return model;
}

async function pickEffort(ctx: ExtensionContext, model: Model<Api>): Promise<ThinkingLevel | undefined | "cancelled"> {
	if (!model.reasoning) return undefined;
	const supported = getSupportedThinkingLevels(model).filter((level): level is ThinkingLevel => level !== "off");
	if (supported.length === 0) return undefined;

	const current = getAdvisorEffort();
	const labels = [
		"off",
		...supported.map((level) => {
			const notes: string[] = [];
			if (level === "medium") notes.push("recommended");
			if (level === current) notes.push("current");
			return notes.length ? `${level} (${notes.join(", ")})` : level;
		}),
	];
	const choice = await ctx.ui.select("Advisor effort", labels);
	if (!choice) return "cancelled";
	if (choice === "off") return undefined;
	return choice.split(" ", 1)[0] as ThinkingLevel;
}

/**
 * Keep the advisor tool's active state in sync with whether a reviewer model is
 * configured: add the tool when a model is selected, remove it when not.
 *
 * Advisor is surfaced only through the tool itself (and /advisor notifications);
 * it deliberately writes no footer status, so it never appears in the status line.
 */
function reconcileAdvisorTool(pi: ExtensionAPI, ctx: ExtensionContext, options: { notify?: boolean } = {}): void {
	const advisor = getAdvisorModel();
	const active = pi.getActiveTools();
	const hasAdvisor = active.includes(ADVISOR_TOOL_NAME);

	if (!advisor && hasAdvisor) {
		pi.setActiveTools(active.filter((name) => name !== ADVISOR_TOOL_NAME));
		if (options.notify && ctx.hasUI) ctx.ui.notify("Advisor disabled.", "info");
	} else if (advisor && !hasAdvisor) {
		pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
		if (options.notify && ctx.hasUI) ctx.ui.notify(`Advisor enabled: ${modelKey(advisor)}`, "info");
	}
}

function disableAdvisor(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!saveAdvisorConfig({})) {
		ctx.ui.notify("Failed to save advisor configuration.", "error");
		return;
	}
	setAdvisorModel(undefined);
	setAdvisorEffort(undefined);
	reconcileAdvisorTool(pi, ctx, { notify: true });
}

function enableAdvisor(pi: ExtensionAPI, ctx: ExtensionContext, model: Model<Api>, effort: ThinkingLevel | undefined): void {
	const key = modelKey(model);
	if (!saveAdvisorConfig({ modelKey: key, effort })) {
		ctx.ui.notify("Failed to save advisor configuration.", "error");
		return;
	}
	setAdvisorModel(model);
	setAdvisorEffort(effort);
	reconcileAdvisorTool(pi, ctx, { notify: true });
}

async function pickReviewer(ctx: ExtensionContext): Promise<AdvisorMenuChoice | undefined> {
	const current = getAdvisorModel();
	const items = buildAdvisorMenuItems(ctx.modelRegistry.getAvailable(), current).map((item) => ({
		...item,
		key: item.choice.kind === "model" ? `model:${item.choice.modelKey}` : item.choice.kind,
	}));
	const title = `Advisor reviewer · Currently ${formatCurrentReviewerLabel(current, getAdvisorEffort())}`;

	if (ctx.mode === "tui") {
		return ctx.ui.custom<AdvisorMenuChoice | undefined>(
			(tui, theme, keybindings, done) =>
				new SearchSelectorComponent(
					tui,
					theme,
					keybindings,
					title,
					items,
					done,
					{ noMatchesText: "No matching reviewer models", helpText: "Type to search • Enter to select • Esc to cancel • ↑↓ to move" },
				),
		);
	}

	const labels = items.map((item) => item.selectionLabel ?? item.label);
	const choice = await ctx.ui.select(title, labels);
	if (!choice) return undefined;
	return items.find((item) => (item.selectionLabel ?? item.label) === choice)?.choice;
}

export function registerAdvisorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("advisor", {
		description: "Configure the advisor reviewer model",
		handler: async (_args, ctx) => {
			if (!requireInteractiveUI(ctx, "Advisor configuration")) return;

			const selection = await pickReviewer(ctx);
			if (!selection) return;

			switch (selection.kind) {
				case "no-advisor":
					disableAdvisor(pi, ctx);
					return;
				case "manual": {
					const picked = await pickManualModel(ctx);
					if (!picked) return;
					const effort = await pickEffort(ctx, picked);
					if (effort === "cancelled") return;
					enableAdvisor(pi, ctx, picked, effort);
					return;
				}
				case "model": {
					const picked = findAvailableModel(ctx, selection.modelKey);
					if (!picked) {
						ctx.ui.notify(`Unknown or unauthenticated model: ${selection.modelKey}`, "warning");
						return;
					}
					const effort = await pickEffort(ctx, picked);
					if (effort === "cancelled") return;
					enableAdvisor(pi, ctx, picked, effort);
					return;
				}
			}
		},
	});
}

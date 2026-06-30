import { getSupportedThinkingLevels, type Api, type Model, type ThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { findAvailableModel, modelKey, saveAdvisorConfig } from "./config.ts";
import { buildAdvisorMenuItems, formatCurrentReviewerLabel, type AdvisorMenuChoice } from "./dialog.ts";
import { reconcileAdvisorTool } from "./reconcile.ts";
import { SearchSelectorComponent } from "../shared/search-selector.ts";
import { getAdvisorEffort, getAdvisorModel, setAdvisorEffort, setAdvisorModel } from "./state.ts";

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
		selectionLabel: item.selectionLabel,
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
			if (!ctx.hasUI) {
				ctx.ui.notify("Advisor configuration requires an interactive UI.", "warning");
				return;
			}

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

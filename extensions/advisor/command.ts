import { getSupportedThinkingLevels, type Api, type Model, type ThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { findAvailableModel, modelKey, saveAdvisorConfig } from "./config.ts";
import { reconcileAdvisorTool } from "./reconcile.ts";
import { getAdvisorEffort, getAdvisorModel, setAdvisorEffort, setAdvisorModel } from "./state.ts";

const NO_ADVISOR = "No advisor";
const MANUAL_ENTRY = "Enter provider/model manually";

function modelLabel(model: Model<Api>, currentKey: string | undefined): string {
	const key = modelKey(model);
	const suffix = key === currentKey ? " [current]" : "";
	return `${model.name} (${key})${suffix}`;
}

function parseModelLabel(label: string): string | undefined {
	const match = /\(([^)]+\/[^)]+)\)/.exec(label);
	return match?.[1];
}

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

export function registerAdvisorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("advisor", {
		description: "Configure the advisor reviewer model",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Advisor configuration requires an interactive UI.", "warning");
				return;
			}

			const available = ctx.modelRegistry
				.getAvailable()
				.sort((a, b) => `${a.provider}/${a.name}`.localeCompare(`${b.provider}/${b.name}`));
			const current = getAdvisorModel();
			const currentKey = current ? modelKey(current) : undefined;
			const labels = [
				currentKey ? `${NO_ADVISOR} (disable)` : `${NO_ADVISOR} [current]`,
				...available.map((model) => modelLabel(model, currentKey)),
				MANUAL_ENTRY,
			];

			const choice = await ctx.ui.select("Advisor reviewer", labels);
			if (!choice) return;
			if (choice.startsWith(NO_ADVISOR)) {
				disableAdvisor(pi, ctx);
				return;
			}

			const picked =
				choice === MANUAL_ENTRY ? await pickManualModel(ctx) : findAvailableModel(ctx, parseModelLabel(choice) ?? "");
			if (!picked) return;

			const effort = await pickEffort(ctx, picked);
			if (effort === "cancelled") return;
			enableAdvisor(pi, ctx, picked, effort);
		},
	});
}

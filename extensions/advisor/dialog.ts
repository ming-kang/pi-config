import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai/compat";

import { modelKey } from "./config.ts";

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

export function formatCurrentReviewerLabel(model: Model<Api> | undefined, effort: ThinkingLevel | undefined): string {
	if (!model) return "No advisor";
	return effort ? `${model.name} · ${effort}` : model.name;
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

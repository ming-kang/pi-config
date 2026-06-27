import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai/compat";

let selectedModel: Model<Api> | undefined;
let selectedEffort: ThinkingLevel | undefined;

export function getAdvisorModel(): Model<Api> | undefined {
	return selectedModel;
}

export function setAdvisorModel(model: Model<Api> | undefined): void {
	selectedModel = model;
}

export function getAdvisorEffort(): ThinkingLevel | undefined {
	return selectedEffort;
}

export function setAdvisorEffort(effort: ThinkingLevel | undefined): void {
	selectedEffort = effort;
}

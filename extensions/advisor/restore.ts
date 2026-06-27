import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { findAvailableModel, modelKey, restoreAdvisorConfig } from "./config.ts";
import { reconcileAdvisorTool } from "./reconcile.ts";
import { setAdvisorEffort, setAdvisorModel } from "./state.ts";

export function restoreAdvisorState(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const config = restoreAdvisorConfig();

	// Nothing configured — stay inert, no notification (nothing was lost).
	if (!config.modelKey) {
		setAdvisorModel(undefined);
		setAdvisorEffort(undefined);
		reconcileAdvisorTool(pi, ctx);
		return;
	}

	// Resolve against *authenticated* models only. modelRegistry.find() would also
	// return a model with no auth configured, which would activate the advisor tool
	// while every call fails at getApiKeyAndHeaders — so use the same auth-checked
	// lookup as the /advisor command (findAvailableModel → getAvailable()).
	const model = findAvailableModel(ctx, config.modelKey);
	if (!model) {
		setAdvisorModel(undefined);
		setAdvisorEffort(undefined);
		reconcileAdvisorTool(pi, ctx);
		// Always surface this: a configured-but-unavailable advisor (moved machine,
		// expired auth, removed provider) is a state the user must know about. We
		// notify once per session — restoreAdvisorState runs on each session_start,
		// so there is deliberately no module-level "announced" flag (it would persist
		// across sessions in the shared extension module and silence later sessions).
		if (ctx.hasUI) {
			ctx.ui.notify(`Advisor model unavailable or not authenticated: ${config.modelKey}`, "warning");
		}
		return;
	}

	setAdvisorModel(model);
	setAdvisorEffort(config.effort);
	reconcileAdvisorTool(pi, ctx);
	if (ctx.hasUI) {
		ctx.ui.notify(`Advisor restored: ${modelKey(model)}${config.effort ? ` (${config.effort})` : ""}`, "info");
	}
}

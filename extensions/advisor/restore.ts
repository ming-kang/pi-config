/**
 * restore.ts — restore the advisor reviewer from persisted config, plus the
 * module-level selectedModel / selectedEffort state (the only writer lives
 * here, so get/set belong with the restore function that uses them).
 */
import type { Api, ExtensionAPI, ExtensionContext, Model, ThinkingLevel } from "@earendil-works/pi-coding-agent";

import { ADVISOR_TOOL_NAME } from "./constants.ts";
import { findAvailableModel, modelKey, restoreAdvisorConfig } from "./config.ts";

// ---- module-level selected reviewer state (singleton per process) ----------
//
// The advisor's reviewer is configured in one process at a time. We keep the
// selected model + effort in module-level state so the tool's renderCall and
// execute can read them without re-reading the persisted config on every call.
// The only writer is `restoreAdvisorState` below; the only readers are
// `command.ts` (which calls /advisor), `execute.ts`, and `index.ts#renderCall`.

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

/**
 * Keep the advisor tool's active state in sync with whether a reviewer model is
 * configured: add the tool when a model is selected, remove it when not.
 *
 * Advisor is surfaced only through the tool itself (and /advisor notifications);
 * it deliberately writes no footer status, so it never appears in the status line.
 */
export function reconcileAdvisorTool(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: { notify?: boolean } = {},
): void {
	const advisor = selectedModel;
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

/** Restore the advisor's reviewer from the persisted config. */
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

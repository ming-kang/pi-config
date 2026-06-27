import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ADVISOR_TOOL_NAME } from "./constants.ts";
import { modelKey } from "./config.ts";
import { getAdvisorModel } from "./state.ts";

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

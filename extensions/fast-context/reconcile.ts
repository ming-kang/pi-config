/**
 * Keep `fast_context_search` available to the model only when a key is
 * configured. The tool is always registered, but toggled in/out of the active
 * set — an inactive tool is invisible to the model (its name, description,
 * promptSnippet, and promptGuidelines all drop out of the prompt).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOL_NAME } from "./constants.ts";
import { getApiKey } from "./state.ts";

export function reconcileFastContextTool(pi: ExtensionAPI): void {
	const activeToolNames = pi.getActiveTools();
	const isActive = activeToolNames.includes(TOOL_NAME);
	const shouldBeActive = !!getApiKey();

	if (shouldBeActive && !isActive) {
		pi.setActiveTools([...activeToolNames, TOOL_NAME]);
	} else if (!shouldBeActive && isActive) {
		pi.setActiveTools(activeToolNames.filter((toolName) => toolName !== TOOL_NAME));
	}
}

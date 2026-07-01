/**
 * Keep `fast_context_search` available to the model only when a key is
 * configured. The tool is always registered, but toggled in/out of the active
 * set — an inactive tool is invisible to the model (its name, description,
 * promptSnippet, and promptGuidelines all drop out of the prompt). Mirrors the
 * advisor extension's reconcile pattern.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOL_NAME } from "./constants.ts";
import { getApiKey } from "./state.ts";

export function reconcileFastContextTool(pi: ExtensionAPI): void {
	const hasKey = !!getApiKey();
	const active = pi.getActiveTools();
	const isActive = active.includes(TOOL_NAME);

	if (!hasKey && isActive) {
		pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
	} else if (hasKey && !isActive) {
		pi.setActiveTools([...active, TOOL_NAME]);
	}
}

/**
 * Keep `fast_context_search` available to the model only when a key is
 * configured. The tool is always registered, but toggled in/out of the active
 * set — an inactive tool is invisible to the model (its name, description,
 * promptSnippet, and promptGuidelines all drop out of the prompt). The toggle
 * mechanics live in shared/tool-toggle.ts (also used by advisor).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reconcileToolActive } from "../shared/tool-toggle.ts";
import { TOOL_NAME } from "./constants.ts";
import { getApiKey } from "./state.ts";

export function reconcileFastContextTool(pi: ExtensionAPI): void {
	reconcileToolActive(pi, TOOL_NAME, !!getApiKey());
}

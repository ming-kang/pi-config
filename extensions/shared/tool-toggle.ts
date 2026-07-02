/**
 * tool-toggle.ts — keep a registered tool's ACTIVE state in sync with a
 * predicate.
 *
 * Pattern shared by advisor (active iff a reviewer model is configured) and
 * fast-context (active iff an API key is configured): the tool stays
 * registered, but is toggled in/out of the active set — an inactive tool is
 * invisible to the model (name, description, promptSnippet, and
 * promptGuidelines all drop out of the prompt).
 *
 * Returns what changed so callers can attach their own notifications.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ToolToggleChange = "added" | "removed" | "unchanged";

export function reconcileToolActive(pi: ExtensionAPI, toolName: string, shouldBeActive: boolean): ToolToggleChange {
	const active = pi.getActiveTools();
	const isActive = active.includes(toolName);
	if (!shouldBeActive && isActive) {
		pi.setActiveTools(active.filter((name) => name !== toolName));
		return "removed";
	}
	if (shouldBeActive && !isActive) {
		pi.setActiveTools([...active, toolName]);
		return "added";
	}
	return "unchanged";
}

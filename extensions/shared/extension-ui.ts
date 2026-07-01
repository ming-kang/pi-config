/**
 * extension-ui.ts — small helpers around ExtensionContext / ExtensionUIContext
 * that more than one extension needs.
 *
 *   - isTui(ctx)                          guard for terminal-only renderers
 *   - requireInteractiveUI(ctx, what)     /command handlers: notify + skip if no UI
 *   - appendSoftConstraint(event, ...)    before_agent_start: add a tagged soft prompt block
 *
 * Pure functions, no shared state. Living in shared/ (no index.ts, no pi
 * manifest) so Pi's loader treats it as a pure import target.
 */
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** True when the run is interactive-terminal mode (custom components, widgets, footer are safe). */
export function isTui(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui";
}

/**
 * Guard for `/command` handlers (and any code that calls `ctx.ui.select|confirm|input`):
 * notify the user and return false when the run has no interactive UI.
 *
 * Per AGENTS.md's hasUI guard rule: command handlers notify, lifecycle handlers
 * silent-return, tool execute returns an error result. This helper covers the
 * command-handler case — the most common — in one call.
 */
export function requireInteractiveUI(ctx: ExtensionContext, what: string): boolean {
	if (ctx.hasUI) return true;
	ctx.ui.notify(`${what} requires an interactive UI.`, "warning");
	return false;
}

/**
 * Append a tagged soft constraint to the system prompt, matching the existing
 * `<read_before_edit>` convention. Returns the event-result shape so a caller
 * can simply `return appendSoftConstraint(event, "tag", [...])` from a
 * before_agent_start handler.
 *
 * The block is prefixed with a blank line so the new block sits on its own
 * paragraph; this is the byte-identical layout the prior inline implementation
 * produced.
 */
export function appendSoftConstraint(
	event: BeforeAgentStartEvent,
	xmlTag: string,
	lines: readonly string[],
): BeforeAgentStartEventResult {
	return {
		systemPrompt: [event.systemPrompt, "", `<${xmlTag}>`, ...lines, `</${xmlTag}>`].join("\n"),
	};
}

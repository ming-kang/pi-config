/**
 * Single `/fast-context` command: shows the key on/off status in the dialog
 * title, lets you enter a key (saved to
 * ~/.pi/agent/pi-config/fast-context/config.json), or submit an empty field to
 * clear it. The key is entered through Pi's input box (same as /login) and never
 * echoed back.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CMD, TOOL_LABEL } from "./constants.ts";
import { looksTruncated, TRUNCATED_KEY_HINT } from "./key-format.ts";
import { reconcileFastContextTool } from "./reconcile.ts";
import { clearApiKey, getApiKey, setApiKey } from "./state.ts";
import { keyFilePath } from "./storage.ts";

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand(CMD, {
		description: `Configure ${TOOL_LABEL}: set or clear the Devin API key`,
		handler: async (_args, ctx) => {
			const configured = !!getApiKey();

			if (!ctx.hasUI) {
				ctx.ui.notify(
					configured
						? `${TOOL_LABEL}: key configured (${keyFilePath()}).`
						: `${TOOL_LABEL}: no key. Set FAST_CONTEXT_KEY for headless runs, or run /${CMD} interactively.`,
					configured ? "info" : "warning",
				);
				return;
			}

			const title = configured ? `${TOOL_LABEL} — key configured.` : `${TOOL_LABEL} — no key configured.`;
			ctx.ui.setStatus(
				CMD,
				configured
					? `${TOOL_LABEL}: submit empty to clear the saved key.`
					: `${TOOL_LABEL}: paste a key, or submit empty to keep it disabled.`,
			);
			let value: string | undefined;
			try {
				value = await ctx.ui.input(title);
			} finally {
				ctx.ui.setStatus(CMD, undefined);
			}
			if (value === undefined) return; // cancelled (Esc)

			const trimmed = value.trim();
			if (!trimmed) {
				// Empty submit = clear (only meaningful when a key was set).
				if (configured) {
					clearApiKey();
					reconcileFastContextTool(pi);
					ctx.ui.notify(`${TOOL_LABEL} key cleared — tool disabled (removed ${keyFilePath()}).`, "info");
				} else {
					ctx.ui.notify(`${TOOL_LABEL}: no key entered.`, "info");
				}
				return;
			}

			setApiKey(trimmed);
			reconcileFastContextTool(pi);
			if (looksTruncated(trimmed)) {
				ctx.ui.notify(`${TOOL_LABEL}: ${TRUNCATED_KEY_HINT}`, "warning");
			}
			ctx.ui.notify(`${TOOL_LABEL} key saved — tool enabled → ${keyFilePath()}`, "info");
		},
	});
}

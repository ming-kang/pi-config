/**
 * fast-context — Pi-native semantic code search via Devin's hosted backend.
 *
 * Registers the `fast_context_search` tool plus key-management commands. The
 * Devin key is held in memory only and cleared on session shutdown.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { PROMPT_GUIDELINES, PROMPT_SNIPPET, TOOL_DESCRIPTION, TOOL_LABEL, TOOL_NAME } from "./constants.ts";
import { runFastContextSearch } from "./execute.ts";
import { reconcileFastContextTool } from "./reconcile.ts";
import { renderCall, renderResult } from "./render.ts";
import { FastContextParamsSchema } from "./schema.ts";
import { getApiKey } from "./state.ts";

export default function fastContext(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description: TOOL_DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: FastContextParamsSchema,
		renderShell: "self",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const apiKey = getApiKey();
			if (!apiKey) {
				// Guard rail: reconcileFastContextTool keeps the tool out of the active
				// set while no key exists, so this path is near-unreachable — but when
				// hit, the error must be actionable. Never solicit the key itself.
				return {
					content: [
						{
							type: "text",
							text: `Error: ${TOOL_LABEL} is unavailable: no API key is configured. Ask the user to run /fast-context to configure a key (or set the FAST_CONTEXT_KEY environment variable); never ask the user to paste the key into the conversation.`,
						},
					],
					details: { errorMessage: "no API key configured" },
				};
			}

			onUpdate?.({ content: [{ type: "text", text: "Consulting Devin…" }], details: {} });
			const onProgress = (msg: string) => onUpdate?.({ content: [{ type: "text", text: msg }], details: {} });
			const { text, details } = await runFastContextSearch(params, apiKey, ctx.cwd, signal, onProgress);
			return { content: [{ type: "text", text }], details };
		},

		renderCall,
		renderResult,
	});

	registerCommands(pi);

	// Surface the tool to the model only when a key is configured. The tool is
	// registered above but kept out of the active set until a key exists.
	pi.on("session_start", async () => {
		reconcileFastContextTool(pi);
	});
	pi.on("before_agent_start", async () => {
		reconcileFastContextTool(pi);
	});
}

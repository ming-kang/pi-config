/**
 * deepwiki — Pi-native wrapper for DeepWiki repository documentation.
 *
 * Pi does not expose MCP servers as tools. This extension intentionally exposes
 * only one DeepWiki-specific tool and hard-codes DeepWiki's public operations.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEEPWIKI_DESCRIPTION,
	DEEPWIKI_LABEL,
	DEEPWIKI_PROMPT_GUIDELINES,
	DEEPWIKI_PROMPT_SNIPPET,
	DEEPWIKI_TOOL_NAME,
} from "./constants.ts";

import { executeDeepWiki } from "./execute.ts";
import { DeepWikiParamsSchema, normalizeDeepWikiParams } from "./schema.ts";

export default function deepwiki(pi: ExtensionAPI): void {
	pi.registerTool({
		name: DEEPWIKI_TOOL_NAME,
		label: DEEPWIKI_LABEL,
		description: DEEPWIKI_DESCRIPTION,
		promptSnippet: DEEPWIKI_PROMPT_SNIPPET,
		promptGuidelines: DEEPWIKI_PROMPT_GUIDELINES,
		parameters: DeepWikiParamsSchema,
		prepareArguments: normalizeDeepWikiParams,

		async execute(_toolCallId, params, signal, onUpdate) {
			return executeDeepWiki(params, signal, onUpdate);
		},
	});
}

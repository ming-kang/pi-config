/**
 * The single seam where this package touches Pi's own tooling.
 *
 * Instead of bundling `@vscode/ripgrep`, the rg restricted command is served by
 * Pi's built-in grep tool, which locates/downloads ripgrep itself and is
 * gitignore-aware. Pi's grep emits root-relative `path:line: text`; the executor
 * remaps those into /codebase paths.
 *
 * Known tradeoff: Pi's grep accepts a single `glob`, so the upstream multi-glob
 * include/exclude collapses to the first include. Default noise dirs overlap
 * heavily with .gitignore, which Pi's grep already honors.
 */
import { createGrepToolDefinition } from "@earendil-works/pi-coding-agent";
import type { GrepFn } from "./executor.ts";

interface GrepResult {
	content?: Array<{ type?: string; text?: string }>;
}

export function createPiGrepFn(realRoot: string): GrepFn {
	const grep = createGrepToolDefinition(realRoot);
	return async (pattern, realPath, glob, signal) => {
		const res = (await grep.execute(
			"fc-rg",
			{ pattern, path: realPath, glob, limit: 50 },
			signal,
		)) as GrepResult;
		const block = (res.content ?? []).find((c) => c?.type === "text");
		return block?.text ?? "";
	};
}

/**
 * Native directory-tree rendering — a plain `node:fs` walk that replaces the
 * upstream `tree-node-cli` dependency, keeping this package dependency-free.
 *
 * This module is the low-level renderer used by the `tree` restricted command
 * (executor.ts) and by the repo-map builder (repo-map.ts), which assembles the
 * orientation map sent to Devin's backend. The exclude helpers below are shared
 * with repo-map.ts so the classic and hotspot maps hide the same noise dirs.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Noise directories hidden from the repo map by default — the canonical list
 * lives in excludes.ts (shared with directory-scorer.ts so the tree and the
 * hotspot ranking always hide the same names). Re-exported here so repo-map.ts
 * and selftests keep importing it from the tree module.
 */
export { DEFAULT_EXCLUDES } from "./excludes.ts";

/** Payload budget for a rendered repo map (~server limit minus overhead). */
export const MAX_TREE_BYTES = 250 * 1024;

/**
 * Extract simple directory-name patterns from the project's `.gitignore` (and
 * `.git/info/exclude`) so the repo map also skips project-specific build /
 * generated dirs on top of DEFAULT_EXCLUDES — aligning the orientation tree
 * with what Pi's gitignore-aware rg actually searches.
 *
 * Deliberately conservative: only bare, single-segment names are honored.
 * Negations (`!…`), globs (`*?[]`), and patterns with embedded path separators
 * are skipped. Anything not confidently a plain directory name is left visible,
 * so this can only declutter the tree — it never hides real source that the
 * fixed list wouldn't have hidden anyway. Matching is name-based at every depth
 * (like DEFAULT_EXCLUDES), so root-anchored patterns like `/dist` apply repo-wide;
 * for an orientation tree that is the desired behavior.
 */
export function gitignoreDirNames(realRoot: string): string[] {
	const names: string[] = [];
	for (const rel of [".gitignore", join(".git", "info", "exclude")]) {
		let text: string;
		try {
			text = readFileSync(join(realRoot, rel), "utf-8");
		} catch {
			continue; // file absent or unreadable — fine
		}
		for (const raw of text.split("\n")) {
			const line = raw.trim();
			if (!line || line.startsWith("#") || line.startsWith("!")) continue;
			// Strip leading anchor `/` and trailing dir-marker `/`, then require a
			// single glob-free path segment.
			const p = line.replace(/^\/+/, "").replace(/\/+$/, "");
			if (!p || p.includes("/") || /[*?[\]]/.test(p)) continue;
			names.push(p);
		}
	}
	return names;
}

export interface TreeOptions {
	maxDepth?: number;
	exclude?: (name: string) => boolean;
}

/** Render a tree rooted at `realRoot`, with `label` as the first (root) line. */
export function renderTree(realRoot: string, label: string, opts: TreeOptions = {}): string {
	const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
	const exclude = opts.exclude ?? (() => false);
	const lines: string[] = [label];

	const walk = (dir: string, depth: number, prefix: string): void => {
		if (depth >= maxDepth) return;
		let names: string[];
		try {
			names = readdirSync(dir)
				.filter((n) => !exclude(n))
				.sort();
		} catch {
			return;
		}
		names.forEach((name, idx) => {
			const last = idx === names.length - 1;
			lines.push(prefix + (last ? "└── " : "├── ") + name);
			let isDir = false;
			try {
				isDir = statSync(join(dir, name)).isDirectory();
			} catch {
				// unreadable — don't recurse
			}
			if (isDir) walk(join(dir, name), depth + 1, prefix + (last ? "    " : "│   "));
		});
	};

	walk(realRoot, 0, "");
	return lines.join("\n");
}

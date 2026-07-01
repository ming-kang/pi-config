/**
 * Repo-map builder — assembles the orientation map Devin's backend sees.
 *
 * Two strategies:
 *   - "classic"  → a single adaptive tree at the requested depth, falling back
 *     to shallower depths until it fits the payload budget (the original behavior).
 *   - "hotspot"  → a shallow base tree of the whole repo, plus deeper subtrees
 *     for the directories `directory-scorer.ts` ranks most relevant to the query,
 *     plus a list of high-signal file paths. Keeps big monorepos under budget by
 *     spending depth only where it matters. This is the default.
 *
 * Pure filesystem reads inside the project root; the optional probe grep is an
 * injected function (Pi's grep), threaded down to the scorer.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type ProbeFn, scoreDirectories } from "./directory-scorer.ts";
import { DEFAULT_EXCLUDES, gitignoreDirNames, MAX_TREE_BYTES, renderTree } from "./tree.ts";

export interface HotspotConfig {
	/** Depth of the shallow whole-repo base tree (FC_HOTSPOT_BASE_DEPTH). */
	baseDepth: number;
	/** Preferred number of hotspot directories (FC_HOTSPOT_TOP_K). */
	topK: number;
	/** Depth of each hotspot subtree (FC_HOTSPOT_TREE_DEPTH; raised by tree_depth). */
	hotspotDepth: number;
	/** Byte budget for the assembled map (FC_HOTSPOT_MAX_BYTES). */
	maxBytes: number;
}

export interface RepoMapOptions {
	mode: "classic" | "hotspot";
	query: string;
	/** User-requested tree depth; 0 = auto. In hotspot mode it raises subtree depth. */
	treeDepth: number;
	excludePaths: string[];
	probeFn?: ProbeFn;
	hotspot: HotspotConfig;
	signal?: AbortSignal;
}

export interface RepoMap {
	tree: string;
	depth: number;
	hotspotDepth?: number;
	sizeBytes: number;
	fellBack: boolean;
	strategy: "classic" | "hotspot";
	hotDirs: string[];
}

/** Merge built-in, gitignore, and user excludes into a name predicate. */
function buildExclude(realRoot: string, excludePaths: string[]): (name: string) => boolean {
	const set = new Set([...DEFAULT_EXCLUDES, ...gitignoreDirNames(realRoot), ...excludePaths]);
	return (name) => set.has(name);
}

/** Heuristic auto depth from the root's entry count (tree_depth = 0). */
function suggestDepth(realRoot: string): number {
	let count = 0;
	try {
		count = readdirSync(realRoot).length;
	} catch {
		// unreadable — fall through to the medium default
	}
	if (count < 500) return 4;
	if (count <= 5000) return 3;
	return 2;
}

/** Render at `targetDepth`, falling back to shallower depths until under budget. */
function renderBudgeted(
	realRoot: string,
	label: string,
	targetDepth: number,
	exclude: (name: string) => boolean,
): { tree: string; depth: number; fellBack: boolean } {
	for (let depth = targetDepth; depth >= 1; depth--) {
		const tree = renderTree(realRoot, label, { maxDepth: depth, exclude });
		if (Buffer.byteLength(tree, "utf-8") <= MAX_TREE_BYTES) {
			return { tree, depth, fellBack: depth < targetDepth };
		}
	}
	const tree = renderTree(realRoot, label, { maxDepth: 1, exclude });
	return { tree, depth: 1, fellBack: true };
}

/** Immediate subdirectories of the root, minus excluded names. */
function listTopLevelDirs(realRoot: string, exclude: (name: string) => boolean): string[] {
	let entries: string[];
	try {
		entries = readdirSync(realRoot).sort();
	} catch {
		return [];
	}
	const dirs: string[] = [];
	for (const name of entries) {
		if (exclude(name)) continue;
		try {
			if (statSync(join(realRoot, name)).isDirectory()) dirs.push(name);
		} catch {
			// unreadable — skip
		}
	}
	return dirs;
}

function buildClassic(realRoot: string, label: string, opts: RepoMapOptions, exclude: (name: string) => boolean): RepoMap {
	const target = opts.treeDepth === 0 ? suggestDepth(realRoot) : opts.treeDepth;
	const { tree, depth, fellBack } = renderBudgeted(realRoot, label, target, exclude);
	return { tree, depth, sizeBytes: Buffer.byteLength(tree, "utf-8"), fellBack, strategy: "classic", hotDirs: [] };
}

async function buildHotspot(realRoot: string, label: string, opts: RepoMapOptions, exclude: (name: string) => boolean): Promise<RepoMap> {
	const cfg = opts.hotspot;
	const base = renderBudgeted(realRoot, label, cfg.baseDepth, exclude);
	const topDirs = listTopLevelDirs(realRoot, exclude);

	// Nothing to drill into — the shallow base tree IS the map.
	if (topDirs.length === 0) {
		return { tree: base.tree, depth: base.depth, sizeBytes: Buffer.byteLength(base.tree, "utf-8"), fellBack: base.fellBack, strategy: "hotspot", hotDirs: [] };
	}

	// tree_depth raises the hotspot subtree depth so the user param isn't ignored.
	const hotspotDepth = opts.treeDepth > cfg.hotspotDepth ? Math.min(4, opts.treeDepth) : cfg.hotspotDepth;

	let hotDirs: string[] = [];
	let pathSpines: string[] = [];
	try {
		const scored = await scoreDirectories(opts.query, realRoot, topDirs, [...gitignoreDirNames(realRoot), ...opts.excludePaths], {
			topK: cfg.topK,
			probeFn: opts.probeFn,
			minReturn: 2,
			signal: opts.signal,
		});
		hotDirs = scored.hotDirs;
		pathSpines = scored.pathSpines;
	} catch {
		// Scoring is best-effort — fall back to the base tree alone.
		return { tree: base.tree, depth: base.depth, sizeBytes: Buffer.byteLength(base.tree, "utf-8"), fellBack: base.fellBack, strategy: "hotspot", hotDirs: [] };
	}

	const hotspotEntries = hotDirs.map((dir) => ({
		dir,
		tree: renderTree(join(realRoot, dir), `${label}/${dir}`, { maxDepth: hotspotDepth, exclude }),
	}));
	const spineSection = pathSpines.length
		? `# Relevant File Paths (high-signal candidates)\n${pathSpines.map((p) => `- ${label}/${p.replace(/\\/g, "/")}`).join("\n")}`
		: "";

	const assemble = (subtrees: Array<{ dir: string; tree: string }>, spine: string): string => {
		const sections: string[] = [];
		if (subtrees.length) sections.push(`# Hotspot Subtrees\n${subtrees.map((s) => s.tree).join("\n\n")}`);
		if (spine) sections.push(spine);
		return sections.length ? `${base.tree}\n\n${sections.join("\n\n")}` : base.tree;
	};

	let kept = [...hotspotEntries];
	let tree = assemble(kept, spineSection);
	let sizeBytes = Buffer.byteLength(tree, "utf-8");

	// Keep the map under budget: drop path spines first, then pop hotspot subtrees.
	if (sizeBytes > cfg.maxBytes) {
		if (spineSection) {
			tree = assemble(kept, "");
			sizeBytes = Buffer.byteLength(tree, "utf-8");
		}
		while (sizeBytes > cfg.maxBytes && kept.length > 0) {
			kept.pop();
			tree = assemble(kept, "");
			sizeBytes = Buffer.byteLength(tree, "utf-8");
		}
	}

	return { tree, depth: base.depth, hotspotDepth, sizeBytes, fellBack: base.fellBack, strategy: "hotspot", hotDirs: kept.map((h) => h.dir) };
}

/**
 * Build the repo map for `realRoot`, labeled `label` (the virtual root). Hotspot
 * mode is async (it scores directories); classic mode is synchronous but wrapped
 * in the same Promise return for a single call site.
 */
export async function buildRepoMap(realRoot: string, label: string, opts: RepoMapOptions): Promise<RepoMap> {
	const exclude = buildExclude(realRoot, opts.excludePaths);
	if (opts.mode === "classic") return buildClassic(realRoot, label, opts, exclude);
	return buildHotspot(realRoot, label, opts, exclude);
}

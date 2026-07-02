/**
 * Canonical noise-directory list shared by the repo-map tree (tree.ts) and the
 * hotspot scorer (directory-scorer.ts). One list so a directory can never be
 * scored but hidden from the tree (or vice versa).
 *
 * NOT consumed by prompt.ts: the backend system prompt is ported verbatim from
 * upstream core.mjs and tuned for the swe-grep model, so its exclude advice
 * stays byte-identical to upstream by design (see prompt.ts header).
 *
 * Pure data — no imports; node-testable.
 */

/**
 * Union of the previously divergent tree/scorer lists. The model can still
 * search inside these with an explicit rg path — excludes only declutter the
 * orientation tree and keep noise out of hotspot profiling.
 */
export const DEFAULT_EXCLUDES: readonly string[] = [
	"node_modules",
	".git",
	"dist",
	"build",
	"coverage",
	".venv",
	"venv",
	"target",
	"out",
	".cache",
	"__pycache__",
	"vendor",
	"deps",
	"third_party",
	"logs",
	"data",
	".next",
	".nuxt",
	".turbo",
	".idea",
	"bundle",
	"bundled",
	"fixtures",
];

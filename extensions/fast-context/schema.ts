import { type Static, Type } from "typebox";

export const FastContextParamsSchema = Type.Object({
	query: Type.String({
		description:
			"Natural-language code search query, preferably in English. Describe the behavior, flow, error, API, or concept to locate; do not pass a bare exact symbol or filename.",
	}),
	project_path: Type.Optional(
		Type.String({
			description:
				"Optional relative or absolute path to a package/subtree to search. Must resolve inside the current working directory. Defaults to cwd; narrow this for monorepos.",
		}),
	),
	tree_depth: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: 6,
			description:
				"Repo-map tree depth (0-6, default 3; 0 = auto). Use 1-2 for huge repos, 3 for most repos, 4-6 only for small focused projects.",
		}),
	),
	max_turns: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 5,
			description:
				"Search rounds (1-5, default 3). Use 1-2 for quick orientation, 3 for normal searches, 4-5 for complex cross-module tracing.",
		}),
	),
	max_results: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 30,
			description: "Maximum files to return (1-30, default 10). Prefer 3-8 for focused implementation work; increase only for broad exploration.",
		}),
	),
	exclude_paths: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Directory/file names to exclude from the repo map and hotspot scoring. Defaults already hide common noise and simple .gitignore dirs; add generated/vendor/build outputs when needed.",
		}),
	),
});

export type FastContextParams = Static<typeof FastContextParamsSchema>;

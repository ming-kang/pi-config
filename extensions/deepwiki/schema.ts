import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const DEEPWIKI_ACTIONS = ["structure", "contents", "question"] as const;
const MAX_QUESTION_REPOS = 10;

const DeepWikiActionSchema = StringEnum(DEEPWIKI_ACTIONS, {
	description:
		"DeepWiki operation: structure lists generated wiki pages for one repo, contents reads the full generated wiki for one repo, and question answers focused repo/reference/comparison questions across up to 10 repos.",
});

export const DeepWikiParamsSchema = Type.Object({
	action: DeepWikiActionSchema,
	repoName: Type.Union([
		Type.String({
			minLength: 1,
			description:
				'Public GitHub repo in "owner/repo" format. GitHub or DeepWiki URLs are accepted fallbacks, but owner/repo is preferred; use one repo for structure/contents.',
		}),
		Type.Array(
			Type.String({
				minLength: 1,
				description: 'Public GitHub repo in "owner/repo" format.',
			}),
			{
				minItems: 1,
				maxItems: MAX_QUESTION_REPOS,
				description:
					"Only for action question: compare patterns, APIs, architecture, or implementation approaches across 1-10 public GitHub repositories.",
			},
		),
	]),
	question: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"Required for action question. Ask a focused question about architecture, APIs, implementation patterns, extension points, onboarding, or cross-repo comparison.",
		}),
	),
});

export type DeepWikiAction = (typeof DEEPWIKI_ACTIONS)[number];
export type DeepWikiParams = Static<typeof DeepWikiParamsSchema>;

const ACTION_ALIASES: Record<string, DeepWikiAction> = {
	ask: "question",
	ask_question: "question",
	contents: "contents",
	content: "contents",
	full: "contents",
	map: "structure",
	pages: "structure",
	question: "question",
	query: "question",
	read_wiki_contents: "contents",
	read_wiki_structure: "structure",
	structure: "structure",
	topics: "structure",
	wiki: "contents",
};

const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function normalizeAction(action: unknown, question: string | undefined): DeepWikiAction {
	if (typeof action === "string") {
		const key = action.trim().toLowerCase().replace(/[\s-]+/g, "_");
		if (!key) return question ? "question" : "structure";
		const normalized = ACTION_ALIASES[key];
		if (normalized) return normalized;
		throw new Error(`unsupported deepwiki action: ${action}`);
	}
	if (action !== undefined && action !== null) {
		throw new Error("deepwiki action must be a string");
	}
	if (question) return "question";
	return "structure";
}

export function normalizeRepoName(value: unknown): string {
	if (typeof value !== "string") throw new Error("repoName is required");

	const input = value.trim().replace(/^\/+|\/+$/g, "");
	if (!input) throw new Error("repoName is required");

	let owner: string | undefined;
	let repo: string | undefined;

	const sshMatch = input.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
	if (sshMatch) {
		owner = sshMatch[1];
		repo = sshMatch[2];
	} else if (/^(?:https?:\/\/)?(?:www\.)?(?:github\.com|deepwiki\.com)\//i.test(input)) {
		const urlInput = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
		try {
			const url = new URL(urlInput);
			const [urlOwner, urlRepo] = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
			owner = urlOwner;
			repo = urlRepo?.replace(/\.git$/i, "");
		} catch {
			throw new Error('repoName must use "owner/repo" format');
		}
	} else {
		const parts = input.replace(/\.git$/i, "").split("/");
		if (parts.length === 2) {
			[owner, repo] = parts;
		}
	}

	if (!owner || !repo || !GITHUB_OWNER_RE.test(owner) || !GITHUB_REPO_RE.test(repo)) {
		throw new Error('repoName must use a public GitHub "owner/repo" identifier');
	}
	return `${owner}/${repo}`;
}

function normalizeRepoNames(value: unknown): string[] {
	const values =
		typeof value === "string" && value.includes(",")
			? value
					.split(",")
					.map((repo) => repo.trim())
					.filter(Boolean)
			: Array.isArray(value)
				? value
				: [value];
	const repos = values.map((item) => normalizeRepoName(item));
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const repo of repos) {
		const key = repo.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(repo);
	}
	if (unique.length > MAX_QUESTION_REPOS) {
		throw new Error(`question action supports at most ${MAX_QUESTION_REPOS} repositories`);
	}
	return unique;
}

export function normalizeDeepWikiParams(input: unknown): DeepWikiParams {
	if (!input || typeof input !== "object") {
		throw new Error("deepwiki arguments must be an object");
	}

	const record = input as Record<string, unknown>;
	const question = readString(record, ["question", "query", "prompt"]);
	const action = normalizeAction(record.action, question);
	const rawRepoName =
		record.repoName ??
		record.repo ??
		record.repos ??
		record.repository ??
		record.repositories ??
		record.githubRepo ??
		record.githubRepos;
	const repoNames = normalizeRepoNames(rawRepoName);

	if (action === "question") {
		if (!question) throw new Error("question is required when action is question");
		return {
			action,
			repoName: repoNames.length > 1 ? repoNames : repoNames[0],
			question,
		};
	}

	if (repoNames.length !== 1) {
		throw new Error(`${action} action requires exactly one repository`);
	}

	return { action, repoName: repoNames[0] };
}

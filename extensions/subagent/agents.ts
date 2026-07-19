import * as fs from "node:fs";
import * as path from "node:path";

import {
	CONFIG_DIR_NAME,
	getAgentDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";

import type { AgentScope, ThinkingLevelName } from "./schema.ts";
import type { AgentDefinition, AgentDiscoveryResult } from "./types.ts";

const THINKING_LEVELS = new Set<ThinkingLevelName>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

/** Default tool sets — capability comes only from the profile, not the caller. */
export const GENERAL_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
] as const;

export const EXPLORER_TOOLS = ["read", "grep", "find", "ls"] as const;

const BUILTIN_AGENTS: AgentDefinition[] = [
	{
		name: "general",
		description:
			"General-purpose worker that may inspect and modify the workspace",
		systemPrompt: [
			"Complete the delegated task end to end. Prefer editing existing files over creating new ones.",
			"Do not create documentation files unless the task explicitly asks for them.",
			"When finished, respond with a concise report for the parent agent: what changed (paths), key findings, and any blockers — essentials only.",
		].join(" "),
		tools: [...GENERAL_TOOLS],
		source: "builtin",
	},
	{
		name: "explorer",
		description: "Read-only codebase reconnaissance and compressed findings",
		systemPrompt: [
			"READ-ONLY reconnaissance. You must not create, modify, delete, or move files, or run any command that changes system state.",
			"You have only read, grep, find, and ls — no bash, edit, or write.",
			"Search efficiently (parallel tool calls when useful). Return concise findings with exact paths, symbols, and line references the parent can act on.",
			"If project conventions matter, read AGENTS.md or README yourself; do not invent structure.",
		].join(" "),
		tools: [...EXPLORER_TOOLS],
		// Cheap default for recon; parent/settings/spawn can still override.
		thinkingLevel: "low",
		// Skip AGENTS.md injection; explorer can read it if needed.
		omitContextFiles: true,
		source: "builtin",
	},
];

function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function parseThinkingLevel(
	value: string | undefined,
): ThinkingLevelName | undefined {
	if (!value) return undefined;
	const normalized = value.trim() as ThinkingLevelName;
	return THINKING_LEVELS.has(normalized) ? normalized : undefined;
}

function loadDirectory(
	dir: string,
	source: "user" | "project",
): AgentDefinition[] {
	if (!isDirectory(dir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentDefinition[] = [];
	for (const entry of entries) {
		if (
			!entry.name.endsWith(".md") ||
			(!entry.isFile() && !entry.isSymbolicLink())
		)
			continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf8");
		} catch {
			continue;
		}

		const { frontmatter, body } =
			parseFrontmatter<Record<string, string>>(content);
		const name = frontmatter.name?.trim();
		const description = frontmatter.description?.trim();
		if (!name || !description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean);

		const thinkingLevel = parseThinkingLevel(
			frontmatter.thinkingLevel ?? frontmatter.thinking,
		);
		agents.push({
			name,
			description,
			systemPrompt: body.trim(),
			...(tools?.length ? { tools } : {}),
			...(frontmatter.model?.trim() ? { model: frontmatter.model.trim() } : {}),
			...(thinkingLevel ? { thinkingLevel } : {}),
			source,
			filePath,
		});
	}
	return agents;
}

export function discoverAgents(
	cwd: string,
	scope: AgentScope,
): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const userAgents = scope === "project" ? [] : loadDirectory(userDir, "user");
	const projectAgents =
		scope === "user" || !projectAgentsDir
			? []
			: loadDirectory(projectAgentsDir, "project");

	const byName = new Map<string, AgentDefinition>();
	for (const agent of BUILTIN_AGENTS) byName.set(agent.name, agent);
	for (const agent of userAgents) byName.set(agent.name, agent);
	for (const agent of projectAgents) byName.set(agent.name, agent);

	return {
		agents: [...byName.values()].sort((first, second) =>
			first.name.localeCompare(second.name),
		),
		projectAgentsDir,
	};
}

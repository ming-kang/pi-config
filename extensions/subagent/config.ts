import * as fs from "node:fs";
import * as path from "node:path";

import {
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

import { SUBAGENT_USER_CONFIG_VERSION } from "./constants.ts";
import type { ThinkingLevelName } from "./schema.ts";
import type { ProfilePreference, SubagentUserConfig } from "./types.ts";

const THINKING_LEVELS = new Set<ThinkingLevelName>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export function getSubagentUserConfigPath(): string {
	return path.join(getAgentDir(), "pi-config", "subagent.json");
}

function normalizePreference(value: unknown): ProfilePreference | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const preference: ProfilePreference = {};
	if (typeof record.model === "string" && record.model.trim()) {
		preference.model = record.model.trim();
	}
	if (record.thinkingLevel === "inherit") {
		preference.thinkingLevel = "inherit";
	} else if (
		typeof record.thinkingLevel === "string" &&
		THINKING_LEVELS.has(record.thinkingLevel as ThinkingLevelName)
	) {
		preference.thinkingLevel = record.thinkingLevel as ThinkingLevelName;
	}
	return Object.keys(preference).length ? preference : undefined;
}

export async function loadSubagentUserConfig(): Promise<SubagentUserConfig> {
	const filePath = getSubagentUserConfigPath();
	let raw: string;
	try {
		raw = await fs.promises.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { version: SUBAGENT_USER_CONFIG_VERSION, profiles: {} };
		}
		throw error;
	}

	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== "object")
		throw new Error("subagent.json must contain a JSON object");
	const profilesValue = (parsed as Record<string, unknown>).profiles;
	const profiles: Record<string, ProfilePreference> = {};
	if (profilesValue && typeof profilesValue === "object") {
		for (const [name, value] of Object.entries(
			profilesValue as Record<string, unknown>,
		)) {
			const preference = normalizePreference(value);
			if (preference) profiles[name] = preference;
		}
	}
	return { version: SUBAGENT_USER_CONFIG_VERSION, profiles };
}

export async function saveSubagentUserConfig(
	config: SubagentUserConfig,
): Promise<void> {
	const filePath = getSubagentUserConfigPath();
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const serialized = `${JSON.stringify(
		{ version: SUBAGENT_USER_CONFIG_VERSION, profiles: config.profiles },
		null,
		2,
	)}\n`;
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, serialized, {
			encoding: "utf8",
			mode: 0o600,
		});
	});
}

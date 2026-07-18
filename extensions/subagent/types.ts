import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type { AgentScope, DeliveryMode, ThinkingLevelName } from "./schema.ts";

export type AgentDefinitionSource = "builtin" | "user" | "project";

export interface AgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	model?: string;
	thinkingLevel?: ThinkingLevelName;
	source: AgentDefinitionSource;
	filePath?: string;
}

export interface AgentDiscoveryResult {
	agents: AgentDefinition[];
	projectAgentsDir: string | null;
}

export interface SubagentConfig {
	maxConcurrency: number;
	maxAgents: number;
}

export interface ProfilePreference {
	/** "inherit" forces the current parent model even if the agent definition names one. */
	model?: string | "inherit";
	/** "inherit" forces the current parent thinking level even if the agent definition names one. */
	thinkingLevel?: ThinkingLevelName | "inherit";
}

export interface SubagentUserConfig {
	version: number;
	profiles: Record<string, ProfilePreference>;
}

export type SubagentStatus =
	| "queued"
	| "starting"
	| "running"
	| "completed"
	| "failed"
	| "stopped";

export type TimelineKind =
	| "assistant"
	| "tool"
	| "toolResult"
	| "system"
	| "error"
	| "user";

export interface TimelineItem {
	kind: TimelineKind;
	text: string;
	timestamp: number;
}

export type ToolActivityStatus = "running" | "succeeded" | "failed";

export interface ToolActivity {
	id: string;
	toolName: string;
	headline: string;
	summary: string;
	status: ToolActivityStatus;
	startedAt: number;
	endedAt?: number;
	resultSummary?: string;
}

export interface SubagentUsage {
	turns: number;
	toolUses: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface SubagentLaunchSpec {
	task: string;
	agentName: string;
	label: string;
	model?: string;
	tools?: string[];
	cwd: string;
	thinkingLevel?: ThinkingLevelName;
	agentScope: AgentScope;
}

export interface PendingRun {
	prompt: string;
	fresh: boolean;
	/** Initial multi-worker spawn group; continuations and restarts omit it. */
	completionGroupId?: string;
}

export interface SubagentRecord extends SubagentLaunchSpec {
	id: string;
	agentDefinition: AgentDefinition;
	status: SubagentStatus;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	updatedAt: number;
	generation: number;
	runCount: number;
	unread: boolean;
	error?: string;
	lastOutput: string;
	liveText: string;
	currentActivity?: string;
	activities: ToolActivity[];
	omittedActivities: number;
	timeline: TimelineItem[];
	usage: SubagentUsage;
	pendingRun?: PendingRun;
	/** Protects a settled initial batch member until the group notification fires. */
	currentCompletionGroupId?: string;
	pendingInstructions: Array<{ message: string; delivery: DeliveryMode }>;
	session?: AgentSession;
	unsubscribe?: () => void;
	resolvedModel?: Model<Api>;
}

export interface SubagentSnapshot {
	id: string;
	label: string;
	agentName: string;
	agentSource: AgentDefinitionSource;
	task: string;
	cwd: string;
	status: SubagentStatus;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	updatedAt: number;
	runCount: number;
	unread: boolean;
	error?: string;
	lastOutput: string;
	liveText: string;
	currentActivity?: string;
	activities: ToolActivity[];
	omittedActivities: number;
	timeline: TimelineItem[];
	usage: SubagentUsage;
	model?: string;
}

export interface SubagentDetails {
	action: string;
	config: SubagentConfig;
	agents: Array<{
		id: string;
		label: string;
		agent: string;
		status: SubagentStatus;
		cwd: string;
		runCount: number;
		turns: number;
		toolUses: number;
		outputTokens: number;
		unread: boolean;
	}>;
	errorCode?: string;
}

export interface SubagentPanelHost {
	getConfig(): SubagentConfig;
	getSnapshots(): SubagentSnapshot[];
	markViewed(id: string): void;
	sendInstruction(
		id: string,
		message: string | undefined,
		delivery: DeliveryMode,
		fresh?: boolean,
	): Promise<string>;
	stopAgent(id: string): Promise<string>;
}

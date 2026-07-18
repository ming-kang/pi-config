import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

import {
	HARD_MAX_AGENTS,
	HARD_MAX_CONCURRENCY,
	MAX_BATCH_TASKS,
} from "./constants.ts";

export const SubagentActionSchema = StringEnum(
	["spawn", "read", "send", "stop"] as const,
	{ description: "Operation to perform on background subagents" },
);

export const AgentScopeSchema = StringEnum(
	["user", "project", "both"] as const,
	{
		description:
			'For spawn: agent definition scope. Default: "user". Project definitions come from the nearest .pi/agents directory.',
		default: "user",
	},
);

export const DeliverySchema = StringEnum(["steer", "followUp"] as const, {
	description:
		'For send to a running agent, "steer" delivers after the current tool batch; "followUp" waits until its current work settles.',
	default: "steer",
});

export const ThinkingLevelSchema = StringEnum(
	["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
	{ description: "Optional reasoning effort override for this subagent" },
);

export const SubagentTaskSchema = Type.Object({
	task: Type.String({
		description: "Concrete task for the worker",
		minLength: 1,
		maxLength: 20_000,
	}),
	agent: Type.Optional(
		Type.String({
			description:
				'Agent definition name. Defaults to the built-in "general" worker.',
		}),
	),
	label: Type.Optional(
		Type.String({ description: "Short human-readable label shown in the TUI" }),
	),
	model: Type.Optional(
		Type.String({
			description:
				'Model id or provider/model id. Use "inherit" (or omit) to use the parent/profile resolution chain.',
		}),
	),
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Built-in tool allowlist for this worker; an empty list disables all tools",
			maxItems: 16,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory, absolute or relative to the parent cwd",
		}),
	),
	thinkingLevel: Type.Optional(
		Type.Union([ThinkingLevelSchema, Type.Literal("inherit")], {
			description:
				'Reasoning effort override; "inherit" uses the current parent level.',
		}),
	),
});

export const SubagentParamsSchema = Type.Object({
	action: SubagentActionSchema,

	// Single-spawn shorthand. Use tasks for a batch.
	task: Type.Optional(SubagentTaskSchema.properties.task),
	agent: Type.Optional(SubagentTaskSchema.properties.agent),
	label: Type.Optional(SubagentTaskSchema.properties.label),
	model: Type.Optional(SubagentTaskSchema.properties.model),
	tools: Type.Optional(SubagentTaskSchema.properties.tools),
	cwd: Type.Optional(SubagentTaskSchema.properties.cwd),
	thinkingLevel: Type.Optional(SubagentTaskSchema.properties.thinkingLevel),
	tasks: Type.Optional(
		Type.Array(SubagentTaskSchema, {
			description: "For spawn: independent tasks to enqueue together",
			minItems: 1,
			maxItems: MAX_BATCH_TASKS,
		}),
	),

	// Existing-agent actions.
	id: Type.Optional(
		Type.String({
			description: "For read/send/stop: stable subagent id returned by spawn/read",
		}),
	),
	message: Type.Optional(
		Type.String({
			description:
				"For send: instruction to attach, steer, continue with, or use as a fresh replacement task",
			minLength: 1,
			maxLength: 20_000,
		}),
	),
	delivery: Type.Optional(DeliverySchema),
	fresh: Type.Optional(
		Type.Boolean({
			description:
				"For send: start a fresh isolated context. Failed/stopped workers rerun fresh automatically.",
		}),
	),

	// Discovery/security.
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description:
				"For spawn: prompt before executing repository-controlled project agent definitions. Default: true.",
			default: true,
		}),
	),

	// Spawn-time session deployment limits.
	maxConcurrency: Type.Optional(
		Type.Integer({
			description: "For spawn: maximum concurrently running subagents",
			minimum: 1,
			maximum: HARD_MAX_CONCURRENCY,
		}),
	),
	maxAgents: Type.Optional(
		Type.Integer({
			description:
				"For spawn: maximum retained subagent records, including completed workers",
			minimum: 1,
			maximum: HARD_MAX_AGENTS,
		}),
	),
});

export type SubagentAction = Static<typeof SubagentActionSchema>;
export type AgentScope = Static<typeof AgentScopeSchema>;
export type DeliveryMode = Static<typeof DeliverySchema>;
export type ThinkingLevelName = Static<typeof ThinkingLevelSchema>;
export type ThinkingLevelSetting = ThinkingLevelName | "inherit";
export type SubagentTaskParams = Static<typeof SubagentTaskSchema>;
export type SubagentParams = Static<typeof SubagentParamsSchema>;

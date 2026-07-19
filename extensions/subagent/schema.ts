import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

import { MAX_BATCH_TASKS } from "./constants.ts";

export const SubagentActionSchema = StringEnum(
	["spawn", "read", "send", "stop"] as const,
	{
		description:
			'spawn: start work; read: list or one snapshot; send: instruct/continue; stop: abort (notifies parent)',
	},
);

export const AgentScopeSchema = StringEnum(
	["user", "project", "both"] as const,
	{
		description:
			'For spawn: where to load Markdown agent definitions. Default "user" (built-ins + ~/.pi/agent/agents). Use "project" or "both" only when you intentionally need repository .pi/agents definitions (interactive confirm required).',
		default: "user",
	},
);

export const ThinkingLevelSchema = StringEnum(
	["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
	{ description: "Optional reasoning effort override for this subagent" },
);

export const SubagentTaskSchema = Type.Object({
	task: Type.String({
		description:
			"Concrete briefing for the worker: goal, constraints, paths, expected report shape",
		minLength: 1,
		maxLength: 20_000,
	}),
	agent: Type.Optional(
		Type.String({
			description:
				'Profile name. Default "general" (may edit). Use "explorer" for read-only recon.',
		}),
	),
	label: Type.Optional(
		Type.String({
			description:
				"Short 3–8 word summary shown in the TUI and notifications (strongly recommended)",
			maxLength: 80,
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				'Optional model id or provider/model. Prefer omit; use "inherit" to force the parent model.',
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory relative to the parent session cwd (must stay inside that tree)",
		}),
	),
	thinkingLevel: Type.Optional(
		Type.Union([ThinkingLevelSchema, Type.Literal("inherit")], {
			description:
				'Optional reasoning override. Prefer omit. "inherit" uses the parent level.',
		}),
	),
});

export const SubagentParamsSchema = Type.Object({
	action: SubagentActionSchema,

	// spawn: single-task shorthand. Use tasks for a batch.
	task: Type.Optional(SubagentTaskSchema.properties.task),
	agent: Type.Optional(SubagentTaskSchema.properties.agent),
	label: Type.Optional(SubagentTaskSchema.properties.label),
	model: Type.Optional(SubagentTaskSchema.properties.model),
	cwd: Type.Optional(SubagentTaskSchema.properties.cwd),
	thinkingLevel: Type.Optional(SubagentTaskSchema.properties.thinkingLevel),
	tasks: Type.Optional(
		Type.Array(SubagentTaskSchema, {
			description:
				"For spawn: independent tasks to enqueue together (prefer over serial spawns)",
			minItems: 1,
			maxItems: MAX_BATCH_TASKS,
		}),
	),

	// read / send / stop
	id: Type.Optional(
		Type.String({
			description:
				"For read/send/stop: stable id from spawn (e.g. sa-01). Omit on read to list workers.",
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
	fresh: Type.Optional(
		Type.Boolean({
			description:
				"For send: start a fresh isolated context. Failed/stopped workers rerun fresh automatically.",
		}),
	),

	// Optional discovery scope (defaults to user-level definitions only).
	agentScope: Type.Optional(AgentScopeSchema),
});

export type SubagentAction = Static<typeof SubagentActionSchema>;
export type AgentScope = Static<typeof AgentScopeSchema>;
export type ThinkingLevelName = Static<typeof ThinkingLevelSchema>;
export type ThinkingLevelSetting = ThinkingLevelName | "inherit";
export type SubagentTaskParams = Static<typeof SubagentTaskSchema>;
export type SubagentParams = Static<typeof SubagentParamsSchema>;

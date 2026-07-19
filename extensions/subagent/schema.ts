import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

import { MAX_BATCH_TASKS } from "./constants.ts";

export const SubagentActionSchema = StringEnum(
	["spawn", "read", "send", "stop"] as const,
	{
		description:
			'spawn (default): start work; read: list or one snapshot; send: steer/continue; stop: abort (notifies parent)',
	},
);

export const AgentScopeSchema = StringEnum(
	["user", "project", "both"] as const,
	{
		description:
			'Where to load Markdown agent definitions. Default "user" (built-ins + ~/.pi/agent/agents). Use "project"/"both" only when you intentionally need repository .pi/agents (interactive confirm required).',
		default: "user",
	},
);

export const ThinkingLevelSchema = StringEnum(
	["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
	{ description: "Optional reasoning effort override for this subagent" },
);

export const SubagentTaskSchema = Type.Object({
	/** Preferred name for the worker briefing (alias of task). */
	prompt: Type.Optional(
		Type.String({
			description:
				"Concrete briefing for the worker: goal, constraints, paths, expected report shape",
			minLength: 1,
			maxLength: 20_000,
		}),
	),
	task: Type.Optional(
		Type.String({
			description:
				"Alias of prompt (legacy). Concrete briefing for the worker.",
			minLength: 1,
			maxLength: 20_000,
		}),
	),
	agent: Type.Optional(
		Type.String({
			description:
				'Profile name. Default "general" (may edit). Use "explorer" for read-only recon.',
		}),
	),
	/** Short UI summary (preferred). */
	description: Type.Optional(
		Type.String({
			description:
				"Short 3–8 word summary shown in the live preview (strongly recommended)",
			maxLength: 80,
		}),
	),
	label: Type.Optional(
		Type.String({
			description: "Alias of description (legacy)",
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
	thinking: Type.Optional(
		Type.Union([ThinkingLevelSchema, Type.Literal("inherit")], {
			description:
				'Optional reasoning override. Prefer omit. "inherit" uses the parent level.',
		}),
	),
	thinkingLevel: Type.Optional(
		Type.Union([ThinkingLevelSchema, Type.Literal("inherit")], {
			description: "Alias of thinking (legacy)",
		}),
	),
});

export const SubagentParamsSchema = Type.Object({
	action: Type.Optional(SubagentActionSchema),

	// spawn: single-task fields
	prompt: Type.Optional(SubagentTaskSchema.properties.prompt),
	task: Type.Optional(SubagentTaskSchema.properties.task),
	agent: Type.Optional(SubagentTaskSchema.properties.agent),
	description: Type.Optional(SubagentTaskSchema.properties.description),
	label: Type.Optional(SubagentTaskSchema.properties.label),
	model: Type.Optional(SubagentTaskSchema.properties.model),
	cwd: Type.Optional(SubagentTaskSchema.properties.cwd),
	thinking: Type.Optional(SubagentTaskSchema.properties.thinking),
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
				"For read/send/stop: stable worker id from spawn (e.g. a7c3e91f). Omit on read to list workers.",
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

	agentScope: Type.Optional(AgentScopeSchema),
});

export type SubagentAction = Static<typeof SubagentActionSchema>;
export type AgentScope = Static<typeof AgentScopeSchema>;
export type ThinkingLevelName = Static<typeof ThinkingLevelSchema>;
export type ThinkingLevelSetting = ThinkingLevelName | "inherit";
export type SubagentTaskParams = Static<typeof SubagentTaskSchema>;
export type SubagentParams = Static<typeof SubagentParamsSchema>;

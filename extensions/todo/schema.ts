import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

import { TODO_TOOL_NAME } from "./constants.ts";

export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";
export type TodoAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface TodoItem {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TodoStatus;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

export interface TodoState {
	items: TodoItem[];
	nextId: number;
}

export interface TodoDetails {
	action: TodoAction;
	params: Record<string, unknown>;
	items: TodoItem[];
	nextId: number;
	error?: string;
}

const StatusSchema = StringEnum(["pending", "in_progress", "completed", "deleted"] as const);

const ActionSchema = StringEnum(["create", "update", "list", "get", "delete", "clear"] as const);

export const TodoParamsSchema = Type.Object({
	action: ActionSchema,
	subject: Type.Optional(Type.String({ description: "Short task subject, required for create." })),
	description: Type.Optional(Type.String({ description: "Longer task notes or acceptance detail." })),
	activeForm: Type.Optional(
		Type.String({ description: "Present-continuous label shown while in_progress, such as 'reading code'." }),
	),
	status: Type.Optional(StatusSchema),
	blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Initial dependency ids for create." })),
	addBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Dependency ids to add on update." })),
	removeBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Dependency ids to remove on update." })),
	owner: Type.Optional(Type.String({ description: "Optional owner or agent label." })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), { description: "Optional structured metadata; null deletes a key." }),
	),
	id: Type.Optional(Type.Number({ description: "Task id, required for update, get, and delete." })),
	includeDeleted: Type.Optional(Type.Boolean({ description: "Include deleted tombstones in list output." })),
});

export type TodoParams = Static<typeof TodoParamsSchema>;

export const EMPTY_TODO_STATE: TodoState = { items: [], nextId: 1 };

// Re-export so existing call sites that import from schema.ts still work.
export { TODO_TOOL_NAME };

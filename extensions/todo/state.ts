import { TODO_TOOL_NAME } from "./constants.ts";
import { EMPTY_TODO_STATE, type TodoDetails, type TodoItem, type TodoParams, type TodoState, type TodoStatus } from "./schema.ts";

type Operation =
	| { kind: "create"; id: number }
	| { kind: "update"; id: number; from: TodoStatus; to: TodoStatus }
	| { kind: "delete"; id: number; subject: string }
	| { kind: "list"; status?: TodoStatus; includeDeleted: boolean }
	| { kind: "get"; item: TodoItem }
	| { kind: "clear"; count: number }
	| { kind: "error"; message: string };

export interface MutationResult {
	state: TodoState;
	operation: Operation;
}

// ---- per-session state ------------------------------------------------------
// Keyed by session id like rewind's engine state: one Pi process can host more
// than one session over its lifetime (resume, /tree branch switches), and a
// module-level singleton would leak one session's list into another. Tool
// renderers get no ctx, so the active session is a module-level pointer kept
// current by execute and the lifecycle handlers (which do have ctx).
const states = new Map<string, TodoState>();
let activeSid = "";

/** Point the module at a session's state bucket. Call wherever ctx is in hand. */
export function setActiveTodoSession(sid: string): void {
	activeSid = sid;
}

export function getTodoState(): TodoState {
	return states.get(activeSid) ?? cloneState(EMPTY_TODO_STATE);
}

export function replaceTodoState(next: TodoState): void {
	states.set(activeSid, cloneState(next));
}

export function commitTodoState(next: TodoState): void {
	replaceTodoState(next);
}

export function cloneState(source: TodoState): TodoState {
	return {
		items: source.items.map((item) => {
			const clone: TodoItem = { ...item };
			if (item.blockedBy) clone.blockedBy = [...item.blockedBy];
			else delete clone.blockedBy;
			if (item.metadata) clone.metadata = { ...item.metadata };
			else delete clone.metadata;
			return clone;
		}),
		nextId: source.nextId,
	};
}

function error(state: TodoState, message: string): MutationResult {
	return { state, operation: { kind: "error", message } };
}

function isTransitionAllowed(from: TodoStatus, to: TodoStatus): boolean {
	// `deleted` is the only terminal status; `completed` can be reopened to
	// in_progress or pending so a premature completion recovers without losing
	// the task id and its blockedBy edges.
	if (from === to) return true;
	if (from === "deleted") return false;
	if (to === "deleted") return true;
	if (to === "completed") return from === "pending" || from === "in_progress";
	if (to === "pending") return from === "in_progress" || from === "completed";
	if (to === "in_progress") return from === "pending" || from === "completed";
	return false;
}

function findItem(state: TodoState, id: number): TodoItem | undefined {
	return state.items.find((item) => item.id === id);
}

function validateDependencies(state: TodoState, deps: number[] | undefined, currentId?: number): string | undefined {
	if (!deps?.length) return undefined;
	for (const dep of deps) {
		if (dep === currentId) return `cannot block #${currentId} on itself`;
		const item = findItem(state, dep);
		if (!item) return `blockedBy: #${dep} not found`;
		if (item.status === "deleted") return `blockedBy: #${dep} is deleted`;
	}
	return undefined;
}

function createsCycle(items: TodoItem[], id: number, nextDeps: number[]): boolean {
	const depsById = new Map<number, number[]>();
	for (const item of items) depsById.set(item.id, item.blockedBy ?? []);
	depsById.set(id, nextDeps);

	const seen = new Set<number>();
	const stack = new Set<number>();

	function visit(node: number): boolean {
		if (stack.has(node)) return true;
		if (seen.has(node)) return false;
		seen.add(node);
		stack.add(node);
		for (const dep of depsById.get(node) ?? []) {
			if (visit(dep)) return true;
		}
		stack.delete(node);
		return false;
	}

	return visit(id);
}

export function applyTodoMutation(input: TodoState, params: TodoParams): MutationResult {
	const state = cloneState(input);

	switch (params.action) {
		case "create": {
			const subject = params.subject?.trim();
			if (!subject) return error(state, "subject required for create");
			const dependencyError = validateDependencies(state, params.blockedBy);
			if (dependencyError) return error(state, dependencyError);

			const item: TodoItem = {
				id: state.nextId,
				subject,
				status: "pending",
			};
			if (params.description) item.description = params.description;
			if (params.activeForm) item.activeForm = params.activeForm;
			if (params.blockedBy?.length) item.blockedBy = Array.from(new Set<number>(params.blockedBy));
			if (params.owner) item.owner = params.owner;
			if (params.metadata) item.metadata = { ...params.metadata };

			return {
				state: { items: [...state.items, item], nextId: state.nextId + 1 },
				operation: { kind: "create", id: item.id },
			};
		}

		case "update": {
			if (params.id === undefined) return error(state, "id required for update");
			const index = state.items.findIndex((item) => item.id === params.id);
			if (index === -1) return error(state, `#${params.id} not found`);
			const current = state.items[index];

			const hasChange =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.status !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined ||
				(params.addBlockedBy?.length ?? 0) > 0 ||
				(params.removeBlockedBy?.length ?? 0) > 0;
			if (!hasChange) return error(state, "update requires at least one field");

			const nextStatus = params.status ?? current.status;
			if (!isTransitionAllowed(current.status, nextStatus)) {
				return error(state, `illegal transition ${current.status} -> ${nextStatus}`);
			}

			let nextDeps = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy?.length) {
				const remove = new Set(params.removeBlockedBy);
				nextDeps = nextDeps.filter((id) => !remove.has(id));
			}
			if (params.addBlockedBy?.length) {
				const dependencyError = validateDependencies(state, params.addBlockedBy, current.id);
				if (dependencyError) return error(state, dependencyError);
				for (const dep of params.addBlockedBy) {
					if (!nextDeps.includes(dep)) nextDeps.push(dep);
				}
			}
			if (createsCycle(state.items, current.id, nextDeps)) {
				return error(state, "blockedBy would create a cycle");
			}

			const updated: TodoItem = { ...current, status: nextStatus };
			if (params.subject !== undefined) updated.subject = params.subject.trim();
			if (params.description !== undefined) updated.description = params.description;
			if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
			if (params.owner !== undefined) updated.owner = params.owner;
			if (nextDeps.length) updated.blockedBy = nextDeps;
			else delete updated.blockedBy;

			if (params.metadata !== undefined) {
				const merged = { ...(current.metadata ?? {}) };
				for (const [key, value] of Object.entries(params.metadata)) {
					if (value === null) delete merged[key];
					else merged[key] = value;
				}
				if (Object.keys(merged).length) updated.metadata = merged;
				else delete updated.metadata;
			}

			const items = [...state.items];
			items[index] = updated;
			return {
				state: { items, nextId: state.nextId },
				operation: { kind: "update", id: updated.id, from: current.status, to: updated.status },
			};
		}

		case "list":
			return {
				state,
				operation: {
					kind: "list",
					status: params.status,
					includeDeleted: params.includeDeleted === true,
				},
			};

		case "get": {
			if (params.id === undefined) return error(state, "id required for get");
			const item = findItem(state, params.id);
			if (!item) return error(state, `#${params.id} not found`);
			return { state, operation: { kind: "get", item } };
		}

		case "delete": {
			if (params.id === undefined) return error(state, "id required for delete");
			const index = state.items.findIndex((item) => item.id === params.id);
			if (index === -1) return error(state, `#${params.id} not found`);
			const current = state.items[index];
			if (current.status === "deleted") return error(state, `#${params.id} is already deleted`);
			const items = [...state.items];
			items[index] = { ...current, status: "deleted" };
			return {
				state: { items, nextId: state.nextId },
				operation: { kind: "delete", id: current.id, subject: current.subject },
			};
		}

		case "clear":
			return {
				state: cloneState(EMPTY_TODO_STATE),
				operation: { kind: "clear", count: state.items.length },
			};
	}

	return error(state, `unknown action: ${(params as { action?: unknown }).action}`);
}

function isTodoDetails(value: unknown): value is TodoDetails {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return Array.isArray(record.items) && typeof record.nextId === "number";
}

export function replayTodosFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TodoState {
	let snapshot = cloneState(EMPTY_TODO_STATE);
	for (const entry of ctx.sessionManager.getBranch()) {
		const item = entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown } };
		if (item.type !== "message") continue;
		if (item.message?.role !== "toolResult" || item.message.toolName !== TODO_TOOL_NAME) continue;
		if (!isTodoDetails(item.message.details)) continue;
		snapshot = {
			items: item.message.details.items.map((todo) => ({ ...todo })),
			nextId: item.message.details.nextId,
		};
	}
	return snapshot;
}

export function buildTodoDetails(params: TodoParams, next: TodoState, operation: Operation): TodoDetails {
	return {
		action: params.action,
		params: params as Record<string, unknown>,
		items: cloneState(next).items,
		nextId: next.nextId,
		...(operation.kind === "error" ? { error: operation.message } : {}),
	};
}

export function formatTodoContent(operation: Operation, state: TodoState): string {
	switch (operation.kind) {
		case "create": {
			const item = findItem(state, operation.id);
			return item ? `Created #${item.id}: ${item.subject} (pending)` : `Created #${operation.id}`;
		}
		case "update": {
			const transition = operation.from === operation.to ? "" : ` (${operation.from} -> ${operation.to})`;
			return `Updated #${operation.id}${transition}`;
		}
		case "delete":
			return `Deleted #${operation.id}: ${operation.subject}`;
		case "clear":
			return `Cleared ${operation.count} tasks`;
		case "list": {
			let view = state.items;
			if (!operation.includeDeleted) view = view.filter((item) => item.status !== "deleted");
			if (operation.status) view = view.filter((item) => item.status === operation.status);
			return view.length ? view.map(formatListItem).join("\n") : "No tasks";
		}
		case "get":
			return formatDetailItem(operation.item, state);
		case "error":
			return `Error: ${operation.message}`;
	}
}

function formatListItem(item: TodoItem): string {
	const deps = item.blockedBy?.length ? ` blockedBy=${item.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	const active = item.status === "in_progress" && item.activeForm ? ` (${item.activeForm})` : "";
	return `[${item.status}] #${item.id} ${item.subject}${active}${deps}`;
}

function formatDetailItem(item: TodoItem, state: TodoState): string {
	const lines = [`#${item.id} [${item.status}] ${item.subject}`];
	if (item.description) lines.push(`description: ${item.description}`);
	if (item.activeForm) lines.push(`activeForm: ${item.activeForm}`);
	if (item.blockedBy?.length) lines.push(`blockedBy: ${item.blockedBy.map((id) => `#${id}`).join(", ")}`);
	const blocks = state.items.filter((candidate) => candidate.blockedBy?.includes(item.id)).map((candidate) => candidate.id);
	if (blocks.length) lines.push(`blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	if (item.owner) lines.push(`owner: ${item.owner}`);
	return lines.join("\n");
}

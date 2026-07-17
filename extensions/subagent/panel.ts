import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Input,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

import type {
	SubagentPanelHost,
	SubagentSnapshot,
	SubagentStatus,
	TimelineItem,
	TimelineKind,
} from "./types.ts";

const STATUS_ORDER: Record<SubagentStatus, number> = {
	running: 0,
	starting: 1,
	queued: 2,
	failed: 3,
	completed: 4,
	stopped: 5,
};

const STATUS_ICON: Record<SubagentStatus, string> = {
	queued: "○",
	starting: "◌",
	running: "●",
	completed: "✓",
	failed: "✗",
	stopped: "■",
};

const STATUS_COLOR: Record<
	SubagentStatus,
	"dim" | "warning" | "success" | "error" | "muted"
> = {
	queued: "dim",
	starting: "warning",
	running: "warning",
	completed: "success",
	failed: "error",
	stopped: "muted",
};

function formatDuration(start: number | undefined, end = Date.now()): string {
	if (!start) return "";
	const seconds = Math.max(0, Math.floor((end - start) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function wrapPlainLine(text: string, width: number): string[] {
	const maxWidth = Math.max(1, width);
	const logicalLines = text.replace(/\r\n?/g, "\n").split("\n");
	const result: string[] = [];
	for (const logicalLine of logicalLines) {
		if (!logicalLine) {
			result.push("");
			continue;
		}
		let current = "";
		let currentWidth = 0;
		for (const character of Array.from(logicalLine)) {
			const characterWidth = Math.max(0, visibleWidth(character));
			if (current && currentWidth + characterWidth > maxWidth) {
				result.push(current);
				current = character;
				currentWidth = characterWidth;
				continue;
			}
			current += character;
			currentWidth += characterWidth;
		}
		result.push(current);
	}
	return result;
}

function timelineColor(
	kind: TimelineKind,
): "text" | "accent" | "muted" | "error" | "toolOutput" {
	if (kind === "assistant") return "text";
	if (kind === "user") return "accent";
	if (kind === "error") return "error";
	if (kind === "tool") return "toolOutput";
	return "muted";
}

function timelinePrefix(kind: TimelineKind): string {
	if (kind === "user") return "› ";
	if (kind === "tool") return "→ ";
	if (kind === "error") return "! ";
	if (kind === "system") return "• ";
	return "  ";
}

function sortSnapshots(snapshots: SubagentSnapshot[]): SubagentSnapshot[] {
	return [...snapshots].sort((first, second) => {
		const statusDelta =
			STATUS_ORDER[first.status] - STATUS_ORDER[second.status];
		return statusDelta || second.updatedAt - first.updatedAt;
	});
}

export class SubagentPanel implements Component {
	focused = false;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly host: SubagentPanelHost;
	private readonly done: () => void;
	private readonly input = new Input();
	private view: "list" | "detail" = "list";
	private selectedIndex = 0;
	private selectedId: string | undefined;
	private scrollFromBottom = 0;
	private feedback = "";
	private disposed = false;

	constructor(options: {
		tui: TUI;
		theme: Theme;
		host: SubagentPanelHost;
		done: () => void;
		initialId?: string;
	}) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.host = options.host;
		this.done = options.done;
		this.input.onSubmit = () => this.submitInstruction("steer");

		if (options.initialId) {
			const snapshots = sortSnapshots(this.host.getSnapshots());
			const index = snapshots.findIndex(
				(snapshot) => snapshot.id === options.initialId,
			);
			if (index >= 0) {
				this.selectedIndex = index;
				const selected = snapshots[index];
				if (selected) this.openDetail(selected.id);
			}
		}
	}

	requestRender(): void {
		if (!this.disposed) this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.view === "list") {
			this.handleListInput(data);
			return;
		}
		this.handleDetailInput(data);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	dispose(): void {
		this.disposed = true;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(4, width);
		return this.view === "list"
			? this.renderList(safeWidth)
			: this.renderDetail(safeWidth);
	}

	private handleListInput(data: string): void {
		const snapshots = sortSnapshots(this.host.getSnapshots());
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		if (matchesKey(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selectedIndex = Math.min(
				Math.max(0, snapshots.length - 1),
				this.selectedIndex + 1,
			);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const selected = snapshots[this.selectedIndex];
			if (selected) this.openDetail(selected.id);
		}
	}

	private handleDetailInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+l")) {
			this.view = "list";
			this.feedback = "";
			this.input.setValue("");
			this.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollFromBottom += Math.max(
				4,
				Math.floor(this.detailBodyRows() / 2),
			);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollFromBottom = Math.max(
				0,
				this.scrollFromBottom -
					Math.max(4, Math.floor(this.detailBodyRows() / 2)),
			);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+enter")) {
			this.submitInstruction("followUp");
			return;
		}
		if (matchesKey(data, "ctrl+r")) {
			this.restartSelected();
			return;
		}
		if (matchesKey(data, "ctrl+x")) {
			this.stopSelected();
			return;
		}
		this.input.handleInput(data);
		this.requestRender();
	}

	private close(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.done();
	}

	private openDetail(id: string): void {
		this.selectedId = id;
		this.view = "detail";
		this.scrollFromBottom = 0;
		this.feedback = "";
		this.host.markViewed(id);
		this.requestRender();
	}

	private selectedSnapshot(): SubagentSnapshot | undefined {
		if (!this.selectedId) return undefined;
		return this.host
			.getSnapshots()
			.find((snapshot) => snapshot.id === this.selectedId);
	}

	private submitInstruction(delivery: "steer" | "followUp"): void {
		const selected = this.selectedSnapshot();
		const message = this.input.getValue().trim();
		if (!selected || !message) return;
		this.input.setValue("");
		this.feedback =
			delivery === "steer"
				? "Sending steering instruction..."
				: "Queueing follow-up...";
		this.requestRender();
		void this.host
			.sendInstruction(selected.id, message, delivery)
			.then((result) => {
				this.feedback = result;
				this.scrollFromBottom = 0;
				this.requestRender();
			})
			.catch((error) => {
				this.feedback = `Error: ${error instanceof Error ? error.message : String(error)}`;
				this.requestRender();
			});
	}

	private restartSelected(): void {
		const selected = this.selectedSnapshot();
		if (!selected) return;
		const replacement = this.input.getValue().trim() || undefined;
		this.input.setValue("");
		this.feedback = "Restarting with a fresh context...";
		this.requestRender();
		void this.host
			.restartAgent(selected.id, replacement)
			.then((result) => {
				this.feedback = result;
				this.scrollFromBottom = 0;
				this.requestRender();
			})
			.catch((error) => {
				this.feedback = `Error: ${error instanceof Error ? error.message : String(error)}`;
				this.requestRender();
			});
	}

	private stopSelected(): void {
		const selected = this.selectedSnapshot();
		if (!selected) return;
		this.feedback = "Stopping...";
		this.requestRender();
		void this.host
			.stopAgent(selected.id)
			.then((result) => {
				this.feedback = result;
				this.requestRender();
			})
			.catch((error) => {
				this.feedback = `Error: ${error instanceof Error ? error.message : String(error)}`;
				this.requestRender();
			});
	}

	private border(character: string): string {
		return this.theme.fg("border", character);
	}

	private pad(text: string, width: number): string {
		const clipped = truncateToWidth(text, width, this.theme.fg("dim", "..."));
		return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
	}

	private row(text: string, innerWidth: number): string {
		return `${this.border("│")}${this.pad(text, innerWidth)}${this.border("│")}`;
	}

	private frame(lines: string[], width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		return [
			this.border(`╭${"─".repeat(innerWidth)}╮`),
			...lines.map((line) => this.row(line, innerWidth)),
			this.border(`╰${"─".repeat(innerWidth)}╯`),
		];
	}

	private listBodyRows(): number {
		return Math.max(4, Math.min(24, this.tui.terminal.rows - 8));
	}

	private detailBodyRows(): number {
		return Math.max(5, Math.min(28, this.tui.terminal.rows - 12));
	}

	private renderList(width: number): string[] {
		const snapshots = sortSnapshots(this.host.getSnapshots());
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, snapshots.length - 1),
		);
		const config = this.host.getConfig();
		const running = snapshots.filter(
			(snapshot) =>
				snapshot.status === "running" || snapshot.status === "starting",
		).length;
		const queued = snapshots.filter(
			(snapshot) => snapshot.status === "queued",
		).length;
		const unread = snapshots.filter((snapshot) => snapshot.unread).length;
		const lines: string[] = [
			` ${this.theme.fg("toolTitle", this.theme.bold("Subagents"))} ${this.theme.fg("dim", `${running} running · ${queued} queued · ${unread} unread`)}`,
			` ${this.theme.fg("dim", `limit ${config.maxConcurrency} concurrent · ${snapshots.length}/${config.maxAgents} retained`)}`,
			` ${this.theme.fg("dim", "─".repeat(Math.max(1, width - 4)))}`,
		];

		if (!snapshots.length) {
			lines.push(` ${this.theme.fg("muted", "No subagents in this session.")}`);
		} else {
			const visibleRows = this.listBodyRows();
			const windowStart = Math.max(
				0,
				Math.min(
					this.selectedIndex - Math.floor(visibleRows / 2),
					snapshots.length - visibleRows,
				),
			);
			for (
				let index = windowStart;
				index < Math.min(snapshots.length, windowStart + visibleRows);
				index++
			) {
				const snapshot = snapshots[index];
				if (!snapshot) continue;
				const selected = index === this.selectedIndex;
				const marker = selected ? this.theme.fg("accent", ">") : " ";
				const status = this.theme.fg(
					STATUS_COLOR[snapshot.status],
					STATUS_ICON[snapshot.status],
				);
				const label = selected
					? this.theme.fg("accent", snapshot.label)
					: this.theme.fg("text", snapshot.label);
				const elapsed = formatDuration(
					snapshot.startedAt,
					snapshot.endedAt ?? Date.now(),
				);
				const unreadMark = snapshot.unread
					? this.theme.fg("warning", "*")
					: " ";
				lines.push(
					`${marker} ${status} ${this.theme.fg("dim", snapshot.id)} ${label} ${this.theme.fg("muted", `[${snapshot.agentName}]`)} ${this.theme.fg("dim", elapsed)}${unreadMark}`,
				);
			}
			if (snapshots.length > visibleRows) {
				lines.push(
					` ${this.theme.fg("dim", `${windowStart + 1}-${Math.min(snapshots.length, windowStart + visibleRows)} of ${snapshots.length}`)}`,
				);
			}
		}

		lines.push(
			` ${this.theme.fg("dim", "↑/↓ select · Enter open · Esc close")}`,
		);
		return this.frame(lines, width);
	}

	private renderDetail(width: number): string[] {
		const snapshot = this.selectedSnapshot();
		if (!snapshot) {
			this.view = "list";
			return this.renderList(width);
		}

		const innerWidth = Math.max(1, width - 2);
		const status = this.theme.fg(
			STATUS_COLOR[snapshot.status],
			`${STATUS_ICON[snapshot.status]} ${snapshot.status}`,
		);
		const elapsed = formatDuration(
			snapshot.startedAt,
			snapshot.endedAt ?? Date.now(),
		);
		const usageParts = [
			snapshot.usage.turns ? `${snapshot.usage.turns} turns` : "",
			snapshot.usage.input ? `↑${formatTokens(snapshot.usage.input)}` : "",
			snapshot.usage.output ? `↓${formatTokens(snapshot.usage.output)}` : "",
			snapshot.usage.cost ? `$${snapshot.usage.cost.toFixed(4)}` : "",
		].filter(Boolean);

		const lines: string[] = [
			` ${this.theme.fg("toolTitle", this.theme.bold(snapshot.label))} ${this.theme.fg("dim", snapshot.id)}  ${status}`,
			` ${this.theme.fg("muted", snapshot.agentName)} ${this.theme.fg("dim", `· run ${snapshot.runCount} · ${elapsed}${usageParts.length ? ` · ${usageParts.join(" ")}` : ""}`)}`,
			` ${this.theme.fg("dim", `Task: ${snapshot.task.replace(/[\r\n\t]+/g, " ")}`)}`,
		];
		if (snapshot.currentActivity) {
			lines.push(` ${this.theme.fg("warning", snapshot.currentActivity)}`);
		}
		lines.push(` ${this.theme.fg("dim", "─".repeat(Math.max(1, width - 4)))}`);

		const transcript = this.renderTranscript(
			snapshot,
			Math.max(8, innerWidth - 2),
		);
		const bodyRows = this.detailBodyRows();
		const maxOffset = Math.max(0, transcript.length - bodyRows);
		this.scrollFromBottom = Math.min(this.scrollFromBottom, maxOffset);
		const end = Math.max(0, transcript.length - this.scrollFromBottom);
		const start = Math.max(0, end - bodyRows);
		const visible = transcript.slice(start, end);
		while (visible.length < bodyRows) visible.unshift("");
		for (const line of visible) lines.push(` ${line}`);
		if (this.scrollFromBottom > 0) {
			lines.push(
				` ${this.theme.fg("dim", `scrolled · ${this.scrollFromBottom} newer lines below`)}`,
			);
		}

		lines.push(` ${this.theme.fg("dim", "─".repeat(Math.max(1, width - 4)))}`);
		this.input.focused = this.focused && this.view === "detail";
		const [inputLine = ""] = this.input.render(Math.max(1, innerWidth - 4));
		lines.push(` ${this.theme.fg("accent", "> ")}${inputLine}`);
		lines.push(
			` ${this.theme.fg(this.feedback.startsWith("Error:") ? "error" : "dim", this.feedback || "Enter sends steer; Ctrl+Enter queues follow-up")}`,
		);
		lines.push(
			` ${this.theme.fg("dim", "PgUp/PgDn scroll · Ctrl+R restart · Ctrl+X stop · Esc list · Ctrl+C close")}`,
		);
		return this.frame(lines, width);
	}

	private renderTranscript(
		snapshot: SubagentSnapshot,
		width: number,
	): string[] {
		const items: TimelineItem[] = snapshot.timeline.slice(-100);
		if (snapshot.liveText) {
			items.push({
				kind: "assistant",
				text: snapshot.liveText,
				timestamp: Date.now(),
			});
		}
		if (!items.length) return [this.theme.fg("muted", "(waiting for output)")];

		const lines: string[] = [];
		for (const item of items) {
			const prefix = timelinePrefix(item.kind);
			const wrapped = wrapPlainLine(
				item.text,
				Math.max(1, width - visibleWidth(prefix)),
			);
			for (let index = 0; index < wrapped.length; index++) {
				const actualPrefix =
					index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
				lines.push(
					`${this.theme.fg("dim", actualPrefix)}${this.theme.fg(timelineColor(item.kind), wrapped[index] ?? "")}`,
				);
			}
		}
		return lines;
	}
}

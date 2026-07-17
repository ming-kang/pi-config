/** Keyboard-focused manager overlay: worker list and live transcript views. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Input,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

import {
	formatDuration,
	formatStats,
	formatTokens,
	isActiveStatus,
	SPINNER_INTERVAL_MS,
	spinnerFrame,
	STATUS_COLOR,
	STATUS_ICON,
} from "./format.ts";
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

type SendMode = "steer" | "followUp";

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
): "text" | "accent" | "muted" | "dim" | "error" | "toolOutput" {
	if (kind === "assistant") return "text";
	if (kind === "user") return "accent";
	if (kind === "error") return "error";
	if (kind === "tool") return "toolOutput";
	if (kind === "toolResult") return "dim";
	return "muted";
}

function timelinePrefix(kind: TimelineKind): string {
	if (kind === "user") return "› ";
	if (kind === "tool") return "→ ";
	if (kind === "toolResult") return "  ⎿ ";
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
	private sendMode: SendMode = "steer";
	private feedback = "";
	private disposed = false;
	private timer: ReturnType<typeof setInterval> | undefined;

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
		this.input.onSubmit = () => this.submitOrRestart();

		const snapshots = sortSnapshots(this.host.getSnapshots());
		const initialId =
			options.initialId ??
			(snapshots.length === 1 ? snapshots[0]?.id : undefined);
		if (initialId) {
			const index = snapshots.findIndex(
				(snapshot) => snapshot.id === initialId,
			);
			if (index >= 0) {
				this.selectedIndex = index;
				this.openDetail(initialId);
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
		this.stopTimer();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(4, width);
		this.syncTimer();
		return this.view === "list"
			? this.renderList(safeWidth)
			: this.renderDetail(safeWidth);
	}

	// ---------------------------------------------------------------- input

	private handleListInput(data: string): void {
		const snapshots = sortSnapshots(this.host.getSnapshots());
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.selectedIndex = Math.min(
				Math.max(0, snapshots.length - 1),
				this.selectedIndex + 1,
			);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "home")) {
			this.selectedIndex = 0;
			this.requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			this.selectedIndex = Math.max(0, snapshots.length - 1);
			this.requestRender();
			return;
		}
		if (/^[1-9]$/.test(data)) {
			const target = snapshots[Number(data) - 1];
			if (target) {
				this.selectedIndex = Number(data) - 1;
				this.openDetail(target.id);
			}
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const selected = snapshots[this.selectedIndex];
			if (selected) this.openDetail(selected.id);
			return;
		}
		if (data === "x") {
			const selected = snapshots[this.selectedIndex];
			if (selected) this.runAction(() => this.host.stopAgent(selected.id));
			return;
		}
		if (data === "r") {
			const selected = snapshots[this.selectedIndex];
			if (selected) this.runAction(() => this.host.restartAgent(selected.id));
			return;
		}
		if (data === "c") {
			this.feedback = this.host.clearFinished();
			this.requestRender();
			return;
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
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.cycleAgent(matchesKey(data, "shift+tab") ? -1 : 1);
			return;
		}
		if (matchesKey(data, "up")) {
			this.scrollFromBottom += 1;
			this.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 1);
			this.requestRender();
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
		if (matchesKey(data, "ctrl+t")) {
			this.sendMode = this.sendMode === "steer" ? "followUp" : "steer";
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

	private cycleAgent(step: number): void {
		const snapshots = sortSnapshots(this.host.getSnapshots());
		if (snapshots.length < 2) return;
		const currentIndex = snapshots.findIndex(
			(snapshot) => snapshot.id === this.selectedId,
		);
		const nextIndex =
			(currentIndex + step + snapshots.length) % snapshots.length;
		const next = snapshots[nextIndex];
		if (next) {
			this.selectedIndex = nextIndex;
			this.openDetail(next.id);
		}
	}

	private close(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopTimer();
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

	// -------------------------------------------------------------- actions

	private runAction(action: () => Promise<string>): void {
		this.feedback = "Working...";
		this.requestRender();
		void action()
			.then((result) => {
				this.feedback = result;
				this.requestRender();
			})
			.catch((error) => {
				this.feedback = `Error: ${error instanceof Error ? error.message : String(error)}`;
				this.requestRender();
			});
	}

	private submitOrRestart(): void {
		const selected = this.selectedSnapshot();
		if (!selected) return;
		if (selected.status === "failed" || selected.status === "stopped") {
			this.restartSelected();
			return;
		}
		this.submitInstruction(this.sendMode);
	}

	private submitInstruction(delivery: SendMode): void {
		const selected = this.selectedSnapshot();
		const message = this.input.getValue().trim();
		if (!selected || !message) return;
		this.input.setValue("");
		this.scrollFromBottom = 0;
		this.runAction(() =>
			this.host.sendInstruction(selected.id, message, delivery),
		);
	}

	private restartSelected(): void {
		const selected = this.selectedSnapshot();
		if (!selected) return;
		const replacement = this.input.getValue().trim() || undefined;
		this.input.setValue("");
		this.scrollFromBottom = 0;
		this.runAction(() => this.host.restartAgent(selected.id, replacement));
	}

	private stopSelected(): void {
		const selected = this.selectedSnapshot();
		if (!selected) return;
		this.runAction(() => this.host.stopAgent(selected.id));
	}

	// ------------------------------------------------------------ animation

	private syncTimer(): void {
		const needsTick = this.host
			.getSnapshots()
			.some((snapshot) => isActiveStatus(snapshot.status));
		if (needsTick && !this.timer && !this.disposed) {
			this.timer = setInterval(() => {
				this.tui.requestRender();
			}, SPINNER_INTERVAL_MS);
		} else if (!needsTick && this.timer) {
			this.stopTimer();
		}
	}

	private stopTimer(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	// ------------------------------------------------------------ rendering

	private statusIcon(snapshot: SubagentSnapshot): string {
		if (isActiveStatus(snapshot.status)) {
			return this.theme.fg("accent", spinnerFrame());
		}
		return this.theme.fg(
			STATUS_COLOR[snapshot.status],
			STATUS_ICON[snapshot.status],
		);
	}

	private border(character: string): string {
		return this.theme.fg("border", character);
	}

	private pad(text: string, width: number): string {
		const clipped = truncateToWidth(text, width, this.theme.fg("dim", "…"));
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

	private divider(width: number): string {
		return ` ${this.theme.fg("dim", "─".repeat(Math.max(1, width - 4)))}`;
	}

	private listBodyRows(): number {
		return Math.max(
			4,
			Math.min(16, Math.floor(this.tui.terminal.rows * 0.72) - 9),
		);
	}

	private detailBodyRows(): number {
		return Math.max(
			5,
			Math.min(18, Math.floor(this.tui.terminal.rows * 0.72) - 12),
		);
	}

	// ----------------------------------------------------------- list view

	private renderList(width: number): string[] {
		const snapshots = sortSnapshots(this.host.getSnapshots());
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, snapshots.length - 1),
		);
		const config = this.host.getConfig();
		const running = snapshots.filter((snapshot) =>
			isActiveStatus(snapshot.status),
		).length;
		const queued = snapshots.filter(
			(snapshot) => snapshot.status === "queued",
		).length;
		const unread = snapshots.filter((snapshot) => snapshot.unread).length;
		const summary = [
			running ? `${running} running` : "",
			queued ? `${queued} queued` : "",
			unread ? `${unread} unread` : "",
		]
			.filter(Boolean)
			.join(" · ");
		const lines: string[] = [
			` ${this.theme.fg("toolTitle", this.theme.bold("Subagents"))} ${this.theme.fg("dim", summary || "idle")}  ${this.theme.fg("dim", `${snapshots.length}/${config.maxAgents}`)}`,
			this.divider(width),
		];

		if (!snapshots.length) {
			lines.push(
				` ${this.theme.fg("muted", "No background subagents yet.")}`,
				"",
				` ${this.theme.fg("dim", "Ask the model to delegate work with the")}`,
				` ${this.theme.fg("dim", "subagent tool, e.g. \"spawn an explorer to")}`,
				` ${this.theme.fg("dim", "map the auth flow\". /subagent configures")}`,
				` ${this.theme.fg("dim", "profile model/thinking overrides.")}`,
			);
		} else {
			const visibleRows = this.listBodyRows();
			const rowsPerAgent = 2;
			const agentWindow = Math.max(1, Math.floor(visibleRows / rowsPerAgent));
			const windowStart = Math.max(
				0,
				Math.min(
					this.selectedIndex - Math.floor(agentWindow / 2),
					snapshots.length - agentWindow,
				),
			);
			for (
				let index = windowStart;
				index < Math.min(snapshots.length, windowStart + agentWindow);
				index++
			) {
				const snapshot = snapshots[index];
				if (!snapshot) continue;
				lines.push(...this.listRow(snapshot, index, width));
			}
			if (snapshots.length > agentWindow) {
				lines.push(
					` ${this.theme.fg("dim", `${windowStart + 1}-${Math.min(snapshots.length, windowStart + agentWindow)} of ${snapshots.length}`)}`,
				);
			}
		}

		if (this.feedback) {
			lines.push(
				` ${this.theme.fg(this.feedback.startsWith("Error:") ? "error" : "dim", this.feedback)}`,
			);
		}
		lines.push(
			this.divider(width),
			` ${this.theme.fg("dim", "↑↓ select · Enter view · x stop · r restart · c clear · Esc")}`,
		);
		return this.frame(lines, width);
	}

	private listRow(
		snapshot: SubagentSnapshot,
		index: number,
		width: number,
	): string[] {
		const selected = index === this.selectedIndex;
		const marker = selected ? this.theme.fg("accent", "❯") : " ";
		const icon = this.statusIcon(snapshot);
		const label = selected
			? this.theme.fg("accent", this.theme.bold(snapshot.label))
			: this.theme.fg("text", snapshot.label);
		const unreadMark = snapshot.unread
			? this.theme.fg("warning", " unread")
			: "";

		const elapsed = formatDuration(
			snapshot.startedAt,
			snapshot.endedAt ?? Date.now(),
		);
		const statsParts = [
			elapsed,
			snapshot.usage.output ? `↓ ${formatTokens(snapshot.usage.output)}` : "",
		].filter(Boolean);
		const stats =
			snapshot.status === "queued" ? "queued" : statsParts.join(" · ");
		const statsWidth = stats ? visibleWidth(stats) + 2 : 0;

		const innerWidth = width - 2;
		const leftBudget = Math.max(10, innerWidth - 3 - statsWidth);
		let left = `${marker} ${icon} ${this.theme.fg("dim", snapshot.id)} ${label}${unreadMark}`;
		if (innerWidth >= 56) {
			left += ` ${this.theme.fg("muted", `[${snapshot.agentName}]`)}`;
		}
		const leftClipped = truncateToWidth(
			left,
			leftBudget,
			this.theme.fg("dim", "…"),
		);
		const gap = Math.max(
			1,
			innerWidth - 1 - visibleWidth(leftClipped) - (stats ? visibleWidth(stats) : 0),
		);
		const row = `${leftClipped}${stats ? `${" ".repeat(gap)}${this.theme.fg("dim", stats)}` : ""}`;

		const rows = [row];
		const detailLine = selected
			? (snapshot.currentActivity ??
				(snapshot.error
					? `error: ${snapshot.error}`
					: snapshot.lastOutput || undefined))
			: undefined;
		if (detailLine) {
			rows.push(
				`   ${this.theme.fg("dim", "⎿")} ${this.theme.fg(snapshot.error ? "error" : "dim", truncateToWidth(detailLine.replace(/[\r\n\t]+/g, " "), Math.max(8, width - 9), "…"))}`,
			);
		}
		return rows;
	}

	// --------------------------------------------------------- detail view

	private renderDetail(width: number): string[] {
		const snapshot = this.selectedSnapshot();
		if (!snapshot) {
			this.view = "list";
			return this.renderList(width);
		}

		const innerWidth = Math.max(1, width - 2);
		const snapshots = sortSnapshots(this.host.getSnapshots());
		const position = snapshots.findIndex(
			(item) => item.id === snapshot.id,
		);
		const positionText =
			snapshots.length > 1 ? ` (${position + 1}/${snapshots.length})` : "";

		const statusText = this.theme.fg(
			STATUS_COLOR[snapshot.status],
			snapshot.status,
		);
		const elapsed = formatDuration(
			snapshot.startedAt,
			snapshot.endedAt ?? Date.now(),
		);
		const stats = formatStats(snapshot.usage);
		const metaParts = [
			snapshot.agentName,
			snapshot.model,
			elapsed,
			stats,
			snapshot.maxTurns
				? `turns ${snapshot.usage.turns}/${snapshot.maxTurns}`
				: "",
			snapshot.usage.cost ? `$${snapshot.usage.cost.toFixed(2)}` : "",
			snapshot.runCount > 1 ? `run ${snapshot.runCount}` : "",
		].filter(Boolean);

		const lines: string[] = [
			` ${this.statusIcon(snapshot)} ${this.theme.fg("toolTitle", this.theme.bold(snapshot.label))} ${this.theme.fg("dim", snapshot.id)}  ${statusText}${this.theme.fg("dim", positionText)}`,
			` ${this.theme.fg("dim", metaParts.join(" · "))}`,
			` ${this.theme.fg("dim", `Task: ${snapshot.task.replace(/[\r\n\t]+/g, " ")}`)}`,
			this.divider(width),
		];

		const transcript = this.renderTranscript(
			snapshot,
			Math.max(8, innerWidth - 2),
		);
		const bodyRows = Math.min(
			this.detailBodyRows(),
			Math.max(transcript.length, 3),
		);
		const maxOffset = Math.max(0, transcript.length - bodyRows);
		this.scrollFromBottom = Math.min(this.scrollFromBottom, maxOffset);
		const end = Math.max(0, transcript.length - this.scrollFromBottom);
		const start = Math.max(0, end - bodyRows);
		const visible = transcript.slice(start, end);
		while (visible.length < bodyRows) visible.unshift("");
		for (const line of visible) lines.push(` ${line}`);
		if (this.scrollFromBottom > 0) {
			lines.push(
				` ${this.theme.fg("warning", `▾ ${this.scrollFromBottom} newer lines · ↓ to follow`)}`,
			);
		}

		lines.push(this.divider(width));
		if (isActiveStatus(snapshot.status)) {
			const activity = snapshot.currentActivity ?? "Working...";
			const liveStats = [
				elapsed,
				snapshot.usage.output
					? `↓ ${formatTokens(snapshot.usage.output)}`
					: "",
			]
				.filter(Boolean)
				.join(" · ");
			lines.push(
				` ${this.theme.fg("accent", spinnerFrame())} ${this.theme.fg("warning", truncateToWidth(activity, Math.max(8, innerWidth - 18), "…"))} ${this.theme.fg("dim", `(${liveStats})`)}`,
			);
		} else if (snapshot.error) {
			lines.push(
				` ${this.theme.fg("error", truncateToWidth(`✗ ${snapshot.error.replace(/[\r\n\t]+/g, " ")}`, Math.max(8, innerWidth - 2), "…"))}`,
			);
		}

		const mode = this.inputModeLabel(snapshot);
		this.input.focused = this.focused && this.view === "detail";
		const modeWidth = visibleWidth(mode.label) + 3;
		const [inputLine = ""] = this.input.render(
			Math.max(1, innerWidth - modeWidth),
		);
		lines.push(` ${mode.label} ${inputLine}`);
		if (this.feedback) {
			lines.push(
				` ${this.theme.fg(this.feedback.startsWith("Error:") ? "error" : "dim", this.feedback)}`,
			);
		}
		lines.push(
			` ${this.theme.fg("dim", mode.hint)}`,
		);
		return this.frame(lines, width);
	}

	private inputModeLabel(snapshot: SubagentSnapshot): {
		label: string;
		hint: string;
	} {
		if (snapshot.status === "running") {
			const label =
				this.sendMode === "steer"
					? this.theme.fg("accent", "[steer]")
					: this.theme.fg("warning", "[follow-up]");
			return {
				label,
				hint: "Enter send · ^T mode · Tab agent · ^X stop · Esc back",
			};
		}
		if (snapshot.status === "starting" || snapshot.status === "queued") {
			return {
				label: this.theme.fg("dim", "[on start]"),
				hint: "Enter attaches at start · Tab agent · ^X stop · Esc back",
			};
		}
		if (snapshot.status === "completed") {
			return {
				label: this.theme.fg("success", "[continue]"),
				hint: "Enter continues this conversation · Tab agent · Esc back",
			};
		}
		return {
			label: this.theme.fg("muted", "[restart]"),
			hint: "Enter restarts fresh (input = new task) · Tab agent · Esc back",
		};
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
		if (!items.length) {
			return [this.theme.fg("muted", "(waiting for output)")];
		}

		const lines: string[] = [];
		let previousKind: TimelineKind | undefined;
		for (const item of items) {
			if (
				lines.length &&
				(item.kind === "user" ||
					(item.kind === "assistant" && previousKind !== "assistant"))
			) {
				lines.push("");
			}
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
			previousKind = item.kind;
		}
		return lines;
	}
}

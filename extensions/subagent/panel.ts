/** Keyboard-focused transcript overlay for background subagent workers. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Input,
	Markdown,
	matchesKey,
	type OverlayOptions,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

import { PANEL_FINAL_OUTPUT_CHARS } from "./constants.ts";
import {
	formatDuration,
	formatStats,
	formatTokens,
	isActiveStatus,
	isTerminalStatus,
	sortSnapshots,
	SPINNER_INTERVAL_MS,
	spinnerFrame,
	STATUS_COLOR,
	STATUS_ICON,
	truncateText,
} from "./format.ts";
import type {
	SubagentPanelHost,
	SubagentSnapshot,
	TimelineItem,
	TimelineKind,
	ToolActivity,
} from "./types.ts";

/**
 * Overlay geometry tiers, chosen once when the panel opens: near-full width on
 * narrow terminals (a split view would cramp both halves), proportional on
 * normal ones, and an absolute cap on very wide ones so transcript lines stay
 * readable. Percent values keep tracking live resizes; reopening re-tiers.
 */
export function panelOverlayOptions(
	columns: number,
	rows: number,
): OverlayOptions {
	const base = {
		anchor: "top-right" as const,
		maxHeight: (rows < 30 ? "85%" : "72%") as `${number}%`,
		margin: { top: 1, right: 1 },
	};
	if (columns < 100) return { ...base, width: "96%", minWidth: 40 };
	if (columns <= 170) return { ...base, width: "62%", minWidth: 56 };
	return { ...base, width: 104 };
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

export class SubagentPanel implements Component {
	focused = false;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly host: SubagentPanelHost;
	private readonly done: () => void;
	private readonly input = new Input();
	/**
	 * One Markdown component per completed assistant message; the component
	 * caches its own rendered lines per width, so repeat frames are free.
	 * Timeline items are immutable (trimming drops whole items), which keeps
	 * the cache sound.
	 */
	private readonly markdownCache = new WeakMap<TimelineItem, Markdown>();
	private readonly finalMarkdownCache = new Map<
		string,
		{ text: string; component: Markdown }
	>();
	private selectedId: string | undefined;
	private scrollFromBottom = 0;
	/** True when the last render had more transcript than fits; drives the scroll hint. */
	private scrollable = false;
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
		this.input.onSubmit = () => this.submitPrimary();

		const snapshots = sortSnapshots(this.host.getSnapshots());
		const initial =
			(options.initialId &&
				snapshots.find((snapshot) => snapshot.id === options.initialId)) ||
			snapshots[0];
		if (initial) {
			this.selectedId = initial.id;
			this.host.markViewed(initial.id);
		}
	}

	requestRender(): void {
		if (!this.disposed) this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.close();
			return;
		}
		// Terminal convention: ctrl+c interrupts the running work. When nothing
		// is running it falls back to "get me out" and closes like Esc.
		if (matchesKey(data, "ctrl+c")) {
			const selected = this.selectedSnapshot();
			if (selected && isActiveStatus(selected.status)) this.stopSelected();
			else this.close();
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
			this.scrollFromBottom += this.halfPage();
			this.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollFromBottom = Math.max(
				0,
				this.scrollFromBottom - this.halfPage(),
			);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "home")) {
			this.scrollFromBottom = Number.MAX_SAFE_INTEGER; // render clamps to top
			this.requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			this.scrollFromBottom = 0;
			this.requestRender();
			return;
		}
		this.feedback = ""; // typing resumes the contextual hint
		this.input.handleInput(data);
		this.requestRender();
	}

	invalidate(): void {
		this.input.invalidate();
		for (const entry of this.finalMarkdownCache.values()) {
			entry.component.invalidate();
		}
	}

	dispose(): void {
		this.disposed = true;
		this.stopTimer();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(4, width);
		this.syncTimer();
		return this.renderTranscriptView(safeWidth);
	}

	// ---------------------------------------------------------------- state

	private cycleAgent(step: number): void {
		const snapshots = sortSnapshots(this.host.getSnapshots());
		if (snapshots.length < 2) return;
		const currentIndex = snapshots.findIndex(
			(snapshot) => snapshot.id === this.selectedId,
		);
		const nextIndex =
			currentIndex < 0
				? 0
				: (currentIndex + step + snapshots.length) % snapshots.length;
		const next = snapshots[nextIndex];
		if (next) {
			this.selectedId = next.id;
			this.scrollFromBottom = 0;
			this.feedback = "";
			this.host.markViewed(next.id);
			this.requestRender();
		}
	}

	private close(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopTimer();
		this.done();
	}

	private selectedSnapshot(): SubagentSnapshot | undefined {
		const snapshots = this.host.getSnapshots();
		return (
			snapshots.find((snapshot) => snapshot.id === this.selectedId) ??
			sortSnapshots(snapshots)[0]
		);
	}

	private halfPage(): number {
		return Math.max(4, Math.floor(this.heightBudget() / 2));
	}

	/** Height must mirror panelOverlayOptions' maxHeight fraction so the frame never clips. */
	private heightFraction(): number {
		return this.tui.terminal.rows < 30 ? 0.85 : 0.72;
	}

	private showMetaLine(): boolean {
		return this.tui.terminal.rows >= 22;
	}

	private heightBudget(): number {
		const rows = this.tui.terminal.rows;
		// Worst-case chrome: borders 2, header 1 (+meta), dividers 2, scroll
		// banner 1, live/error line 1, input 1, hint 1.
		const chrome = this.showMetaLine() ? 10 : 9;
		return Math.max(
			3,
			Math.min(30, Math.floor(rows * this.heightFraction()) - chrome),
		);
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

	/** Enter always does the one thing the mode label announces. */
	private submitPrimary(): void {
		const selected = this.selectedSnapshot();
		if (!selected) return;
		if (selected.status === "failed" || selected.status === "stopped") {
			this.restartSelected();
			return;
		}
		const message = this.input.getValue().trim();
		if (!message) {
			this.feedback =
				selected.status === "completed"
					? "Type a message first — Enter continues this conversation with it."
					: "Type a message first — Enter sends it to this worker.";
			this.requestRender();
			return;
		}
		this.input.setValue("");
		this.scrollFromBottom = 0;
		this.runAction(() => this.host.sendInstruction(selected.id, message));
	}

	private restartSelected(): void {
		const selected = this.selectedSnapshot();
		if (!selected) return;
		const replacement = this.input.getValue().trim() || undefined;
		this.input.setValue("");
		this.scrollFromBottom = 0;
		this.runAction(() =>
			this.host.sendInstruction(selected.id, replacement, true),
		);
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

	private renderTranscriptView(width: number): string[] {
		const snapshot = this.selectedSnapshot();
		if (!snapshot) {
			return this.frame(
				[
					` ${this.theme.fg("muted", "No background subagents yet.")}`,
					` ${this.theme.fg("dim", "Ask the model to delegate work with the subagent tool.")}`,
					` ${this.theme.fg("dim", "/agents settings — set profile model/thinking")}`,
					` ${this.theme.fg("dim", "Esc close")}`,
				],
				width,
			);
		}
		this.selectedId = snapshot.id;
		// Seeing the transcript counts as reading a completion that lands mid-view.
		if (snapshot.unread) this.host.markViewed(snapshot.id);

		const innerWidth = Math.max(1, width - 2);
		const snapshots = sortSnapshots(this.host.getSnapshots());
		const position = snapshots.findIndex((item) => item.id === snapshot.id);

		const statusText = this.theme.fg(
			STATUS_COLOR[snapshot.status],
			snapshot.status,
		);
		const elapsed = formatDuration(
			snapshot.startedAt,
			snapshot.endedAt ?? Date.now(),
		);

		const lines: string[] = [
			` ${this.statusIcon(snapshot)} ${this.theme.fg("toolTitle", this.theme.bold(snapshot.label))} ${this.theme.fg("dim", snapshot.id)}  ${statusText}`,
		];
		if (this.showMetaLine()) {
			// Ordered by importance so narrow-width truncation drops the tail first.
			const metaParts = [
				snapshot.agentName,
				snapshot.model,
				elapsed,
				formatStats(snapshot.usage),
				snapshot.usage.cost ? `$${snapshot.usage.cost.toFixed(2)}` : "",
				snapshot.runCount > 1 ? `run ${snapshot.runCount}` : "",
			].filter(Boolean);
			lines.push(` ${this.theme.fg("dim", metaParts.join(" · "))}`);
		}
		lines.push(this.divider(width));

		const transcript = this.renderTranscript(
			snapshot,
			Math.max(8, innerWidth - 2),
		);
		const bodyRows = Math.min(
			this.heightBudget(),
			Math.max(transcript.length, 3),
		);
		this.scrollable = transcript.length > bodyRows;
		const maxOffset = Math.max(0, transcript.length - bodyRows);
		this.scrollFromBottom = Math.min(this.scrollFromBottom, maxOffset);
		const end = Math.max(0, transcript.length - this.scrollFromBottom);
		const start = Math.max(0, end - bodyRows);
		const visible = transcript.slice(start, end);
		while (visible.length < bodyRows) visible.unshift("");
		for (const line of visible) lines.push(` ${line}`);
		if (this.scrollFromBottom > 0) {
			const noun = this.scrollFromBottom === 1 ? "newer line" : "newer lines";
			lines.push(
				` ${this.theme.fg("warning", `▾ ${this.scrollFromBottom} ${noun} · End to follow`)}`,
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

		const mode = this.inputModeLabel(snapshot, position, snapshots.length);
		this.input.focused = this.focused;
		const modeWidth = visibleWidth(mode.label) + 3;
		const [inputLine = ""] = this.input.render(
			Math.max(1, innerWidth - modeWidth),
		);
		lines.push(` ${mode.label} ${inputLine}`);
		lines.push(
			` ${
				this.feedback
					? this.theme.fg(
							this.feedback.startsWith("Error:") ? "error" : "dim",
							this.feedback,
						)
					: this.theme.fg("dim", mode.hint)
			}`,
		);
		return this.frame(lines, width);
	}

	/**
	 * The label names what Enter does; the hint lists only currently-usable
	 * keys so guidance appears exactly when an action becomes available.
	 */
	private inputModeLabel(
		snapshot: SubagentSnapshot,
		position: number,
		total: number,
	): {
		label: string;
		hint: string;
	} {
		let label: string;
		let action: string;
		if (snapshot.status === "running") {
			label = this.theme.fg("accent", "[send]");
			action = "Enter send";
		} else if (
			snapshot.status === "starting" ||
			snapshot.status === "queued"
		) {
			label = this.theme.fg("dim", "[on start]");
			action = "Enter attach";
		} else if (snapshot.status === "completed") {
			label = this.theme.fg("success", "[continue]");
			action = "Enter continue";
		} else {
			label = this.theme.fg("warning", "[rerun]");
			action = "Enter rerun (typed text = new task)";
		}

		const parts = [action];
		if (this.scrollable) parts.push("↑↓ scroll");
		if (total > 1) parts.push(`Tab next (${position + 1}/${total})`);
		if (isActiveStatus(snapshot.status)) parts.push("^C stop");
		parts.push("Esc close");
		return { label, hint: parts.join(" · ") };
	}

	private markdownLines(item: TimelineItem, width: number): string[] {
		let component = this.markdownCache.get(item);
		if (!component) {
			component = new Markdown(item.text, 0, 0, getMarkdownTheme());
			this.markdownCache.set(item, component);
		}
		return component.render(Math.max(1, width));
	}

	private finalMarkdownLines(
		snapshot: SubagentSnapshot,
		width: number,
	): string[] {
		const text = truncateText(
			snapshot.lastOutput,
			PANEL_FINAL_OUTPUT_CHARS,
			"final result",
		);
		let cached = this.finalMarkdownCache.get(snapshot.id);
		if (!cached || cached.text !== text) {
			cached = {
				text,
				component: new Markdown(text, 0, 0, getMarkdownTheme()),
			};
			this.finalMarkdownCache.set(snapshot.id, cached);
		}
		return cached.component.render(Math.max(1, width));
	}

	private activityIcon(activity: ToolActivity): string {
		if (activity.status === "running") {
			return this.theme.fg("accent", spinnerFrame());
		}
		if (activity.status === "failed") return this.theme.fg("error", "✗");
		return this.theme.fg("success", "✓");
	}

	private renderActivities(
		snapshot: SubagentSnapshot,
		width: number,
	): string[] {
		const maxVisible = 12;
		const visible = snapshot.activities.slice(-maxVisible);
		const omitted =
			snapshot.omittedActivities +
			Math.max(0, snapshot.activities.length - visible.length);
		if (!visible.length && !omitted) return [];

		const lines = [this.theme.fg("muted", this.theme.bold("Activity"))];
		if (omitted) {
			lines.push(
				this.theme.fg("dim", `… ${omitted} earlier tool activities omitted`),
			);
		}
		for (const activity of visible) {
			const prefix = `${this.activityIcon(activity)} `;
			const wrapped = wrapPlainLine(
				activity.summary,
				Math.max(1, width - visibleWidth(prefix)),
			);
			for (let index = 0; index < wrapped.length; index++) {
				const actualPrefix =
					index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
				lines.push(
					`${actualPrefix}${this.theme.fg(activity.status === "failed" ? "error" : "toolOutput", wrapped[index] ?? "")}`,
				);
			}
			if (activity.resultSummary) {
				const resultPrefix = "  ⎿ ";
				const resultLines = wrapPlainLine(
					activity.resultSummary,
					Math.max(1, width - visibleWidth(resultPrefix)),
				);
				for (let index = 0; index < resultLines.length; index++) {
					const actualPrefix =
						index === 0
							? resultPrefix
							: " ".repeat(visibleWidth(resultPrefix));
					lines.push(
						`${this.theme.fg("dim", actualPrefix)}${this.theme.fg(activity.status === "failed" ? "error" : "dim", resultLines[index] ?? "")}`,
					);
				}
			}
		}
		return lines;
	}

	private renderTranscript(
		snapshot: SubagentSnapshot,
		width: number,
	): string[] {
		const terminal = isTerminalStatus(snapshot.status);
		const items: TimelineItem[] = snapshot.timeline
			.slice(-100)
			.filter(
				(item) =>
					item.kind !== "tool" &&
					item.kind !== "toolResult" &&
					!(terminal && item.kind === "assistant" && item.text === snapshot.lastOutput),
			);
		const lines = this.renderActivities(snapshot, width);
		let previousKind: TimelineKind | undefined;
		for (const item of items) {
			if (
				lines.length &&
				(item.kind === "user" ||
					(item.kind === "assistant" && previousKind !== "assistant"))
			) {
				lines.push("");
			}
			if (item.kind === "assistant") {
				for (const line of this.markdownLines(item, Math.max(1, width - 2))) {
					lines.push(`  ${line}`);
				}
			} else {
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
			previousKind = item.kind;
		}
		if (snapshot.liveText) {
			// The streaming tail stays plain text: half-written markdown (open
			// fences, partial tables) re-renders unstably frame to frame.
			if (lines.length) lines.push("");
			for (const line of wrapPlainLine(
				snapshot.liveText,
				Math.max(1, width - 2),
			)) {
				lines.push(`  ${this.theme.fg("text", line)}`);
			}
		}
		if (terminal && snapshot.lastOutput) {
			if (lines.length) lines.push("");
			lines.push(this.theme.fg("muted", this.theme.bold("Result")));
			for (const line of this.finalMarkdownLines(snapshot, width)) {
				lines.push(line);
			}
		}
		if (!lines.length) {
			return [this.theme.fg("muted", "(waiting for output)")];
		}
		return lines;
	}
}

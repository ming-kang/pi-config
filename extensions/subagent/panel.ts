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
	BRAILLE_INTERVAL_MS,
	brailleFrame,
	formatAgentType,
	formatDuration,
	formatMetaParts,
	formatTokens,
	isActiveStatus,
	isTerminalStatus,
	oneLine,
	shortAgentType,
	sortSnapshots,
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

/** How many recent tools stay expanded in the rail. */
const TOOLS_VISIBLE = 6;
/** Cap body rows so the modal stays a card, not a full-screen dump. */
const BODY_ROWS_CAP = 16;

/**
 * Compact centered card. Lower maxHeight than earlier builds — the fleet
 * panel should skim, not scroll like a second session transcript.
 */
export function panelOverlayOptions(
	columns: number,
	rows: number,
): OverlayOptions {
	const maxHeight = (
		rows < 24 ? "78%" : rows < 36 ? "68%" : "60%"
	) as `${number}%`;
	const margin = { top: 1, right: 2, bottom: 1, left: 2 };
	if (columns < 90) {
		return {
			anchor: "center",
			width: "94%",
			minWidth: 36,
			maxHeight,
			margin,
		};
	}
	if (columns < 120) {
		return {
			anchor: "center",
			width: "70%",
			minWidth: 52,
			maxHeight,
			margin,
		};
	}
	if (columns <= 170) {
		return {
			anchor: "center",
			width: "56%",
			minWidth: 60,
			maxHeight,
			margin,
		};
	}
	return {
		anchor: "center",
		width: 96,
		maxHeight,
		margin,
	};
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
	/** Streaming reply — updated via setText so partial Markdown reflows. */
	private liveMarkdown: Markdown | undefined;
	private liveMarkdownText = "";
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
			this.scrollFromBottom = Number.MAX_SAFE_INTEGER;
			this.requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			this.scrollFromBottom = 0;
			this.requestRender();
			return;
		}
		this.feedback = "";
		this.input.handleInput(data);
		this.requestRender();
	}

	invalidate(): void {
		this.input.invalidate();
		this.liveMarkdown?.invalidate();
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
		const total = this.host.getSnapshots().length;
		return Math.max(3, Math.floor(this.heightBudget(total) / 2));
	}

	/** Must mirror panelOverlayOptions maxHeight so the frame never clips. */
	private heightFraction(): number {
		const rows = this.tui.terminal.rows;
		if (rows < 24) return 0.78;
		if (rows < 36) return 0.68;
		return 0.6;
	}

	private showMetaLine(): boolean {
		return this.tui.terminal.rows >= 16;
	}

	private showWorkerTabs(total: number): boolean {
		return total > 1 && this.tui.terminal.rows >= 14;
	}

	private heightBudget(totalWorkers: number): number {
		const rows = this.tui.terminal.rows;
		// Frame + dividers + pulse + input + hint ≈ 7.
		let chrome = 7;
		if (this.showMetaLine()) chrome += 1;
		if (this.showWorkerTabs(totalWorkers)) chrome += 1;
		return Math.max(
			3,
			Math.min(BODY_ROWS_CAP, Math.floor(rows * this.heightFraction()) - chrome),
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
		const selected = this.selectedSnapshot();
		const needsTick = Boolean(
			selected && isActiveStatus(selected.status) && !this.disposed,
		);
		if (needsTick && !this.timer) {
			this.timer = setInterval(() => {
				this.tui.requestRender();
			}, BRAILLE_INTERVAL_MS);
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

	// ------------------------------------------------------------ chrome

	private edge(character: string): string {
		return this.theme.fg("borderAccent", character);
	}

	private frameTop(left: string, right: string, width: number): string {
		const leftPart = left
			? `${this.edge("─")} ${left} `
			: this.edge("─");
		const rightPart = right ? ` ${right} ${this.edge("─")}` : "";
		const fill = Math.max(
			1,
			width - 2 - visibleWidth(leftPart) - visibleWidth(rightPart),
		);
		return `${this.edge("╭")}${leftPart}${this.edge("─".repeat(fill))}${rightPart}${this.edge("╮")}`;
	}

	private frameBottom(width: number): string {
		return this.edge(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
	}

	private frameSide(text: string, innerWidth: number): string {
		const clipped = truncateToWidth(text, innerWidth, this.theme.fg("dim", "…"));
		const pad = Math.max(0, innerWidth - visibleWidth(clipped));
		return `${this.edge("│")}${clipped}${" ".repeat(pad)}${this.edge("│")}`;
	}

	private frame(
		contentLines: string[],
		width: number,
		topLeft: string,
		topRight = "",
	): string[] {
		const innerWidth = Math.max(1, width - 2);
		return [
			this.frameTop(topLeft, topRight, width),
			...contentLines.map((line) => this.frameSide(line, innerWidth)),
			this.frameBottom(width),
		];
	}

	private divider(innerWidth: number): string {
		const rule = Math.max(1, innerWidth - 2);
		return ` ${this.theme.fg("border", "─".repeat(rule))}`;
	}

	private statusIcon(snapshot: SubagentSnapshot, animate: boolean): string {
		if (animate && isActiveStatus(snapshot.status)) {
			return this.theme.fg("accent", brailleFrame());
		}
		return this.theme.fg(
			STATUS_COLOR[snapshot.status],
			STATUS_ICON[snapshot.status],
		);
	}

	/**
	 * Tab label: prefer spawn description so same-type workers stay distinct.
	 * All chips share the same naming style.
	 */
	private tabName(snapshot: SubagentSnapshot, compact: boolean): string {
		const label = snapshot.label?.trim();
		if (
			label &&
			label.toLowerCase() !== snapshot.agentName.trim().toLowerCase()
		) {
			return compact ? oneLine(label, 12) : oneLine(label, 18);
		}
		return compact
			? shortAgentType(snapshot.agentName)
			: formatAgentType(snapshot.agentName);
	}

	private renderWorkerTabs(
		snapshots: SubagentSnapshot[],
		selectedId: string,
		width: number,
	): string {
		const budget = Math.max(8, width - 1);

		const build = (compact: boolean): string => {
			const parts: string[] = [];
			for (const snapshot of snapshots) {
				const selected = snapshot.id === selectedId;
				const name = this.tabName(snapshot, compact);
				if (selected) {
					parts.push(
						this.theme.bg(
							"selectedBg",
							this.theme.fg("toolTitle", this.theme.bold(` ${name} `)),
						),
					);
					continue;
				}
				const glyph = this.theme.fg(
					STATUS_COLOR[snapshot.status],
					isActiveStatus(snapshot.status)
						? brailleFrame()
						: STATUS_ICON[snapshot.status],
				);
				parts.push(`${this.theme.fg("muted", ` ${name} `)}${glyph} `);
			}
			return parts.join("");
		};

		let joined = build(false);
		if (visibleWidth(joined) > budget) joined = build(true);
		return truncateToWidth(` ${joined}`, width, this.theme.fg("dim", "…"));
	}

	// ------------------------------------------------------------ rendering

	private renderTranscriptView(width: number): string[] {
		const snapshot = this.selectedSnapshot();
		if (!snapshot) {
			return this.frame(
				[
					"",
					` ${this.theme.fg("muted", "No background workers yet.")}`,
					` ${this.theme.fg("dim", "Spawn with the subagent tool, then Alt+O.")}`,
					"",
					` ${this.theme.fg("dim", "Esc close")}`,
				],
				width,
				this.theme.fg("toolTitle", this.theme.bold("Subagents")),
			);
		}
		this.selectedId = snapshot.id;
		if (snapshot.unread) this.host.markViewed(snapshot.id);

		const innerWidth = Math.max(1, width - 2);
		const contentWidth = Math.max(8, innerWidth - 2);
		const snapshots = sortSnapshots(this.host.getSnapshots());
		const position = snapshots.findIndex((item) => item.id === snapshot.id);
		const live = isActiveStatus(snapshot.status);
		const multi = this.showWorkerTabs(snapshots.length);
		const typeTitle = formatAgentType(snapshot.agentName);

		const topLeft = multi
			? `${this.theme.fg("toolTitle", this.theme.bold("Subagents"))}${this.theme.fg("dim", ` · ${snapshots.length}`)}`
			: `${this.statusIcon(snapshot, live)} ${this.theme.fg("toolTitle", this.theme.bold(typeTitle))}${snapshot.unread ? this.theme.fg("warning", "*") : ""}`;
		const topRight = multi
			? ""
			: live
				? ""
				: this.theme.fg(STATUS_COLOR[snapshot.status], snapshot.status);

		const lines: string[] = [];

		if (multi) {
			lines.push(
				this.renderWorkerTabs(snapshots, snapshot.id, contentWidth + 1),
			);
		}

		// One dim meta line: id · optional task label · stats.
		if (this.showMetaLine()) {
			const label = this.oneLineTask(snapshot);
			const bits = [
				snapshot.id,
				label,
				...formatMetaParts(snapshot),
			].filter(Boolean);
			const meta = bits.join(" · ");
			if (meta) {
				lines.push(
					` ${this.theme.fg("dim", truncateToWidth(meta, contentWidth, "…"))}`,
				);
			}
		}

		lines.push(this.divider(innerWidth));

		const transcript = this.renderBody(snapshot, contentWidth);
		const bodyRows = Math.min(
			this.heightBudget(snapshots.length),
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
				` ${this.theme.fg("warning", `▾ ${this.scrollFromBottom} ${noun} · End`)}`,
			);
		}

		lines.push(this.divider(innerWidth));

		// Status row above input — Pi Loader braille, never a solid ●.
		if (live) {
			const activity = snapshot.currentActivity ?? "Working...";
			const elapsed = formatDuration(
				snapshot.startedAt,
				snapshot.endedAt ?? Date.now(),
			);
			const liveStats = [
				elapsed,
				snapshot.usage.output
					? `↓${formatTokens(snapshot.usage.output)}`
					: "",
			]
				.filter(Boolean)
				.join(" · ");
			const spinner = this.theme.fg("accent", brailleFrame());
			const activityBudget = Math.max(
				8,
				contentWidth - visibleWidth(liveStats) - 4,
			);
			lines.push(
				` ${spinner} ${this.theme.fg("muted", truncateToWidth(activity, activityBudget, "…"))}${liveStats ? this.theme.fg("dim", ` ${liveStats}`) : ""}`,
			);
		} else if (snapshot.error) {
			lines.push(
				` ${this.theme.fg("error", truncateToWidth(`✗ ${snapshot.error.replace(/[\r\n\t]+/g, " ")}`, contentWidth, "…"))}`,
			);
		} else {
			lines.push("");
		}

		const mode = this.inputModeLabel(snapshot, position, snapshots.length);
		this.input.focused = this.focused;
		const modeWidth = visibleWidth(mode.label) + 1;
		const [inputLine = ""] = this.input.render(
			Math.max(1, contentWidth - modeWidth + 1),
		);
		lines.push(` ${mode.label}${inputLine}`);
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
		return this.frame(lines, width, topLeft, topRight);
	}

	/** Mode word only — Input owns the `> ` glyph. */
	private inputModeLabel(
		snapshot: SubagentSnapshot,
		position: number,
		total: number,
	): {
		label: string;
		hint: string;
	} {
		let word: string;
		let color: "accent" | "dim" | "success" | "warning";
		let action: string;
		if (snapshot.status === "running") {
			word = "send";
			color = "accent";
			action = "Enter send";
		} else if (
			snapshot.status === "starting" ||
			snapshot.status === "queued"
		) {
			word = "on start";
			color = "dim";
			action = "Enter attach";
		} else if (snapshot.status === "completed") {
			word = "continue";
			color = "success";
			action = "Enter continue";
		} else {
			word = "rerun";
			color = "warning";
			action = "Enter rerun (typed text = new task)";
		}

		const label = `${this.theme.fg(color, word)} `;
		const parts = [action];
		if (this.scrollable) parts.push("↑↓ scroll");
		if (total > 1) {
			const index = position >= 0 ? position + 1 : 1;
			parts.push(`Tab ${index}/${total}`);
		}
		if (isActiveStatus(snapshot.status)) parts.push("^C stop");
		parts.push("Esc");
		return { label, hint: parts.join(" · ") };
	}

	// ------------------------------------------------------- body sections

	/**
	 * Compact narrative:
	 *   tools (last few) → reply stream / final result
	 * Task lives on the meta line, not as a multi-line dump.
	 */
	private renderBody(snapshot: SubagentSnapshot, width: number): string[] {
		const lines: string[] = [];

		const tools = this.renderTools(snapshot, width);
		if (tools.length) lines.push(...tools);

		const result = this.renderResult(snapshot, width);
		if (result.length) {
			if (lines.length) lines.push("");
			lines.push(...result);
		}

		if (!lines.length) {
			return [this.theme.fg("muted", "(waiting for output)")];
		}
		return lines;
	}

	/** One-line task label for the meta row (never a multi-line brief). */
	private oneLineTask(snapshot: SubagentSnapshot): string {
		const label = snapshot.label?.trim();
		if (
			label &&
			label.toLowerCase() !== snapshot.agentName.trim().toLowerCase()
		) {
			return oneLine(label, 36);
		}
		const task = snapshot.task?.trim();
		return task ? oneLine(task, 36) : "";
	}

	/**
	 * Tool rail — last N tools, one line each. No success footnotes (those
	 * doubled height for every read). Errors still show a dim note.
	 */
	private renderTools(snapshot: SubagentSnapshot, width: number): string[] {
		const visible = snapshot.activities.slice(-TOOLS_VISIBLE);
		const omitted =
			snapshot.omittedActivities +
			Math.max(0, snapshot.activities.length - visible.length);
		if (!visible.length && !omitted) return [];

		const lines: string[] = [];
		if (omitted) {
			lines.push(this.theme.fg("dim", `… +${omitted} tools`));
		}
		for (const activity of visible) {
			const icon = this.activityIcon(activity);
			const prefix = `${icon} `;
			const summaryColor =
				activity.status === "failed"
					? "error"
					: activity.status === "running"
						? "text"
						: "toolOutput";
			// Single truncated line — wrap only if the first wrap is still short.
			const text = truncateToWidth(
				activity.summary,
				Math.max(1, width - visibleWidth(prefix)),
				"…",
			);
			lines.push(`${prefix}${this.theme.fg(summaryColor, text)}`);
			if (activity.status === "failed" && activity.resultSummary) {
				lines.push(
					this.theme.fg(
						"error",
						truncateToWidth(`  ${activity.resultSummary}`, width, "…"),
					),
				);
			}
		}
		return lines;
	}

	/**
	 * Reply / result block.
	 * While live: streaming Markdown only (skip intermediate plan chatter).
	 * When terminal: final result Markdown only.
	 * Steers always show when present.
	 */
	private renderResult(snapshot: SubagentSnapshot, width: number): string[] {
		const terminal = isTerminalStatus(snapshot.status);
		const lines: string[] = [];

		// Steers (user messages after the initial spawn).
		for (const item of this.steerMessages(snapshot)) {
			const prefix = this.theme.fg("dim", "› ");
			const text = truncateToWidth(
				oneLine(item.text, 400),
				Math.max(1, width - visibleWidth("› ")),
				"…",
			);
			lines.push(`${prefix}${this.theme.fg("muted", text)}`);
		}

		if (snapshot.liveText) {
			if (lines.length) lines.push("");
			for (const line of this.liveMarkdownLines(snapshot.liveText, width)) {
				lines.push(line);
			}
			return lines;
		}

		if (terminal && snapshot.lastOutput) {
			if (lines.length) lines.push("");
			for (const line of this.finalMarkdownLines(snapshot, width)) {
				lines.push(line);
			}
			return lines;
		}

		// Settled mid-turn without live text: show last intermediate assistant
		// only (not the whole plan history).
		if (!terminal) {
			const lastAssistant = this.lastAssistantItem(snapshot);
			if (lastAssistant) {
				if (lines.length) lines.push("");
				for (const line of this.markdownLines(lastAssistant, width)) {
					lines.push(line);
				}
			}
		}

		return lines;
	}

	private steerMessages(snapshot: SubagentSnapshot): TimelineItem[] {
		const task = snapshot.task?.trim() ?? "";
		let skippedInitial = false;
		const steers: TimelineItem[] = [];
		for (const item of snapshot.timeline) {
			if (item.kind !== "user") continue;
			if (!skippedInitial) {
				skippedInitial = true;
				if (
					!task ||
					item.text.trim() === task ||
					item.text.includes(task.slice(0, 80))
				) {
					continue;
				}
			}
			steers.push(item);
		}
		// Keep the rail short — last two steers only.
		return steers.slice(-2);
	}

	private lastAssistantItem(
		snapshot: SubagentSnapshot,
	): TimelineItem | undefined {
		for (let i = snapshot.timeline.length - 1; i >= 0; i--) {
			const item = snapshot.timeline[i];
			if (item?.kind === "assistant") return item;
		}
		return undefined;
	}

	private markdownLines(item: TimelineItem, width: number): string[] {
		let component = this.markdownCache.get(item);
		if (!component) {
			component = new Markdown(item.text, 0, 0, getMarkdownTheme());
			this.markdownCache.set(item, component);
		}
		return component.render(Math.max(1, width));
	}

	/** Streaming Markdown — same path Pi uses for partial assistant text. */
	private liveMarkdownLines(text: string, width: number): string[] {
		if (!this.liveMarkdown) {
			this.liveMarkdown = new Markdown(text, 0, 0, getMarkdownTheme());
			this.liveMarkdownText = text;
		} else if (this.liveMarkdownText !== text) {
			this.liveMarkdown.setText(text);
			this.liveMarkdownText = text;
		}
		return this.liveMarkdown.render(Math.max(1, width));
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
			// Same braille family as Pi Loader — not a solid disc.
			return this.theme.fg("accent", brailleFrame());
		}
		if (activity.status === "failed") return this.theme.fg("error", "✗");
		return this.theme.fg("success", "✓");
	}
}

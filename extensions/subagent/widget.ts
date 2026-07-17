/** Persistent below-editor widget: live subagent list in Claude Code's footer style. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

import {
	formatDuration,
	formatTokens,
	isActiveStatus,
	SPINNER_INTERVAL_MS,
	spinnerFrame,
	STATUS_COLOR,
	STATUS_ICON,
} from "./format.ts";
import type { SubagentSnapshot, SubagentStatus } from "./types.ts";

const MAX_ROWS = 5;

const WIDGET_STATUS_ORDER: Record<SubagentStatus, number> = {
	running: 0,
	starting: 1,
	queued: 2,
	failed: 3,
	completed: 4,
	stopped: 5,
};

function sortForWidget(snapshots: SubagentSnapshot[]): SubagentSnapshot[] {
	return [...snapshots].sort((first, second) => {
		const statusDelta =
			WIDGET_STATUS_ORDER[first.status] - WIDGET_STATUS_ORDER[second.status];
		return statusDelta || second.updatedAt - first.updatedAt;
	});
}

export class SubagentFooterWidget implements Component {
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly getSnapshots: () => SubagentSnapshot[],
	) {}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	invalidate(): void {
		// Stateless between renders; nothing cached to drop.
	}

	/** Repaint on state changes; the interval only covers active-worker animation. */
	requestRender(): void {
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const snapshots = sortForWidget(this.getSnapshots());
		this.syncTimer(snapshots);
		if (!snapshots.length) return [];

		const safeWidth = Math.max(20, width);
		const lines: string[] = [this.headerLine(snapshots, safeWidth)];
		for (const snapshot of snapshots.slice(0, MAX_ROWS)) {
			lines.push(this.agentLine(snapshot, safeWidth));
		}
		if (snapshots.length > MAX_ROWS) {
			lines.push(
				` ${this.theme.fg("dim", `… +${snapshots.length - MAX_ROWS} more`)}`,
			);
		}
		return lines;
	}

	/** Animate only while a worker is active; terminal rows are static. */
	private syncTimer(snapshots: SubagentSnapshot[]): void {
		const needsTick = snapshots.some((snapshot) =>
			isActiveStatus(snapshot.status),
		);
		if (needsTick && !this.timer) {
			this.timer = setInterval(() => {
				this.tui.requestRender();
			}, SPINNER_INTERVAL_MS);
		} else if (!needsTick && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	private headerLine(snapshots: SubagentSnapshot[], width: number): string {
		const unread = snapshots.filter((snapshot) => snapshot.unread).length;
		const summary = unread ? `${unread} unread · ` : "";
		const hint = `${summary}alt+o view · ctrl+alt+a manage`;
		return ` ${truncateToWidth(this.theme.fg("dim", hint), width - 2)}`;
	}

	private agentLine(snapshot: SubagentSnapshot, width: number): string {
		const active = isActiveStatus(snapshot.status);
		const icon = active
			? this.theme.fg("accent", spinnerFrame())
			: this.theme.fg(STATUS_COLOR[snapshot.status], STATUS_ICON[snapshot.status]);
		const unreadMark = snapshot.unread ? this.theme.fg("warning", "*") : "";

		const elapsed = formatDuration(
			snapshot.startedAt,
			snapshot.endedAt ?? Date.now(),
		);
		const statsParts = [
			elapsed,
			snapshot.usage.output ? `↓ ${formatTokens(snapshot.usage.output)}` : "",
		].filter(Boolean);
		const statsText =
			snapshot.status === "queued" ? "queued" : statsParts.join(" · ");
		const stats = width >= 52 ? statsText : "";
		const statsWidth = stats ? visibleWidth(stats) + 2 : 0;

		const leftBudget = Math.max(8, width - 4 - statsWidth);
		let left = `${this.theme.fg("text", snapshot.label)}${unreadMark}`;
		if (width >= 68) {
			left = `${this.theme.fg("dim", snapshot.id)} ${left} ${this.theme.fg("muted", `[${snapshot.agentName}]`)}`;
		}
		if (active && snapshot.currentActivity && width >= 84) {
			left += ` ${this.theme.fg("dim", snapshot.currentActivity)}`;
		}
		const leftClipped = truncateToWidth(
			left,
			leftBudget,
			this.theme.fg("dim", "…"),
		);

		const gap = Math.max(
			1,
			width - 3 - visibleWidth(leftClipped) - (stats ? visibleWidth(stats) : 0),
		);
		const tail = stats
			? `${" ".repeat(gap)}${this.theme.fg("dim", stats)}`
			: "";
		return ` ${icon} ${leftClipped}${tail}`;
	}
}

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { getTodoState } from "./state.ts";
import { renderOverlayLines } from "./view.ts";

const WIDGET_KEY = "pi-config-todos";

export class TodoOverlay {
	private ui: ExtensionUIContext | undefined;
	private tui: TUI | undefined;
	private registered = false;
	private completedPendingHide = new Set<number>();
	private hiddenCompleted = new Set<number>();
	/** Pure render cache: same width + same visibility sets → skip rebuild. */
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	setUI(ui: ExtensionUIContext): void {
		if (this.ui === ui) return;
		this.dispose();
		this.ui = ui;
	}

	resetVisibility(): void {
		this.completedPendingHide.clear();
		this.hiddenCompleted.clear();
		this.invalidateRenderCache();
	}

	hideCompletedFromPreviousTurn(): void {
		for (const id of this.completedPendingHide) this.hiddenCompleted.add(id);
		this.completedPendingHide.clear();
		this.invalidateRenderCache();
		this.tui?.requestRender();
	}

	update(): void {
		if (!this.ui) return;
		// Visibility bookkeeping belongs here (state mutation time), not in render,
		// so paint can stay pure and width-cacheable.
		this.syncVisibilityFromState();
		this.invalidateRenderCache();

		if (!this.registered) {
			this.ui.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.render(theme, width),
						invalidate: () => {
							this.registered = false;
							this.tui = undefined;
							this.invalidateRenderCache();
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.registered = true;
			return;
		}
		this.tui?.requestRender();
	}

	/** Drop completed ids that no longer exist; queue newly completed for next-turn hide. */
	private syncVisibilityFromState(): void {
		const state = getTodoState();
		const completed = new Set(state.items.filter((item) => item.status === "completed").map((item) => item.id));
		for (const id of [...this.completedPendingHide]) {
			if (!completed.has(id)) this.completedPendingHide.delete(id);
		}
		for (const id of [...this.hiddenCompleted]) {
			if (!completed.has(id)) this.hiddenCompleted.delete(id);
		}
		for (const item of state.items) {
			if (item.status !== "completed") continue;
			if (this.hiddenCompleted.has(item.id) || this.completedPendingHide.has(item.id)) continue;
			this.completedPendingHide.add(item.id);
		}
	}

	private invalidateRenderCache(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private render(theme: Theme, width: number): string[] {
		const w = Math.max(1, width);
		if (this.cachedLines !== undefined && this.cachedWidth === w) return this.cachedLines;

		const state = getTodoState();
		const lines = renderOverlayLines(state, theme, w, this.hiddenCompleted);
		this.cachedWidth = w;
		this.cachedLines = lines;

		if (lines.length === 0 && this.ui && this.registered) {
			queueMicrotask(() => {
				this.ui?.setWidget(WIDGET_KEY, undefined);
				this.registered = false;
				this.tui = undefined;
				this.invalidateRenderCache();
			});
		}
		return lines;
	}

	dispose(): void {
		this.ui?.setWidget(WIDGET_KEY, undefined);
		this.tui = undefined;
		this.registered = false;
		this.ui = undefined;
		this.resetVisibility();
	}
}

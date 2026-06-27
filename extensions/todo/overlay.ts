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

	setUI(ui: ExtensionUIContext): void {
		if (this.ui === ui) return;
		this.dispose();
		this.ui = ui;
	}

	resetVisibility(): void {
		this.completedPendingHide.clear();
		this.hiddenCompleted.clear();
	}

	hideCompletedFromPreviousTurn(): void {
		for (const id of this.completedPendingHide) this.hiddenCompleted.add(id);
		this.completedPendingHide.clear();
		this.tui?.requestRender();
	}

	update(): void {
		if (!this.ui) return;
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

	private render(theme: Theme, width: number): string[] {
		const state = getTodoState();
		const completed = new Set(state.items.filter((item) => item.status === "completed").map((item) => item.id));
		for (const id of [...this.completedPendingHide]) {
			if (!completed.has(id)) this.completedPendingHide.delete(id);
		}
		for (const id of [...this.hiddenCompleted]) {
			if (!completed.has(id)) this.hiddenCompleted.delete(id);
		}

		const lines = renderOverlayLines(state, theme, Math.max(1, width), this.hiddenCompleted);
		const newlyShown = state.items
			.filter((item) => item.status === "completed")
			.filter((item) => !this.hiddenCompleted.has(item.id) && !this.completedPendingHide.has(item.id))
			.map((item) => item.id);
		for (const id of newlyShown) this.completedPendingHide.add(id);

		if (lines.length === 0 && this.ui && this.registered) {
			queueMicrotask(() => {
				this.ui?.setWidget(WIDGET_KEY, undefined);
				this.registered = false;
				this.tui = undefined;
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

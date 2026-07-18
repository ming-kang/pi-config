/** Multi-select model catalog used by the probe flow. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { truncate } from "./constants.ts";

export type ProbeChecklistResult =
	| { kind: "save"; selectedIds: string[] }
	| { kind: "cancel" };

export function createProbeChecklist(
	providerLabel: string,
	models: Array<{ id: string; name?: string }>,
): (tui: TUI, theme: Theme, _kb: unknown, done: (result: ProbeChecklistResult) => void) => Container {
	return (tui, theme, _kb, done) => {
		const selected = new Set(models.map((model) => model.id));
		let index = 0;
		let offset = 0;
		const viewport = Math.min(12, Math.max(1, models.length));
		const container = new Container() as Container & {
			render: (width: number) => string[];
			handleInput: (data: string) => void;
		};

		const refresh = () => {
			container.invalidate();
			tui.requestRender();
		};

		const keepVisible = () => {
			if (index < offset) offset = index;
			if (index >= offset + viewport) offset = index - viewport + 1;
		};

		container.render = (width: number): string[] => {
			const lines = [theme.fg("accent", theme.bold(`Probe results · ${providerLabel}`)), ""];
			const end = Math.min(models.length, offset + viewport);
			for (let row = offset; row < end; row++) {
				const model = models[row]!;
				const active = row === index;
				const cursor = active ? theme.fg("accent", "▶") : " ";
				const box = selected.has(model.id) ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
				const detail = model.name && model.name !== model.id ? ` — ${model.name}` : "";
				const text = truncate(`${model.id}${detail}`, Math.max(12, width - 9));
				lines.push(`${cursor} ${box} ${active ? theme.fg("accent", text) : theme.fg("text", text)}`);
			}
			if (models.length > viewport) {
				lines.push(theme.fg("dim", `  showing ${offset + 1}–${end} of ${models.length}`));
			}
			lines.push("");
			lines.push(
				theme.fg(
					"dim",
					`  ${selected.size}/${models.length} selected · ↑↓ move · Space toggle · A all/none · Enter add · Esc cancel`,
				),
			);
			return lines;
		};

		container.handleInput = (data: string) => {
			if (matchesKey(data, Key.up)) {
				index = index === 0 ? models.length - 1 : index - 1;
				keepVisible();
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				index = index === models.length - 1 ? 0 : index + 1;
				keepVisible();
				refresh();
				return;
			}
			if (data === " ") {
				const model = models[index];
				if (model) {
					if (selected.has(model.id)) selected.delete(model.id);
					else selected.add(model.id);
					refresh();
				}
				return;
			}
			if (data === "a" || data === "A") {
				if (selected.size === models.length) selected.clear();
				else for (const model of models) selected.add(model.id);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				done({ kind: "save", selectedIds: models.map((model) => model.id).filter((id) => selected.has(id)) });
				return;
			}
			if (matchesKey(data, Key.escape)) done({ kind: "cancel" });
		};

		return container;
	};
}

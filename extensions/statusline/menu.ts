/**
 * menu.ts — the `/statusline` settings menu, mirroring the /rewind menu
 * pattern: a select loop over live-labeled items, Esc to close.
 *
 * Every change is persisted immediately via saveStatuslineConfig and pushed to
 * the caller through `onChange`, so the footer picks it up on the next render
 * frame — no /reload needed.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { requireInteractiveUI } from "../shared/extension-ui.ts";
import { loadStatuslineConfig, saveStatuslineConfig, type StatuslineConfig } from "./config.ts";

const WARN_PRESETS = [50, 60, 70, 80, 85];
const ERROR_PRESETS = [75, 80, 85, 90, 95];

export async function runStatuslineMenu(
	ctx: ExtensionCommandContext,
	onChange: (next: StatuslineConfig) => void,
): Promise<void> {
	if (!requireInteractiveUI(ctx, "/statusline")) return;

	for (;;) {
		const cfg = loadStatuslineConfig();

		const usageLabel = `Usage stats (↑ ↓ R $): ${cfg.showUsageStats ? "on" : "off"}`;
		const line2Label = `Extension status line: ${cfg.showStatusLine2 ? "on" : "off"}`;
		const warnLabel = `CTX warning color from: ${cfg.ctxWarnPct}%`;
		const errorLabel = `CTX error color from: ${cfg.ctxErrorPct}%`;

		const pick = await ctx.ui.select("Statusline settings (Esc to close)", [
			usageLabel,
			line2Label,
			warnLabel,
			errorLabel,
		]);
		if (!pick) return;

		if (pick === usageLabel) {
			apply(ctx, onChange, { ...cfg, showUsageStats: !cfg.showUsageStats });
		} else if (pick === line2Label) {
			apply(ctx, onChange, { ...cfg, showStatusLine2: !cfg.showStatusLine2 });
		} else if (pick === warnLabel) {
			const pct = await pickPercent(ctx, "CTX warning color from", WARN_PRESETS, cfg.ctxWarnPct);
			// normalizeConfig keeps error >= warn, so raising warn drags error along.
			if (pct !== undefined) apply(ctx, onChange, { ...cfg, ctxWarnPct: pct, ctxErrorPct: Math.max(pct, cfg.ctxErrorPct) });
		} else if (pick === errorLabel) {
			const pct = await pickPercent(ctx, "CTX error color from", ERROR_PRESETS, cfg.ctxErrorPct);
			// Lowering error below warn pulls warn down with it (tiers stay ordered).
			if (pct !== undefined) apply(ctx, onChange, { ...cfg, ctxErrorPct: pct, ctxWarnPct: Math.min(pct, cfg.ctxWarnPct) });
		}
	}
}

/** Persist + notify + push to the live footer. */
function apply(ctx: ExtensionCommandContext, onChange: (next: StatuslineConfig) => void, next: StatuslineConfig): void {
	if (!saveStatuslineConfig(next)) {
		ctx.ui.notify("Failed to save statusline settings.", "warning");
		return;
	}
	onChange(loadStatuslineConfig());
}

/** Preset percentages + Custom… input, clamped to 0-100. Undefined = cancelled. */
async function pickPercent(
	ctx: ExtensionCommandContext,
	title: string,
	presets: number[],
	current: number,
): Promise<number | undefined> {
	const options = [...presets.map((p) => `${p}%${p === current ? " (current)" : ""}`), "Custom..."];
	const pick = await ctx.ui.select(title, options);
	if (!pick) return undefined;

	if (pick === "Custom...") {
		const value = await ctx.ui.input("Percentage (0-100)");
		if (value === undefined) return undefined;
		const n = Number.parseFloat(value.trim());
		if (!Number.isFinite(n) || n < 0 || n > 100) {
			ctx.ui.notify("Invalid percentage.", "warning");
			return undefined;
		}
		return n;
	}
	return Number.parseInt(pick, 10);
}

/**
 * statusline — custom status line (footer) for Pi.
 *
 * Replaces Pi's built-in footer with a compact, color-coded status line:
 *   left:  Model · Effort · ctx 23% · ~cwd · branch
 *   right: ↑in ↓out Rcache $cost   (each part omitted when zero)
 *   line 2 (only when set): extension statuses from ctx.ui.setStatus(), e.g. advisor
 *
 * Color mapping (via theme.fg — adapts to any loaded theme, not just ice-cream):
 *   model  -> toolTitle   (cream in ice-cream)
 *   ctx    -> accent / warning / error  (by usage tier)
 *   cwd    -> success     (sage in ice-cream)
 *   branch -> accent
 *   effort -> theme.getThinkingBorderColor  (thinking-level gradient)
 *
 * Auto-enables on session_start. Pi's setFooter returns a renderable that
 * re-reads live data each render, so the line stays current without manual
 * refresh. Effort (thinking level) is recovered from session branch entries.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Shorten a path to ~ relative to home. */
function shortCwd(cwd: string): string {
	const rawHome = process.env.USERPROFILE || process.env.HOME || "";
	// Strip trailing separators so the offset used by cwd.slice(home.length) lines
	// up with the normalized prefix even when the env var ends with a slash.
	const home = rawHome.replace(/[\\/]+$/, "");
	if (home) {
		const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
		const h = norm(home);
		const c = norm(cwd);
		if (c === h) return "~";
		if (c.startsWith(h + "/")) return "~" + cwd.slice(home.length).replace(/\\/g, "/");
	}
	return cwd;
}

/** Format token count: 999 -> 999, 1200 -> 1.2k, 1500000 -> 1.5M. */
function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

/** Flatten a status to one line: drop control chars, collapse spaces. */
function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Read current thinking level from session branch entries. */
function currentThinkingLevel(branch: SessionEntry[]): ThinkingLevel {
	let level: ThinkingLevel = "off";
	for (const e of branch) {
		if (e.type === "thinking_level_change") level = e.thinkingLevel as ThinkingLevel;
	}
	return level;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// Right side: token stats + cost from the current branch.
					const branchEntries = ctx.sessionManager.getBranch();
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					let cost = 0;
					for (const e of branchEntries) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							input += m.usage?.input ?? 0;
							output += m.usage?.output ?? 0;
							cost += m.usage?.cost?.total ?? 0;
							cacheRead += m.usage?.cacheRead ?? 0;
						}
					}
					const statParts: string[] = [];
					if (input > 0) statParts.push(`↑${fmtTokens(input)}`);
					if (output > 0) statParts.push(`↓${fmtTokens(output)}`);
					if (cacheRead > 0) statParts.push(`R${fmtTokens(cacheRead)}`);
					if (cost > 0) statParts.push(`$${cost.toFixed(3)}`);
					const right = statParts.length > 0 ? theme.fg("dim", statParts.join(" ")) : "";

					// Left side: Model · Effort · CTX% · CWD · Branch
					const model = ctx.model;
					const parts: string[] = [];
					parts.push(theme.fg("toolTitle", model?.name ?? "no-model"));

					// Effort: only when model supports reasoning and level isn't off.
					if (model?.reasoning) {
						const level = currentThinkingLevel(branchEntries);
						if (level !== "off") parts.push(theme.getThinkingBorderColor(level)(level));
					}

					// Context percentage.
					const usage = ctx.getContextUsage();
					const ctxPct = usage?.percent;
					if (ctxPct == null) {
						parts.push(theme.fg("accent", "CTX ?%"));
					} else if (ctxPct > 90) {
						parts.push(theme.fg("error", `CTX ${ctxPct.toFixed(1)}%`));
					} else if (ctxPct > 70) {
						parts.push(theme.fg("warning", `CTX ${ctxPct.toFixed(1)}%`));
					} else {
						parts.push(theme.fg("accent", `CTX ${ctxPct.toFixed(1)}%`));
					}

					// Cwd.
					parts.push(theme.fg("success", shortCwd(ctx.cwd)));

					// Branch (if any).
					const branch = footerData.getGitBranch();
					if (branch) parts.push(theme.fg("accent", branch));

					const sep = theme.fg("dim", " · ");
					const left = parts.join(sep);

					// Layout: right-align the token/cost stats, left-align the rest.
					// When the terminal is too narrow, keep the right side intact and
					// truncate the left — token stats are more useful than a long cwd.
					const leftW = visibleWidth(left);
					const rightW = visibleWidth(right);
					const mainLine =
						leftW + rightW >= width
							? truncateToWidth(truncateToWidth(left, Math.max(0, width - rightW)) + right, width)
							: left + " ".repeat(width - leftW - rightW) + right;
					const lines = [mainLine];

					// Extension statuses (e.g. advisor) on a second line, mirroring Pi's
					// built-in footer. The custom footer replaces the built-in, so without
					// this any ctx.ui.setStatus() text would silently vanish. Sorted by key.
					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const statusLine = Array.from(statuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatus(text))
							.join("  ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}
					return lines;
				},
			};
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
	});
}

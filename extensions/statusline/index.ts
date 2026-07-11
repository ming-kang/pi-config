/**
 * statusline — fixed two-line footer for Pi.
 *
 * Line 1 favors human-readable session identity:
 *   Model (provider) · effort · CTX used/window · ~cwd · branch
 *
 * Line 2 mirrors the useful native usage details:
 *   ↑input ↓output Rcache-read Wcache-write CHhit-rate $cost (sub)
 *
 * Extension statuses share the right side of line 2 when present. Pi does not
 * expose auto-compaction state to custom footer factories, so the native
 * `(auto)` marker cannot be reproduced without depending on private APIs.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const CONTEXT_WARNING_PERCENT = 70;
const CONTEXT_ERROR_PERCENT = 90;

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface UsageSummary {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	latestCacheHitPercent?: number;
	totalCost: number;
}

function isTui(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui";
}

/** Shorten a path to `~` relative to the user's home directory. */
function formatWorkingDirectory(cwd: string): string {
	const rawHomeDirectory = process.env.USERPROFILE || process.env.HOME || "";
	const homeDirectory = rawHomeDirectory.replace(/[\\/]+$/, "");
	if (!homeDirectory) return cwd;

	const normalizePath = (filePath: string) => filePath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	const normalizedHomeDirectory = normalizePath(homeDirectory);
	const normalizedCwd = normalizePath(cwd);
	if (normalizedCwd === normalizedHomeDirectory) return "~";
	if (normalizedCwd.startsWith(`${normalizedHomeDirectory}/`)) {
		return `~${cwd.slice(homeDirectory.length).replace(/\\/g, "/")}`;
	}
	return cwd;
}

/** Format token counts like Pi's native footer: 999, 1.2k, 34k, 1.0M. */
function formatTokenCount(tokenCount: number): string {
	if (tokenCount < 1000) return `${tokenCount}`;
	if (tokenCount < 10_000) return `${(tokenCount / 1000).toFixed(1)}k`;
	if (tokenCount < 1_000_000) return `${Math.round(tokenCount / 1000)}k`;
	if (tokenCount < 10_000_000) return `${(tokenCount / 1_000_000).toFixed(1)}M`;
	return `${Math.round(tokenCount / 1_000_000)}M`;
}

/** Flatten extension status text to a single printable line. */
function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** Read the latest thinking level recorded on the active session branch. */
function getCurrentThinkingLevel(branchEntries: SessionEntry[]): ThinkingLevel {
	let thinkingLevel: ThinkingLevel = "off";
	for (const entry of branchEntries) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel as ThinkingLevel;
		}
	}
	return thinkingLevel;
}

/** Aggregate usage totals and the latest request's cache-hit percentage. */
function summarizeUsage(branchEntries: SessionEntry[]): UsageSummary {
	const summary: UsageSummary = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalCost: 0,
	};

	for (const entry of branchEntries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const assistantMessage = entry.message as AssistantMessage;
		const inputTokens = assistantMessage.usage?.input ?? 0;
		const outputTokens = assistantMessage.usage?.output ?? 0;
		const cacheReadTokens = assistantMessage.usage?.cacheRead ?? 0;
		const cacheWriteTokens = assistantMessage.usage?.cacheWrite ?? 0;

		summary.inputTokens += inputTokens;
		summary.outputTokens += outputTokens;
		summary.cacheReadTokens += cacheReadTokens;
		summary.cacheWriteTokens += cacheWriteTokens;
		summary.totalCost += assistantMessage.usage?.cost?.total ?? 0;

		const latestPromptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
		const latestRequestUsedCache = cacheReadTokens > 0 || cacheWriteTokens > 0;
		summary.latestCacheHitPercent =
			latestRequestUsedCache && latestPromptTokens > 0
				? (cacheReadTokens / latestPromptTokens) * 100
				: undefined;
	}

	return summary;
}

function formatContextUsage(ctx: ExtensionContext, theme: Theme): string {
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow;
	const contextWindowSuffix = contextWindow ? `/${formatTokenCount(contextWindow)}` : "";
	if (contextUsage?.percent == null) {
		return theme.fg("accent", `CTX ?%${contextWindowSuffix}`);
	}

	const label = `CTX ${contextUsage.percent.toFixed(1)}%${contextWindowSuffix}`;
	if (contextUsage.percent > CONTEXT_ERROR_PERCENT) return theme.fg("error", label);
	if (contextUsage.percent > CONTEXT_WARNING_PERCENT) return theme.fg("warning", label);
	return theme.fg("accent", label);
}

function formatUsageSummary(summary: UsageSummary, usesSubscription: boolean, theme: Theme): string {
	const usageParts: string[] = [];
	if (summary.inputTokens > 0) usageParts.push(`↑${formatTokenCount(summary.inputTokens)}`);
	if (summary.outputTokens > 0) usageParts.push(`↓${formatTokenCount(summary.outputTokens)}`);
	if (summary.cacheReadTokens > 0) usageParts.push(`R${formatTokenCount(summary.cacheReadTokens)}`);
	if (summary.cacheWriteTokens > 0) usageParts.push(`W${formatTokenCount(summary.cacheWriteTokens)}`);
	if (summary.latestCacheHitPercent !== undefined) {
		usageParts.push(`CH${summary.latestCacheHitPercent.toFixed(1)}%`);
	}
	if (summary.totalCost > 0) {
		usageParts.push(`$${summary.totalCost.toFixed(3)}${usesSubscription ? " (sub)" : ""}`);
	}
	if (usageParts.length === 0) return "";
	return theme.fg("dim", usageParts.join(" "));
}

function formatExtensionStatuses(statuses: ReadonlyMap<string, string>, theme: Theme): string {
	const statusText = Array.from(statuses.entries())
		.sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey))
		.map(([, text]) => sanitizeStatus(text))
		.filter(Boolean)
		.join("  ");
	return statusText ? theme.fg("muted", statusText) : "";
}

/** Keep usage visible and right-align extension statuses when space permits. */
function layoutSecondaryLine(usageText: string, statusText: string, width: number, theme: Theme): string | undefined {
	if (!usageText && !statusText) return undefined;
	if (!usageText) return truncateToWidth(statusText, width, theme.fg("dim", "..."));
	if (!statusText) return truncateToWidth(usageText, width, theme.fg("dim", "..."));

	const usageWidth = visibleWidth(usageText);
	const statusWidth = visibleWidth(statusText);
	if (usageWidth + statusWidth < width) {
		return usageText + " ".repeat(width - usageWidth - statusWidth) + statusText;
	}

	if (usageWidth >= width) return truncateToWidth(usageText, width, theme.fg("dim", "..."));
	const remainingStatusWidth = width - usageWidth - 1;
	if (remainingStatusWidth < 4) return usageText;
	return `${usageText} ${truncateToWidth(statusText, remainingStatusWidth, theme.fg("dim", "..."))}`;
}

export default function statusline(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!isTui(ctx)) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribeFromBranchChanges = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsubscribeFromBranchChanges,
				invalidate() {},
				render(width: number): string[] {
					const branchEntries = ctx.sessionManager.getBranch();
					const model = ctx.model;
					const modelName = model?.name ?? model?.id ?? "no-model";
					let modelIdentity = theme.fg("toolTitle", theme.bold(modelName));
					if (model?.provider) {
						modelIdentity += ` ${theme.fg("muted", `(${model.provider})`)}`;
					}

					const primaryParts = [modelIdentity];
					if (model?.reasoning) {
						const thinkingLevel = getCurrentThinkingLevel(branchEntries);
						if (thinkingLevel !== "off") {
							primaryParts.push(theme.getThinkingBorderColor(thinkingLevel)(thinkingLevel));
						}
					}
					primaryParts.push(formatContextUsage(ctx, theme));
					primaryParts.push(theme.fg("success", formatWorkingDirectory(ctx.cwd)));

					const gitBranch = footerData.getGitBranch();
					if (gitBranch) primaryParts.push(theme.fg("accent", gitBranch));

					const separator = theme.fg("dim", " · ");
					const primaryLine = truncateToWidth(
						primaryParts.join(separator),
						width,
						theme.fg("dim", "..."),
					);

					const usageSummary = summarizeUsage(branchEntries);
					const usesSubscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;
					const usageLine = formatUsageSummary(usageSummary, usesSubscription, theme);
					const extensionStatuses = formatExtensionStatuses(footerData.getExtensionStatuses(), theme);
					const secondaryLine = layoutSecondaryLine(usageLine, extensionStatuses, width, theme);

					return secondaryLine ? [primaryLine, secondaryLine] : [primaryLine];
				},
			};
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (isTui(ctx)) ctx.ui.setFooter(undefined);
	});
}

import {
	completeSimple,
	type AssistantMessage,
	type StopReason,
	type ThinkingLevel,
	type Usage,
} from "@earendil-works/pi-ai/compat";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { advisorSystemPrompt } from "./constants.ts";
import { advisorCharBudget } from "./budget.ts";
import { buildAdvisorPacket } from "./context.ts";
import { modelKey } from "./config.ts";
import { getAdvisorEffort, getAdvisorModel } from "./restore.ts";
import { clampPreviousRuns, type AdvisorParams } from "./schema.ts";

export interface AdvisorDetails {
	advisorModel?: string;
	effort?: ThinkingLevel;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
	/** Assembled packet size in chars, and whether the fuse trimmed it. */
	packetChars?: number;
	packetTrimmed?: boolean;
}

function buildResult(opts: {
	text: string;
	advisorModel?: string;
	effort?: ThinkingLevel;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
	packetChars?: number;
	packetTrimmed?: boolean;
}): AgentToolResult<AdvisorDetails> {
	return {
		content: [{ type: "text", text: opts.text }],
		details: {
			...(opts.advisorModel ? { advisorModel: opts.advisorModel } : {}),
			...(opts.effort ? { effort: opts.effort } : {}),
			...(opts.usage ? { usage: opts.usage } : {}),
			...(opts.stopReason ? { stopReason: opts.stopReason } : {}),
			...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
			...(opts.packetChars !== undefined ? { packetChars: opts.packetChars } : {}),
			...(opts.packetTrimmed !== undefined ? { packetTrimmed: opts.packetTrimmed } : {}),
		},
	};
}

function textFromResponse(response: AssistantMessage): string {
	return response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export async function executeAdvisor(
	params: AdvisorParams,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AdvisorDetails> | undefined,
): Promise<AgentToolResult<AdvisorDetails>> {
	const advisor = getAdvisorModel();
	const effort = getAdvisorEffort();
	if (!advisor) {
		return buildResult({
			text: "Advisor is not configured. Run /advisor and select a reviewer model.",
			effort,
			errorMessage: "no advisor model selected",
		});
	}

	const advisorLabel = modelKey(advisor);

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(advisor);
	if (!auth.ok) {
		return buildResult({
			text: `Advisor model ${advisorLabel} is misconfigured: ${auth.error}`,
			advisorModel: advisorLabel,
			effort,
			errorMessage: auth.error,
		});
	}
	if (!auth.apiKey) {
		return buildResult({
			text: `Advisor model ${advisorLabel} has no API key configured.`,
			advisorModel: advisorLabel,
			effort,
			errorMessage: `missing API key for ${advisor.provider}`,
		});
	}

	const sessionContext = ctx.sessionManager.buildSessionContext();
	const previousRuns = clampPreviousRuns(params.previousRuns);
	const charBudget = advisorCharBudget(advisor.contextWindow, advisor.maxTokens);
	const packet = buildAdvisorPacket(params, sessionContext.messages, previousRuns, charBudget);

	// Fuse: refuse before spending a request that the provider would reject.
	if (packet.overBudget) {
		return buildResult({
			text: `Advisor packet (~${packet.packetChars} chars) exceeds the reviewer's context budget (~${charBudget} chars) even after truncating tool results. Retry with previousRuns: 0 and a shorter brief, or select a larger-context reviewer via /advisor.`,
			advisorModel: advisorLabel,
			effort,
			packetChars: packet.packetChars,
			errorMessage: "advisor packet over budget",
		});
	}

	const messages = [packet.message];

	onUpdate?.(
		buildResult({
			text: `Consulting advisor ${advisorLabel}${effort ? ` (${effort})` : ""}...`,
			advisorModel: advisorLabel,
			effort,
		}),
	);

	try {
		const response = await completeSimple(
			advisor,
			{ systemPrompt: advisorSystemPrompt(params.mode), messages, tools: [] },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal,
				reasoning: effort,
			},
		);

		const responseText = textFromResponse(response);
		if (response.stopReason === "aborted") {
			return buildResult({
				text: "Advisor call aborted.",
				advisorModel: advisorLabel,
				effort,
				usage: response.usage,
				stopReason: response.stopReason,
				errorMessage: response.errorMessage ?? "aborted",
				packetChars: packet.packetChars,
				packetTrimmed: packet.packetTrimmed,
			});
		}
		if (response.stopReason === "error") {
			return buildResult({
				text: `Advisor call failed: ${response.errorMessage ?? "unknown error"}`,
				advisorModel: advisorLabel,
				effort,
				usage: response.usage,
				stopReason: response.stopReason,
				errorMessage: response.errorMessage ?? "unknown error",
				packetChars: packet.packetChars,
				packetTrimmed: packet.packetTrimmed,
			});
		}
		if (!responseText) {
			return buildResult({
				text: "Advisor returned no text.",
				advisorModel: advisorLabel,
				effort,
				usage: response.usage,
				stopReason: response.stopReason,
				errorMessage: "empty advisor response",
				packetChars: packet.packetChars,
				packetTrimmed: packet.packetTrimmed,
			});
		}
		return buildResult({
			text: responseText,
			advisorModel: advisorLabel,
			effort,
			usage: response.usage,
			stopReason: response.stopReason,
			packetChars: packet.packetChars,
			packetTrimmed: packet.packetTrimmed,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return buildResult({
			text: `Advisor call threw: ${message}`,
			advisorModel: advisorLabel,
			effort,
			errorMessage: message,
			packetChars: packet.packetChars,
			packetTrimmed: packet.packetTrimmed,
		});
	}
}

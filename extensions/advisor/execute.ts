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
import { buildAdvisorMessage } from "./context.ts";
import { modelKey } from "./config.ts";
import { getAdvisorEffort, getAdvisorModel } from "./restore.ts";
import { clampPreviousRuns, type AdvisorParams } from "./schema.ts";

export interface AdvisorDetails {
	advisorModel?: string;
	effort?: ThinkingLevel;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}

function buildResult(opts: {
	text: string;
	advisorModel?: string;
	effort?: ThinkingLevel;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}): AgentToolResult<AdvisorDetails> {
	return {
		content: [{ type: "text", text: opts.text }],
		details: {
			...(opts.advisorModel ? { advisorModel: opts.advisorModel } : {}),
			...(opts.effort ? { effort: opts.effort } : {}),
			...(opts.usage ? { usage: opts.usage } : {}),
			...(opts.stopReason ? { stopReason: opts.stopReason } : {}),
			...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
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
	const messages = [buildAdvisorMessage(params, sessionContext.messages, previousRuns)];

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
			});
		}
		return buildResult({
			text: responseText,
			advisorModel: advisorLabel,
			effort,
			usage: response.usage,
			stopReason: response.stopReason,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return buildResult({
			text: `Advisor call threw: ${message}`,
			advisorModel: advisorLabel,
			effort,
			errorMessage: message,
		});
	}
}

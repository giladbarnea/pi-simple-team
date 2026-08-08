import type { ContextUsage } from "@earendil-works/pi-coding-agent";

export interface KnownContextUsage {
	tokens: number;
	contextWindow: number;
	percent: number;
}

export function requireKnownContextUsage(usage: ContextUsage | undefined): KnownContextUsage {
	if (!usage || usage.tokens === null || usage.percent === null) throw new Error("Context usage is unavailable");
	return { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent };
}

/** @example formatContextWindowReport("You have", { tokens: 87_000, contextWindow: 272_000, percent: 32 }) */
export function formatContextWindowReport(subjectWithVerb: string, usage: KnownContextUsage): string {
	const tokens = `${Math.round(usage.tokens / 1_000)}k`;
	const contextWindow = `${Math.round(usage.contextWindow / 1_000)}k`;
	return `${subjectWithVerb} used ${tokens} tokens out of ${contextWindow} available (${Math.round(usage.percent)}%).`;
}

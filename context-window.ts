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

/** One line of a context-window report, read back for display. `teammate` and `team` are absent on the caller's own "You have" line. */
export interface ContextWindowReportLine {
	teammate?: string;
	team?: string;
	thousandsUsed: number;
	thousandsAvailable: number;
	percent: number;
}

const REPORT_LINE = /^(?:Teammate (.+) \(Pi session ID: \S+\) on team (.+) \(team ID: .+\) has|You have) used (\d+)k tokens out of (\d+)k available \((\d+)%\)\.$/;

/**
 * Reads one line that `formatContextWindowReport` wrote. Throws on any other text.
 * @example parseContextWindowReport("You have used 87k tokens out of 272k available (32%).") // { teammate: undefined, team: undefined, thousandsUsed: 87, thousandsAvailable: 272, percent: 32 }
 */
export function parseContextWindowReport(line: string): ContextWindowReportLine {
	const match = REPORT_LINE.exec(line);
	if (!match) throw new Error(`Not a context-window report line: ${line}`);
	const [, teammate, team, used, available, percent] = match;
	return { teammate, team, thousandsUsed: Number(used), thousandsAvailable: Number(available), percent: Number(percent) };
}

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
	year: "numeric", month: "short", day: "2-digit",
	hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset",
});

/** Select direct evidence of model activity, not trailing input, staging, or metadata. @example lastRecordedModelActivity([]) // undefined */
export function lastRecordedModelActivity(branch: readonly SessionEntry[]): string | undefined {
	return branch.findLast((entry) =>
		(entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) ||
		((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage !== undefined),
	)?.timestamp;
}

/** Ground a resumed teammate without repeating its saved assignment. @example composeResumptionMessage("review", "scout", undefined).includes('team "review"') // true */
export function composeResumptionMessage(teamName: string, teammateName: string, lastActivity: string | undefined, instructions?: string, now: Date = new Date()): string {
	return [
		`You are teammate "${teammateName}" on team "${teamName}". This session has resumed.`,
		`Current time: ${dateTimeFormatter.format(now)}.`,
		lastActivity === undefined
			? "No prior model activity is recorded in this conversation branch."
			: `Your last recorded model activity was ${dateTimeFormatter.format(new Date(lastActivity))}.`,
		"Continue from the saved progress. This resumption and any new instructions below take precedence over earlier team assignments. Treat earlier conversation as background.",
		instructions,
	].filter((part) => part !== undefined).join("\n\n");
}

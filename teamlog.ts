export type TeamLogKind =
	| "spawn"
	| "send"
	| "deliver"
	| "ack"
	| "status"
	| "agent_start"
	| "agent_end"
	| "tool_start"
	| "tool_end"
	| "main_message"
	| "stderr"
	| "exit"
	| "error";

export type TeamLogDirection = "main->teammate" | "teammate->main" | "teammate->teammate" | "runtime";

export interface TeamLogEntry {
	sequence: number;
	timestamp: string;
	epochMilliseconds: number;
	team: string;
	teammate?: string;
	direction?: TeamLogDirection;
	kind: TeamLogKind;
	summary: string;
	details?: Record<string, unknown>;
}

export interface TeamLogState {
	log: TeamLogEntry[];
	nextLogSequence: number;
}

export type TeamLogEntryInput = Omit<TeamLogEntry, "sequence" | "timestamp" | "epochMilliseconds">;

export interface TeamLogFilterParams {
	teammate?: string;
	kind?: string;
	search?: string;
	since?: string;
}

export interface TeamLogPageParams {
	limit?: number;
	cursor?: string;
}

export interface TeamLogPage {
	entries: TeamLogEntry[];
	totalMatched: number;
	returned: number;
	nextCursor?: string;
	limit: number;
}

export interface TeamLogPageView extends TeamLogPage {
	team: string;
}

const MAX_LOG_ENTRIES = 1000;
const DEFAULT_PREVIEW_LENGTH = 160;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const dateFormatter = new Intl.DateTimeFormat("en-US", { month: "long", day: "2-digit" });
const timeFormatter = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function nowText(date: Date = new Date()): string {
	return `${dateFormatter.format(date)}, ${timeFormatter.format(date)}`;
}

export function timeOfDay(epochMilliseconds: number): string {
	return timeFormatter.format(new Date(epochMilliseconds));
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

export function preview(value: unknown, maxLength = DEFAULT_PREVIEW_LENGTH): string {
	const text = typeof value === "string" ? value : safeStringify(value);
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength)} (truncated, ${normalized.length} chars)`;
}

export function appendTeamLog(state: TeamLogState, input: TeamLogEntryInput, now: Date = new Date()): TeamLogEntry {
	const entry: TeamLogEntry = {
		...input,
		sequence: state.nextLogSequence++,
		timestamp: nowText(now),
		epochMilliseconds: now.getTime(),
	};
	state.log.push(entry);
	if (state.log.length > MAX_LOG_ENTRIES) state.log.shift();
	return entry;
}

function parseSince(since: string | undefined): number | undefined {
	if (since === undefined) return undefined;
	const threshold = Date.parse(since);
	if (Number.isNaN(threshold)) throw new Error(`Invalid since timestamp: ${since}`);
	return threshold;
}

function matchesSearch(entry: TeamLogEntry, search: string): boolean {
	const needle = search.toLowerCase();
	const haystacks = [entry.summary, entry.teammate ?? "", entry.direction ?? "", entry.kind, entry.details ? safeStringify(entry.details) : ""];
	return haystacks.some((haystack) => haystack.toLowerCase().includes(needle));
}

export function filterTeamLog(entries: TeamLogEntry[], params: TeamLogFilterParams): TeamLogEntry[] {
	const sinceThreshold = parseSince(params.since);
	return entries.filter((entry) => {
		if (params.teammate !== undefined && entry.teammate !== params.teammate) return false;
		if (params.kind !== undefined && entry.kind !== params.kind) return false;
		if (sinceThreshold !== undefined && entry.epochMilliseconds < sinceThreshold) return false;
		if (params.search !== undefined && !matchesSearch(entry, params.search)) return false;
		return true;
	});
}

function resolveLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_LIMIT;
	if (!Number.isFinite(limit) || limit < 1) throw new Error(`Invalid limit: ${limit}. Must be at least 1.`);
	return Math.min(Math.floor(limit), MAX_LIMIT);
}

function parseCursor(cursor: string | undefined): number | undefined {
	if (cursor === undefined) return undefined;
	const match = /^before:(\d+)$/.exec(cursor);
	if (!match) throw new Error(`Invalid cursor: ${cursor}`);
	return Number(match[1]);
}

export function pageTeamLog(filteredEntries: TeamLogEntry[], params: TeamLogPageParams): TeamLogPage {
	const limit = resolveLimit(params.limit);
	const beforeSequence = parseCursor(params.cursor);
	const totalMatched = filteredEntries.length;

	const eligible = beforeSequence === undefined ? filteredEntries : filteredEntries.filter((entry) => entry.sequence < beforeSequence);

	const pageEntries = eligible.slice(Math.max(0, eligible.length - limit));
	const hasOlder = eligible.length > pageEntries.length;
	const oldestInPage = pageEntries[0];

	return {
		entries: pageEntries,
		totalMatched,
		returned: pageEntries.length,
		nextCursor: hasOlder && oldestInPage ? `before:${oldestInPage.sequence}` : undefined,
		limit,
	};
}

const COLUMN_WIDTHS = { sequence: 3, time: 8, teammate: 10, kind: 12, direction: 19 } as const;

function column(text: string, width: number): string {
	return text.padEnd(width);
}

function renderRow(entry: TeamLogEntry): string {
	return [
		column(String(entry.sequence).padStart(COLUMN_WIDTHS.sequence, "0"), COLUMN_WIDTHS.sequence),
		column(timeOfDay(entry.epochMilliseconds), COLUMN_WIDTHS.time),
		column(entry.teammate ?? "main", COLUMN_WIDTHS.teammate),
		column(entry.kind, COLUMN_WIDTHS.kind),
		column(entry.direction ?? "", COLUMN_WIDTHS.direction),
		entry.summary,
	].join(" ");
}

export function renderTeamLogPage(view: TeamLogPageView): string {
	const header = `Team ${view.team} — latest ${view.returned} of ${view.totalMatched} matching events`;
	const columnHeader = [
		column("seq", COLUMN_WIDTHS.sequence),
		column("time", COLUMN_WIDTHS.time),
		column("teammate", COLUMN_WIDTHS.teammate),
		column("kind", COLUMN_WIDTHS.kind),
		column("dir", COLUMN_WIDTHS.direction),
		"summary",
	].join(" ");
	const rows = view.entries.map(renderRow);
	const cursorSuffix = view.nextCursor ? ` nextCursor="${view.nextCursor}"` : "";
	const footer = `Showing ${view.returned} of ${view.totalMatched} matching events.${cursorSuffix}`;
	return [header, columnHeader, ...rows, footer].join("\n");
}

export function normalizeChildEvent(team: string, teammate: string, event: Record<string, unknown>): TeamLogEntryInput | undefined {
	const type = event.type;

	if (type === "agent_start") {
		return { team, teammate, direction: "runtime", kind: "agent_start", summary: `${teammate} started` };
	}

	if (type === "agent_end") {
		const messages = event.messages;
		const messageCount = Array.isArray(messages) ? messages.length : undefined;
		const summary = messageCount === undefined ? `${teammate} finished` : `${teammate} finished (${messageCount} message${messageCount === 1 ? "" : "s"})`;
		return { team, teammate, direction: "runtime", kind: "agent_end", summary };
	}

	if (type === "tool_execution_start") {
		const toolName = String(event.toolName ?? "tool");
		return {
			team,
			teammate,
			direction: "runtime",
			kind: "tool_start",
			summary: `${teammate} started ${toolName}: ${preview(event.args)}`,
			details: { toolCallId: event.toolCallId, toolName, args: event.args },
		};
	}

	if (type === "tool_execution_end") {
		const toolName = String(event.toolName ?? "tool");
		const isError = Boolean(event.isError);
		return {
			team,
			teammate,
			direction: "runtime",
			kind: "tool_end",
			summary: `${teammate} ${isError ? "failed" : "finished"} ${toolName}: ${preview(event.result)}`,
			details: { toolCallId: event.toolCallId, toolName, isError, result: event.result },
		};
	}

	if (type === "extension_error") {
		return {
			team,
			teammate,
			direction: "runtime",
			kind: "error",
			summary: `${teammate} extension error: ${preview(event.error)}`,
			details: { extensionPath: event.extensionPath, event: event.event, error: event.error },
		};
	}

	return undefined;
}

import { Markdown, type MarkdownTheme, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { padVisible, stableRenderWidth, visibleLength } from "./render-support/ansi.ts";
import { glyphs } from "./render-support/glyphs.ts";
import { stackPrefix, toolLabel, treeConnector, treeStem } from "./render-support/theme.ts";
import { commandExit, plural, renderPendingCall, textContent } from "./render-support/text.ts";
import { futureTime, monthDay, relativeTime, timeOfDay, type TeamLogEntry } from "./teamlog.ts";
import { actorHueToken, DIM_SGR_CLOSE, DIM_SGR_OPEN, FactTable, inlineFact, statusWordToken, type FactRow, type TeammateView } from "./teammate-facts.ts";

export { actorHueToken, statusWordToken, type TeammateView };

export interface ThemeLike {
	bold(text: string): string;
	fg(token: string, text: string): string;
}

interface ToolRenderContextLike {
	args?: object;
	cwd?: string;
	executionStarted?: boolean;
	invalidate?: () => void;
	isError?: boolean;
	isPartial?: boolean;
	toolCallId?: string;
}

export type TeamToolName = "team_spawn" | "team_list" | "team_resume" | "team_add_teammates" | "team_send_message" | "team_status" | "team_log" | "team_shutdown";

export interface TeamStatusView {
	word: string;
	phrase: string;
	updated: string;
}

export interface TeamMessageDetails {
	team: string;
	from: string;
	to?: string;
	sentAt: string;
	message: string;
}

interface TeamLogRenderView {
	team: string;
	roster?: string[];
	entries: TeamLogEntry[];
	totalMatched: number;
	returned: number;
	nextCursor?: string;
	filters?: Record<string, unknown>;
	nowMilliseconds?: number;
}

/** @example relativeTimeText(new Date().toISOString()) // "just now" */
export function relativeTimeText(timestamp: string): string {
	return relativeTime(Date.parse(timestamp), Date.now());
}

/** A rendered line with optional wrapping or right-aligned layout metadata. */
type MarkdownTeamLine = { prefix: string; markdown: string; markdownTheme: MarkdownTheme };

/** A teammate's fact row. Its table shrinks it to fit the width, in collapsed and expanded views alike. */
type FactTeamLine = { prefix: string; row: FactRow; table: FactTable };

export type TeamLine = string | { prefix: string; text: string } | { left: string; right: string } | MarkdownTeamLine | FactTeamLine;

function isRightAlignedTeamLine(line: TeamLine): line is { left: string; right: string } {
	return typeof line !== "string" && "right" in line;
}

function isMarkdownTeamLine(line: TeamLine): line is MarkdownTeamLine {
	return typeof line !== "string" && "markdown" in line;
}

function isFactTeamLine(line: TeamLine): line is FactTeamLine {
	return typeof line !== "string" && "table" in line;
}

export function teamLineText(line: TeamLine): string {
	if (typeof line === "string") return line;
	if (isRightAlignedTeamLine(line)) return `${line.left}${line.right}`.trimEnd();
	if (isMarkdownTeamLine(line)) return `${line.prefix}${line.markdown}`.trimEnd();
	if (isFactTeamLine(line)) return `${line.prefix}${line.table.full(line.row)}`.trimEnd();
	return `${line.prefix}${line.text}`.trimEnd();
}

/** rightAlignedLine("left", "right", 12) === "left   right" */
function rightAlignedLine(left: string, right: string, width: number): string {
	const rightText = truncateToWidth(right, width, glyphs().ellipsis);
	const leftWidth = Math.max(0, width - visibleLength(rightText));
	return `${truncateToWidth(left, leftWidth, glyphs().ellipsis, true)}${rightText}`;
}

function wrapTeamLine(line: TeamLine, width: number): string[] {
	if (isRightAlignedTeamLine(line) || isFactTeamLine(line)) return [clipTeamLine(line, width)];
	if (typeof line === "string") {
		const wrapped = wrapTextWithAnsi(line, width);
		return wrapped.length > 0 ? wrapped : [""];
	}
	const contentWidth = Math.max(1, width - visibleLength(line.prefix));
	const wrapped = isMarkdownTeamLine(line) ? new Markdown(line.markdown, 0, 0, line.markdownTheme).render(contentWidth) : wrapTextWithAnsi(line.text, contentWidth);
	const parts = wrapped.length > 0 ? wrapped : [""];
	return parts.map((part) => clipToWidth(`${line.prefix}${part}`.trimEnd(), width));
}

function clipToWidth(line: string, width: number): string {
	return truncateToWidth(line, Math.max(1, width), glyphs().ellipsis);
}

/** Clips each logical line to exactly `width` columns, with no right-margin guard. */
export function clipTeamLines(lines: TeamLine[], width: number): string[] {
	return lines.map((line) => clipToWidth(clipTeamLine(line, width), width));
}

function clipTeamLine(line: TeamLine, width: number): string {
	if (isFactTeamLine(line)) return `${line.prefix}${line.table.fit(line.row, width - visibleLength(line.prefix))}`;
	return isRightAlignedTeamLine(line) ? rightAlignedLine(line.left, line.right, width) : clipToWidth(teamLineText(line), width);
}

/** Clips each logical line to the render width (collapsed) or wraps it (expanded). */
export class TeamLines {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly lines: TeamLine[],
		private readonly mode: "clip" | "wrap",
	) {}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const targetWidth = Math.max(1, stableRenderWidth(width));
		this.cachedLines = this.mode === "clip"
			? clipTeamLines(this.lines, targetWidth)
			: this.lines.flatMap((line) => wrapTeamLine(line, targetWidth)).map((line) => clipToWidth(line, targetWidth));
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

function dimDot(theme: ThemeLike): string {
	return theme.fg("dim", glyphs().dot);
}

function statLine(theme: ThemeLike, parts: string[]): string {
	return parts.filter((part) => part.length > 0).join(dimDot(theme));
}

function callBody(theme: ThemeLike, label: string, target: string, stats: string[] = []): string {
	const head = target ? `${toolLabel(theme, `${label} `)}${target}` : toolLabel(theme, label);
	const tail = statLine(theme, stats);
	return tail ? `${head}${dimDot(theme)}${tail}` : head;
}

function headerLine(theme: ThemeLike, label: string, target: string, stats: string[] = []): string {
	return `${stackPrefix(theme)}${callBody(theme, label, target, stats)}`;
}

function errorLines(theme: ThemeLike, body: string, errorText: string): string[] {
	const firstLine = errorText.split(/\r?\n/)[0] || "failed";
	return [`${stackPrefix(theme)}${body}${dimDot(theme)}${theme.fg("error", firstLine)}`];
}

/**
 * formatCharCount(4) === "4 chars"; formatCharCount(4463) === "4.5k chars"; formatCharCount(45210) === "45k chars"
 */
export function formatCharCount(count: number): string {
	if (count >= 10_000) return `${Math.round(count / 1000)}k chars`;
	if (count >= 1_000) return `${(count / 1000).toFixed(1)}k chars`;
	return `${count} chars`;
}

/** One tree entry per teammate: its fact row, then the rows `below` returns under the entry's stem. */
function teammateTree<Row extends FactRow>(
	theme: ThemeLike,
	rows: Row[],
	roster: string[],
	below: (row: Row, stem: string, isLast: boolean) => TeamLine[] = () => [],
	indent = "",
): TeamLine[] {
	const table = new FactTable(theme, rows, roster);
	return rows.flatMap((row, index) => {
		const isLast = index === rows.length - 1;
		const branch = isLast ? "└" : "├";
		const stem = `${indent}${treeStem(theme, branch)}`;
		return [{ prefix: `${indent}${treeConnector(theme, branch)}`, row, table }, ...below(row, stem, isLast)];
	});
}

/** A status row's phrase sits on its own line under the facts, with its time right-aligned. */
function statusPhraseLine(theme: ThemeLike, indent: string, status: TeamStatusView): TeamLine {
	return { left: `${indent}${status.phrase}`, right: theme.fg("dim", ` ${relativeTimeText(status.updated)}`) };
}

type StatusRow = FactRow & { entry: TeamStatusView };

/** Status rows pair each participant's status with its teammate facts. Main has no teammate facts. */
function statusRows(statuses: Record<string, TeamStatusView>, teammates: Record<string, TeammateView> = {}): StatusRow[] {
	return Object.entries(statuses).map(([name, entry]) => ({ ...teammates[name], name, status: entry.word, entry }));
}

/** Each participant's fact row with its status phrase under it, and an empty row before the next participant. Team Status and the /team overlay share it. */
export function memberRows(theme: ThemeLike, statuses: Record<string, TeamStatusView>, teammates: Record<string, TeammateView> | undefined, roster: string[], indent = ""): TeamLine[] {
	const below = (row: StatusRow, stem: string, isLast: boolean): TeamLine[] => [statusPhraseLine(theme, stem, row.entry), ...(isLast ? [] : [{ prefix: stem, text: "" }])];
	return teammateTree(theme, statusRows(statuses, teammates), roster, below, indent);
}

export function teamStatusLines(theme: ThemeLike, team: string, statuses: Record<string, TeamStatusView>, roster: string[] = [], teammates?: Record<string, TeammateView>): TeamLine[] {
	const members = Object.values(statuses);
	const workingCount = members.filter((member) => statusWordToken(member.word) === "success").length;
	const stats = [theme.fg("muted", plural(members.length, "member"))];
	if (workingCount > 0) stats.push(theme.fg("success", `${workingCount} working`));
	return [headerLine(theme, "Team Status", theme.fg("accent", team), stats), ...memberRows(theme, statuses, teammates, roster)];
}

export function allTeamsStatusLines(theme: ThemeLike, teams: Array<{ teamName: string; status: Record<string, TeamStatusView>; teammates?: Record<string, TeammateView> }>, roster: string[] = []): TeamLine[] {
	const lines: TeamLine[] = [headerLine(theme, "Team Status", theme.fg("muted", plural(teams.length, "team")))];
	teams.forEach((team, index) => {
		const branch = index === teams.length - 1 ? "└" : "├";
		lines.push(`${treeConnector(theme, branch)}${theme.fg("accent", team.teamName)}`);
		lines.push(...memberRows(theme, team.status, team.teammates, roster, treeStem(theme, branch)));
	});
	return lines;
}

interface TeammateSpecView extends TeammateView {
	systemPrompt: string;
}

/** @example specRow({ name: "a", model: "m", systemPrompt: "p", live: true }) // { name: "a", model: "m", ... } without `live` */
function specRow(spec: TeammateSpecView): FactRow & { systemPrompt: string } {
	const { live: _live, ...row } = spec;
	return row;
}

/** A full quote-barred Markdown text nested under a tree row. */
function treeQuote(prefix: string, theme: ThemeLike, markdown: string, markdownTheme: MarkdownTheme): MarkdownTeamLine {
	return { prefix: `${prefix}${theme.fg("muted", glyphs().codeBar)} `, markdown, markdownTheme };
}

/** One row per teammate. Expanded entries (given a Markdown theme) add the full system prompt and a spacer before the next entry. */
function teammateSpecRows(theme: ThemeLike, teammates: TeammateSpecView[], roster: string[], expandedMarkdownTheme?: MarkdownTheme): TeamLine[] {
	const below = (row: FactRow & { systemPrompt: string }, stem: string, isLast: boolean): TeamLine[] => expandedMarkdownTheme
		? [treeQuote(stem, theme, row.systemPrompt, expandedMarkdownTheme), ...(isLast ? [] : [{ prefix: stem, text: "" }])]
		: [];
	return teammateTree(theme, teammates.map(specRow), roster, below);
}

export function teamSpawnLines(theme: ThemeLike, team: string, teammates: TeammateSpecView[], roster: string[] = [], expansion?: { commonPrompt: string; markdownTheme: MarkdownTheme }): TeamLine[] {
	const header = headerLine(theme, "Team Spawn", theme.fg("accent", team), [theme.fg("muted", plural(teammates.length, "teammate"))]);
	const stem = treeStem(theme, "├");
	const commonPromptRows: TeamLine[] = expansion
		? [`${treeConnector(theme, "├")}${theme.fg("accent", "common prompt")}`, treeQuote(stem, theme, expansion.commonPrompt, expansion.markdownTheme), { prefix: stem, text: "" }]
		: [];
	return [header, ...commonPromptRows, ...teammateSpecRows(theme, teammates, roster, expansion?.markdownTheme)];
}

export function teamAddLines(theme: ThemeLike, team: string, teammates: TeammateSpecView[], memberCount: number, roster: string[] = [], expandedMarkdownTheme?: MarkdownTheme): TeamLine[] {
	const header = headerLine(theme, "Team Add", theme.fg("accent", team), [
		theme.fg("muted", `${teammates.length} added`),
		theme.fg("muted", plural(memberCount, "member")),
	]);
	return [header, ...teammateSpecRows(theme, teammates, roster, expandedMarkdownTheme)];
}

export interface ResumedMemberView extends TeammateView {
	restored?: boolean;
	live: boolean;
	active: boolean;
}

export function teamResumeLines(theme: ThemeLike, team: string, resumed: ResumedMemberView[], teammateCount: number, roster: string[] = []): TeamLine[] {
	const resumedCount = resumed.filter((member) => member.restored !== undefined).length;
	const countText = resumedCount === teammateCount ? `${resumedCount} resumed` : `${resumedCount} of ${teammateCount} resumed`;
	const header = headerLine(theme, "Team Resume", theme.fg("accent", team), [theme.fg("muted", countText)]);
	if (resumed.length === 0) return [header, `${treeConnector(theme, "└")}${theme.fg("muted", "no stopped teammates")}`];
	const rows = resumed.map(({ restored, active, ...member }) => ({
		...member,
		status: restored === undefined ? active ? "working" : member.live ? "idle" : "stopped" : restored ? "resumed" : "restarted",
		note: restored === undefined ? "" : `${restored ? "history restored" : "empty session"}, ${active ? "working" : "idle"}`,
	}));
	return [header, ...teammateTree(theme, rows, roster, (row, stem) => (row.note ? [`${stem}${theme.fg("muted", row.note)}`] : []))];
}

export interface TeamListMemberView extends TeammateView {
	live: boolean;
}

export interface TeamListTeamView {
	name: string;
	state: string;
	leaseState: string;
	members: TeamListMemberView[];
	updatedAt: string;
	expiresAt?: string;
}

function teamListMemberName(theme: ThemeLike, teamView: TeamListTeamView, member: TeamListMemberView, roster: string[]): string {
	const hued = theme.fg(actorHueToken(member.name, roster), member.name);
	const name = teamView.state === "active" && !member.live ? `${DIM_SGR_OPEN}${hued}${DIM_SGR_CLOSE}` : hued;
	return [name, inlineFact(theme, "manager", member)].filter((part) => part.length > 0).join(" ");
}

function teamListTimestamp(teamView: TeamListTeamView): string {
	if (teamView.state === "dormant" && teamView.expiresAt) return `expires ${futureTime(Date.parse(teamView.expiresAt), Date.now())}`;
	return `updated ${relativeTime(Date.parse(teamView.updatedAt), Date.now())}`;
}

/** Collapsed, each team lists its teammate names inline. Expanded, each teammate gets its own fact row. */
export function teamListLines(theme: ThemeLike, teamViews: TeamListTeamView[], roster: string[] = [], expanded = false, unreadableCount = 0): TeamLine[] {
	const activeCount = teamViews.filter((teamView) => teamView.state === "active").length;
	const stats = [theme.fg("muted", plural(teamViews.length, "team"))];
	if (activeCount > 0) stats.push(theme.fg("success", `${activeCount} active`));
	if (unreadableCount > 0) stats.push(theme.fg("warning", `${unreadableCount} unreadable`));
	const header = headerLine(theme, "Team List", "", stats);
	if (teamViews.length === 0) return [header, `${treeConnector(theme, "└")}${theme.fg("muted", "no teams")}`];
	const nameWidth = Math.max(...teamViews.map((teamView) => teamView.name.length));
	const stateWidth = Math.max(...teamViews.map((teamView) => teamView.state.length));
	const rows: TeamLine[] = teamViews.flatMap((teamView, index) => {
		const branch = index === teamViews.length - 1 ? "└" : "├";
		const rosterText = expanded ? "" : teamView.members.map((member) => teamListMemberName(theme, teamView, member, roster)).join(theme.fg("muted", glyphs().dot));
		const staleLease = teamView.leaseState === "stale" ? `${dimDot(theme)}${theme.fg("error", "stale lease")}` : "";
		const left = `${treeConnector(theme, branch)}${theme.fg("accent", padVisible(teamView.name, nameWidth))}  ${theme.fg(statusWordToken(teamView.state), padVisible(teamView.state, stateWidth))}  ${rosterText}${staleLease}`;
		const memberRows = expanded ? teammateTree(theme, teamView.members, roster, undefined, treeStem(theme, branch)) : [];
		return [{ left, right: theme.fg("dim", teamListTimestamp(teamView)) }, ...memberRows];
	});
	return [header, ...rows];
}

/** The dim "N more lines · ctrl+o to expand" footer under a collapsed body. */
function expandHint(theme: ThemeLike, hidden: number): string {
	const g = glyphs();
	return theme.fg("dim", `${g.ellipsis} ${hidden} more line${hidden === 1 ? "" : "s"}${g.dot}ctrl+o to expand`);
}

function quotedBody(theme: ThemeLike, message: string, options: { lineLimit: number; barToken: string }): TeamLine[] {
	const bar = `  ${theme.fg(options.barToken, glyphs().codeBar)} `;
	const lines = message.replace(/\r\n/g, "\n").split("\n");
	const shown = lines.slice(0, options.lineLimit);
	const body: TeamLine[] = shown.map((line) => ({ prefix: bar, text: line }));
	const hidden = lines.length - shown.length;
	if (hidden > 0) body.push({ prefix: bar, text: expandHint(theme, hidden) });
	return body;
}

const SEND_PREVIEW_LINES = 3;

function actorList(theme: ThemeLike, names: string[], roster: string[], separator: string): string {
	return names.map((name) => theme.fg(actorHueToken(name, roster), name)).join(theme.fg("muted", separator));
}

function sendTarget(theme: ThemeLike, to: string[], roster: string[] = []): string {
	const recipients = actorList(theme, to, roster, ", ");
	return `${theme.fg("muted", `${glyphs().arrow} `)}${recipients}`;
}

function sendStats(theme: ThemeLike, message: string, interrupt: boolean): string[] {
	return [interrupt ? theme.fg("warning", "interrupt") : "", theme.fg("muted", formatCharCount(message.length))];
}

/** @example hasInterruption([]) // false */
function hasInterruption(interrupt: unknown): boolean {
	return interrupt === true || (Array.isArray(interrupt) && interrupt.length > 0);
}

function teamSendHeader(theme: ThemeLike, targets: string[], message: string, interrupt: boolean, roster: string[]): string {
	return headerLine(theme, "Team Send", sendTarget(theme, targets, roster), sendStats(theme, message, interrupt));
}

export function teamSendLines(theme: ThemeLike, options: { targets: string[]; message: string; interrupt: boolean; expanded: boolean }, roster: string[] = []): TeamLine[] {
	const header = teamSendHeader(theme, options.targets, options.message, options.interrupt, roster);
	const lineLimit = options.expanded ? Number.POSITIVE_INFINITY : SEND_PREVIEW_LINES;
	return [header, ...quotedBody(theme, options.message, { lineLimit, barToken: "muted" })];
}

export function teamShutdownLines(theme: ThemeLike, team: string, teammates: string[], roster: string[] = []): string[] {
	const header = headerLine(theme, "Team Shutdown", theme.fg("accent", team), [theme.fg("muted", `${plural(teammates.length, "teammate")} stopped`)]);
	if (teammates.length === 0) return [header];
	return [header, `${treeConnector(theme, "└")}${actorList(theme, teammates, roster, glyphs().dot)}`];
}

function reminderCallBody(theme: ThemeLike, args: Record<string, unknown>): string {
	const delayMinutes = args.delayMinutes;
	const message = typeof args.message === "string" ? args.message : "";
	const target = typeof delayMinutes === "number" ? theme.fg("accent", `in ${plural(delayMinutes, "minute")}`) : "";
	return callBody(theme, "Schedule Reminder", target, message ? [theme.fg("muted", formatCharCount(message.length))] : []);
}

export function scheduleReminderLines(theme: ThemeLike, options: { delayMinutes: number; message: string; expanded: boolean }): TeamLine[] {
	const header = `${stackPrefix(theme)}${reminderCallBody(theme, options)}`;
	const lineLimit = options.expanded ? Number.POSITIVE_INFINITY : SEND_PREVIEW_LINES;
	return [header, ...quotedBody(theme, options.message, { lineLimit, barToken: "muted" })];
}

type LogIcon = "chevron" | "arrow" | "bullet" | "diamond" | "warn" | "fail";

type LogDetail =
	| { style: "text"; text: string }
	| { style: "actors"; names: string[] }
	| { style: "loud"; token: string; text: string };

interface LogAction {
	sequence: number;
	epochMilliseconds: number;
	who: string;
	icon: LogIcon;
	iconToken: string;
	action: string;
	details: LogDetail[];
	startEpoch?: number;
	salient?: string;
	recipients?: string[];
	messageText?: string;
}

function inlineText(value: unknown): string {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
	return text.replace(/\s+/g, " ").trim();
}

function rawResultText(result: unknown): string {
	const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
	const textPart = content?.find((part) => part?.type === "text" && typeof part.text === "string");
	if (typeof textPart?.text === "string") return textPart.text;
	return typeof result === "string" ? result : (JSON.stringify(result) ?? String(result));
}

function salientArg(args: unknown): string {
	if (args && typeof args === "object" && !Array.isArray(args)) {
		for (const value of Object.values(args)) {
			if (typeof value === "string" && value.trim()) return inlineText(value);
		}
	}
	return inlineText(args);
}

function failureReason(result: unknown): string {
	const raw = rawResultText(result);
	const exitCode = commandExit(raw);
	if (exitCode !== null) return String(exitCode);
	const firstLine = raw.split(/\r?\n/).find((line) => line.trim());
	return firstLine?.trim() || "failed";
}

function textDetail(text: string): LogDetail {
	return { style: "text", text };
}

function messageDetails(recipients: string[], text: string, interrupt: boolean): LogDetail[] {
	const details: LogDetail[] = [{ style: "actors", names: recipients }];
	if (interrupt) details.push({ style: "loud", token: "warning", text: "interrupt" });
	details.push(textDetail(text));
	return details;
}

function durationText(startEpoch: number | undefined, endEpoch: number): string {
	if (startEpoch === undefined) return "";
	return `${Math.max(0, Math.round((endEpoch - startEpoch) / 1000))}s`;
}

/** Folds wire entries into one row per action: tool pairs close in place, sends group by sender+message, deliver/ack are absorbed. */
export function foldLogEntries(entries: TeamLogEntry[]): LogAction[] {
	const ellipsis = glyphs().ellipsis;
	const actions: LogAction[] = [];
	const openTools = new Map<unknown, LogAction>();
	const openTurns = new Map<string, LogAction>();

	for (const entry of entries) {
		const details = entry.details ?? {};
		const who = entry.teammate ?? "main";
		const base = { sequence: entry.sequence, epochMilliseconds: entry.epochMilliseconds, who };

		if (entry.kind === "tool_start") {
			const salient = salientArg(details.args);
			const action: LogAction = {
				...base,
				icon: "chevron",
				iconToken: "borderMuted",
				action: String(details.toolName ?? "tool"),
				details: [textDetail(ellipsis), textDetail(salient)],
				startEpoch: entry.epochMilliseconds,
				salient,
			};
			actions.push(action);
			if (details.toolCallId !== undefined) openTools.set(details.toolCallId, action);
			continue;
		}
		if (entry.kind === "tool_end") {
			const isError = Boolean(details.isError);
			const open = details.toolCallId === undefined ? undefined : openTools.get(details.toolCallId);
			if (open) {
				openTools.delete(details.toolCallId);
				open.iconToken = isError ? "error" : "success";
				const closing = [textDetail(durationText(open.startEpoch, entry.epochMilliseconds)), textDetail(open.salient ?? "")];
				open.details = isError ? [{ style: "loud", token: "error", text: failureReason(details.result) }, ...closing] : closing;
				continue;
			}
			actions.push({
				...base,
				icon: "chevron",
				iconToken: isError ? "error" : "success",
				action: String(details.toolName ?? "tool"),
				details: isError ? [{ style: "loud", token: "error", text: failureReason(details.result) }] : [textDetail(inlineText(rawResultText(details.result)))],
			});
			continue;
		}
		if (entry.kind === "send") {
			const from = typeof details.from === "string" ? details.from : who;
			const to = String(details.to ?? "");
			const interrupt = Boolean(details.interrupt);
			const last = actions.at(-1);
			if (last?.action === "message" && last.who === from && last.messageText === entry.summary && last.recipients && !last.recipients.includes(to)) {
				last.recipients.push(to);
				last.details = messageDetails(last.recipients, entry.summary, interrupt);
				continue;
			}
			actions.push({
				...base,
				who: from,
				icon: "arrow",
				iconToken: "borderMuted",
				action: "message",
				recipients: [to],
				messageText: entry.summary,
				details: messageDetails([to], entry.summary, interrupt),
			});
			continue;
		}
		if (entry.kind === "deliver" || entry.kind === "ack") continue;
		if (entry.kind === "main_message") {
			actions.push({ ...base, icon: "arrow", iconToken: "borderMuted", action: "message", details: messageDetails(["main"], entry.summary, false) });
			continue;
		}
		if (entry.kind === "status") {
			const word = typeof details.word === "string" ? details.word : "";
			const phrase = typeof details.phrase === "string" ? details.phrase : "";
			actions.push({ ...base, icon: "bullet", iconToken: "borderMuted", action: "status", details: [textDetail(word), textDetail(phrase)] });
			continue;
		}
		if (entry.kind === "agent_start") {
			const action: LogAction = { ...base, icon: "diamond", iconToken: "borderMuted", action: "attempt", details: [textDetail(ellipsis)], startEpoch: entry.epochMilliseconds };
			actions.push(action);
			openTurns.set(who, action);
			continue;
		}
		if (entry.kind === "agent_end") {
			const messageCount = typeof details.messageCount === "number" ? details.messageCount : undefined;
			const countDetails = messageCount === undefined ? [] : [textDetail(plural(messageCount, "message"))];
			const open = openTurns.get(who);
			if (open) {
				openTurns.delete(who);
				open.details = [textDetail(durationText(open.startEpoch, entry.epochMilliseconds)), ...countDetails];
				continue;
			}
			actions.push({ ...base, icon: "diamond", iconToken: "borderMuted", action: "attempt", details: countDetails });
			continue;
		}
		if (entry.kind === "agent_settled") {
			actions.push({ ...base, icon: "diamond", iconToken: details.aborted ? "warning" : "borderMuted", action: "run", details: [textDetail(details.aborted ? "cancelled" : "ended")] });
			continue;
		}
		if (entry.kind === "spawn") {
			actions.push({
				...base,
				icon: "diamond",
				iconToken: "borderMuted",
				action: "spawn",
				details: [textDetail(typeof details.model === "string" ? details.model : ""), textDetail(typeof details.thinking === "string" ? details.thinking : "")],
			});
			continue;
		}
		if (entry.kind === "stderr" || entry.kind === "exit") {
			actions.push({ ...base, icon: "warn", iconToken: "warning", action: entry.kind, details: [textDetail(entry.summary)] });
			continue;
		}
		actions.push({ ...base, icon: "fail", iconToken: "error", action: "error", details: [{ style: "loud", token: "error", text: entry.summary }] });
	}
	return actions;
}

function logIconGlyph(icon: LogIcon): string {
	const g = glyphs();
	const map: Record<LogIcon, string> = {
		chevron: g.chevron,
		arrow: g.arrow,
		bullet: g.bullet.trim(),
		diamond: g.diamond,
		warn: g.warn,
		fail: g.fail,
	};
	return map[icon];
}

function renderLogDetail(theme: ThemeLike, detail: LogDetail, roster: string[]): string {
	if (detail.style === "text") return theme.fg("muted", detail.text);
	if (detail.style === "actors") return detail.names.map((name) => theme.fg(actorHueToken(name, roster), name)).join(theme.fg("muted", ", "));
	return theme.fg(detail.token, detail.text);
}

const LOG_ROW_INDENT = "  ";

function logChrome(theme: ThemeLike, sequence: number, seqWidth: number, epochMilliseconds: number): string {
	return theme.fg("borderMuted", `${LOG_ROW_INDENT}${padVisible(`#${sequence}`, seqWidth)} ${timeOfDay(epochMilliseconds)}`);
}

function sameLocalDay(a: number, b: number): boolean {
	return new Date(a).toDateString() === new Date(b).toDateString();
}

function dayDividerLine(theme: ThemeLike, epochMilliseconds: number): string {
	const rule = glyphs().line;
	return `${LOG_ROW_INDENT}${theme.fg("borderMuted", `${rule.repeat(2)} ${monthDay(epochMilliseconds)} ${rule.repeat(30)}`)}`;
}

/** Log rows keep an absolute HH:MM:SS grammar; day dividers carry the date whenever a row is not from "today". */
function actionRows(theme: ThemeLike, actions: LogAction[], roster: string[], nowMilliseconds: number): string[] {
	const g = glyphs();
	const seqWidth = Math.max(...actions.map((action) => `#${action.sequence}`.length));
	const whoWidth = Math.max(...actions.map((action) => action.who.length));
	const actionWidth = Math.max(...actions.map((action) => action.action.length));
	const iconWidth = Math.max(...actions.map((action) => visibleLength(logIconGlyph(action.icon))));
	const rows: string[] = [];
	let previousWho: string | undefined;
	let previousEpoch = nowMilliseconds;
	for (const action of actions) {
		if (!sameLocalDay(action.epochMilliseconds, previousEpoch)) {
			rows.push(dayDividerLine(theme, action.epochMilliseconds));
			previousWho = undefined;
		}
		previousEpoch = action.epochMilliseconds;
		let whoStyled = theme.fg(actorHueToken(action.who, roster), padVisible(action.who, whoWidth));
		if (action.who === previousWho) whoStyled = `${DIM_SGR_OPEN}${whoStyled}${DIM_SGR_CLOSE}`;
		previousWho = action.who;
		const icon = theme.fg(action.iconToken, padVisible(logIconGlyph(action.icon), iconWidth));
		const actionName = theme.fg("text", padVisible(action.action, actionWidth));
		const dot = theme.fg("muted", g.dot);
		const detailText = action.details
			.filter((detail) => detail.style !== "text" || detail.text.length > 0)
			.map((detail) => renderLogDetail(theme, detail, roster))
			.join(dot);
		rows.push(`${logChrome(theme, action.sequence, seqWidth, action.epochMilliseconds)} ${whoStyled}  ${icon} ${actionName}${detailText ? `${dot}${detailText}` : ""}`);
	}
	return rows;
}

function filterStats(theme: ThemeLike, filters: Record<string, unknown>, roster: string[]): string[] {
	const stats: string[] = [];
	for (const [key, value] of Object.entries(filters)) {
		const displayValue = Array.isArray(value) ? value.join(",") : value;
		if (typeof displayValue !== "string" || !displayValue) continue;
		if (key === "since") {
			const parsed = Date.parse(displayValue);
			stats.push(theme.fg("borderMuted", `since ${Number.isFinite(parsed) ? timeOfDay(parsed) : displayValue}`));
			continue;
		}
		if (key === "teammate") {
			stats.push(`${theme.fg("borderMuted", "teammate=")}${theme.fg(actorHueToken(displayValue, roster), displayValue)}`);
			continue;
		}
		stats.push(theme.fg("borderMuted", `${key}=${displayValue}`));
	}
	return stats;
}

export function teamLogLines(theme: ThemeLike, view: TeamLogRenderView): string[] {
	const g = glyphs();
	const actions = foldLogEntries(view.entries);
	const stats = [
		theme.fg("muted", plural(actions.length, "action")),
		theme.fg("muted", view.returned === view.totalMatched ? plural(view.returned, "event") : `${view.returned} of ${view.totalMatched} events`),
		...filterStats(theme, view.filters ?? {}, view.roster ?? []),
	];
	const header = headerLine(theme, "Team Log", theme.fg("accent", view.team), stats);
	if (view.entries.length === 0) return [header, `${LOG_ROW_INDENT}${theme.fg("muted", "no matching events")}`];

	const footer = view.nextCursor
		? `${LOG_ROW_INDENT}${theme.fg("muted", `${g.ellipsis} older events${g.dot}cursor "${view.nextCursor}"`)}`
		: undefined;
	const rows = actionRows(theme, actions, view.roster ?? [], view.nowMilliseconds ?? Date.now());
	return [header, ...rows, ...(footer ? [footer] : [])];
}

export function teamMessageLines(theme: ThemeLike, details: TeamMessageDetails, roster: string[] = [], lineLimit = Number.POSITIVE_INFINITY): TeamLine[] {
	return [teamMessageHeader(theme, details, roster), ...quotedBody(theme, details.message, { lineLimit, barToken: "accent" })];
}

function teamMessageHeader(theme: ThemeLike, details: TeamMessageDetails, roster: string[]): string {
	const g = glyphs();
	return [
		theme.fg("accent", `${g.diamond} `),
		theme.fg(actorHueToken(details.from, roster), theme.bold(details.from)),
		theme.fg("muted", ` ${g.arrow} ${details.to ?? "main"}`),
		theme.fg("dim", `${g.dot}${details.team}${g.dot}${relativeTimeText(details.sentAt)}`),
	].join("");
}

/** A header over a quote-barred Markdown body, previewing SEND_PREVIEW_LINES body lines unless expanded. */
class QuotedMarkdownView {
	private md: Markdown;
	private barWidth: number;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly headerStr: string,
		messageText: string,
		private readonly barStr: string,
		mdTheme: MarkdownTheme,
		private readonly expanded: boolean,
		private readonly theme: ThemeLike,
	) {
		this.barWidth = visibleLength(barStr);
		this.md = new Markdown(messageText, 0, 0, mdTheme);
	}

	invalidate(): void {
		this.md.invalidate();
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const header = clipToWidth(this.headerStr, width);
		const bodyWidth = Math.max(1, width - this.barWidth);
		const barred = this.md.render(bodyWidth).map((line) => clipToWidth(`${this.barStr}${line}`, width));
		const shown = this.expanded ? barred : barred.slice(0, SEND_PREVIEW_LINES);
		const hidden = barred.length - shown.length;
		if (hidden > 0) shown.push(clipToWidth(`${this.barStr}${expandHint(this.theme, hidden)}`, width));
		this.cachedLines = [header, ...shown];
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

function accentTeam(theme: ThemeLike, team: unknown): string {
	return typeof team === "string" && team ? theme.fg("accent", team) : "";
}

function callBodyFor(tool: TeamToolName, theme: ThemeLike, args: Record<string, unknown>, roster: string[]): string {
	if (tool === "team_spawn") {
		const teammates = (args.teammates ?? []) as unknown[];
		return callBody(theme, "Team Spawn", accentTeam(theme, args.teamName), [theme.fg("muted", plural(teammates.length, "teammate"))]);
	}
	if (tool === "team_list") {
		return callBody(theme, "Team List", "");
	}
	if (tool === "team_resume") {
		const requested = args.teammates as string[] | undefined;
		const scope = requested?.length ? plural(requested.length, "teammate") : "all stopped";
		return callBody(theme, "Team Resume", accentTeam(theme, args.team), [theme.fg("muted", scope)]);
	}
	if (tool === "team_add_teammates") {
		const teammates = (args.teammates ?? []) as unknown[];
		return callBody(theme, "Team Add", accentTeam(theme, args.team), [theme.fg("muted", plural(teammates.length, "teammate"))]);
	}
	if (tool === "team_send_message") {
		const message = String(args.message ?? "");
		return callBody(theme, "Team Send", sendTarget(theme, (args.targets ?? []) as string[], roster), sendStats(theme, message, hasInterruption(args.interrupt)));
	}
	if (tool === "team_status") {
		const target = accentTeam(theme, args.team) || theme.fg("muted", "all teams");
		const setting = inlineText(`${String(args.gerund ?? "")} ${String(args.phrase ?? "")}`);
		return callBody(theme, "Team Status", target, setting ? [theme.fg("dim", `set ${setting}`)] : []);
	}
	if (tool === "team_log") {
		const filterStats = ["kind", "search", "since", "cursor"]
			.filter((key) => (typeof args[key] === "string" && args[key]) || (Array.isArray(args[key]) && args[key].length > 0))
			.map((key) => {
				const value = String(args[key]);
				return theme.fg("dim", `${key}=${value}`);
			});
		return callBody(theme, "Team Log", Array.isArray(args.targets) ? actorList(theme, args.targets as string[], roster, ", ") : theme.fg("muted", "all teams"), filterStats);
	}
	return callBody(theme, "Team Shutdown", accentTeam(theme, args.team));
}

function resultLinesFor(tool: TeamToolName, theme: ThemeLike, args: Record<string, unknown>, details: Record<string, unknown>, expanded: boolean, roster: string[], markdownTheme?: MarkdownTheme): TeamLine[] {
	if (tool === "team_spawn") {
		const expansion = expanded ? { commonPrompt: args.commonPrompt as string, markdownTheme: markdownTheme! } : undefined;
		return teamSpawnLines(theme, String(details.teamName), details.teammates as TeammateSpecView[], roster, expansion);
	}
	if (tool === "team_list") {
		const teamViews = ((details.teams ?? []) as Array<Record<string, unknown>>).map((entry) => ({
			name: String(entry.teamName),
			state: String(entry.state),
			leaseState: String(entry.leaseState ?? ""),
			members: (entry.teammates ?? []) as TeamListMemberView[],
			updatedAt: String(entry.updatedAt),
			expiresAt: entry.expiresAt as string | undefined,
		}));
		return teamListLines(theme, teamViews, roster, expanded, ((details.unreadableManifests ?? []) as unknown[]).length);
	}
	if (tool === "team_resume") {
		const teammates = (details.teammates as Array<ResumedMemberView & { contextRestored?: boolean }>).map(({ contextRestored, ...member }) => ({ ...member, restored: contextRestored }));
		return teamResumeLines(theme, String(details.teamName), teammates, teammates.length, roster);
	}
	if (tool === "team_add_teammates") {
		const memberCount = Object.keys((details.status ?? {}) as Record<string, unknown>).length;
		return teamAddLines(theme, String(details.teamName), details.addedTeammates as TeammateSpecView[], memberCount, roster, expanded ? markdownTheme! : undefined);
	}
	if (tool === "team_send_message") {
		return teamSendLines(theme, {
			targets: (args.targets ?? []) as string[],
			message: String(args.message ?? ""),
			interrupt: hasInterruption(args.interrupt),
			expanded,
		}, roster);
	}
	if (tool === "team_status") {
		if (details.teams) return allTeamsStatusLines(theme, details.teams as Array<{ teamName: string; status: Record<string, TeamStatusView>; teammates?: Record<string, TeammateView> }>, roster);
		return teamStatusLines(theme, String(details.teamName), details.status as Record<string, TeamStatusView>, roster, details.teammates as Record<string, TeammateView> | undefined);
	}
	if (tool === "team_log") {
		const filters = (details.filters ?? {}) as Record<string, unknown>;
		const selectedTeams = details.teams as Array<{ teamName: string; teamId: string; roster: string[]; entries: TeamLogEntry[]; totalMatched: number }>;
		const lines = selectedTeams.flatMap((team) => teamLogLines(theme, {
			team: `${team.teamName} (${team.teamId})`, roster: roster.length > 0 ? roster : team.roster,
			entries: team.entries, totalMatched: team.totalMatched, returned: team.entries.length,
			filters: { targets: filters.targets, kind: filters.kind, search: filters.search, since: filters.since },
		}));
		if (selectedTeams.length === 0) lines.push(headerLine(theme, "Team Log", theme.fg("muted", "no teams")));
		if (details.nextCursor) lines.push(theme.fg("muted", `  Older events: cursor "${details.nextCursor}"`));
		return lines;
	}
	return teamShutdownLines(theme, String(details.teamName), (details.teammates as Array<{ name: string }>).map((teammate) => teammate.name), roster);
}

export function renderTeamToolCall(tool: TeamToolName, args: Record<string, unknown>, theme: ThemeLike, context: ToolRenderContextLike, roster: string[] = []) {
	return renderPendingCall(callBodyFor(tool, theme, args ?? {}, roster), theme, context, context?.cwd);
}

export function renderTeamToolResult(
	tool: TeamToolName,
	result: { isError?: boolean; details?: unknown },
	options: { expanded: boolean },
	theme: ThemeLike,
	context: ToolRenderContextLike,
	markdownTheme?: MarkdownTheme,
	roster: string[] = [],
): QuotedMarkdownView | TeamLines {
	const args = (context?.args ?? {}) as Record<string, unknown>;
	if (context?.isError || result?.isError) {
		return new TeamLines(errorLines(theme, callBodyFor(tool, theme, args, roster), textContent(result)), options.expanded ? "wrap" : "clip");
	}
	const details = (result?.details ?? {}) as Record<string, unknown>;
	if (markdownTheme && tool === "team_send_message") {
		const message = String(args.message ?? "");
		const header = teamSendHeader(theme, (args.targets ?? []) as string[], message, hasInterruption(args.interrupt), roster);
		const bar = `  ${theme.fg("muted", glyphs().codeBar)} `;
		return new QuotedMarkdownView(header, message, bar, markdownTheme, options.expanded, theme);
	}
	return new TeamLines(resultLinesFor(tool, theme, args, details, options.expanded, roster, markdownTheme), options.expanded ? "wrap" : "clip");
}

export function renderReminderToolCall(args: Record<string, unknown>, theme: ThemeLike, context: ToolRenderContextLike) {
	return renderPendingCall(reminderCallBody(theme, args ?? {}), theme, context, context?.cwd);
}

export function renderReminderToolResult(
	result: { isError?: boolean; details?: unknown },
	options: { expanded: boolean },
	theme: ThemeLike,
	context: ToolRenderContextLike,
): TeamLines {
	const args = (context?.args ?? {}) as Record<string, unknown>;
	if (context?.isError || result?.isError) {
		return new TeamLines(errorLines(theme, reminderCallBody(theme, args), textContent(result)), options.expanded ? "wrap" : "clip");
	}
	return new TeamLines(
		scheduleReminderLines(theme, {
			delayMinutes: args.delayMinutes as number,
			message: args.message as string,
			expanded: options.expanded,
		}),
		options.expanded ? "wrap" : "clip",
	);
}

export function renderTeamMessage(message: { details?: unknown }, options: { expanded: boolean }, theme: ThemeLike, markdownTheme?: MarkdownTheme, roster: string[] = []): QuotedMarkdownView | TeamLines | undefined {
	const details = message.details as TeamMessageDetails | undefined;
	if (!details?.from || !details?.team || typeof details.message !== "string") return undefined;
	if (markdownTheme) {
		const bar = `  ${theme.fg("accent", glyphs().codeBar)} `;
		return new QuotedMarkdownView(teamMessageHeader(theme, details, roster), details.message, bar, markdownTheme, options.expanded, theme);
	}
	const lineLimit = options.expanded ? Number.POSITIVE_INFINITY : SEND_PREVIEW_LINES;
	return new TeamLines(teamMessageLines(theme, details, roster, lineLimit), options.expanded ? "wrap" : "clip");
}

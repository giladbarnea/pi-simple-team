import { Markdown, type MarkdownTheme, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { padVisible, stableRenderWidth, visibleLength } from "./render-support/ansi.ts";
import { glyphs } from "./render-support/glyphs.ts";
import { stackPrefix, toolLabel, treeConnector, treeGlyph, treeStem } from "./render-support/theme.ts";
import { commandExit, plural, renderPendingCall, textContent } from "./render-support/text.ts";
import { timeOfDay, type TeamLogEntry } from "./teamlog.ts";

export interface ThemeLike {
	bold(text: string): string;
	fg(token: string, text: string): string;
}

interface ToolRenderContextLike {
	args?: Record<string, unknown>;
	cwd?: string;
	executionStarted?: boolean;
	invalidate?: () => void;
	isError?: boolean;
	isPartial?: boolean;
	toolCallId?: string;
}

export type TeamToolName = "team_spawn" | "teamsend" | "teamstatus" | "teamlog" | "team_shutdown";

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
}

/** A rendered line with optional wrapping or right-aligned layout metadata. */
export type TeamLine = string | { prefix: string; text: string } | { left: string; right: string };

function isRightAlignedTeamLine(line: TeamLine): line is { left: string; right: string } {
	return typeof line !== "string" && "right" in line;
}

export function teamLineText(line: TeamLine): string {
	if (typeof line === "string") return line;
	if (isRightAlignedTeamLine(line)) return `${line.left}${line.right}`.trimEnd();
	return `${line.prefix}${line.text}`.trimEnd();
}

/** rightAlignedLine("left", "right", 12) === "left   right" */
function rightAlignedLine(left: string, right: string, width: number): string {
	const rightText = truncateToWidth(right, width, glyphs().ellipsis);
	const leftWidth = Math.max(0, width - visibleLength(rightText));
	return `${truncateToWidth(left, leftWidth, glyphs().ellipsis, true)}${rightText}`;
}

function wrapTeamLine(line: TeamLine, width: number): string[] {
	if (isRightAlignedTeamLine(line)) return [rightAlignedLine(line.left, line.right, width)];
	if (typeof line === "string") {
		const wrapped = wrapTextWithAnsi(line, width);
		return wrapped.length > 0 ? wrapped : [""];
	}
	const contentWidth = Math.max(1, width - visibleLength(line.prefix));
	const wrapped = wrapTextWithAnsi(line.text, contentWidth);
	const parts = wrapped.length > 0 ? wrapped : [""];
	return parts.map((part) => clipToWidth(`${line.prefix}${part}`.trimEnd(), width));
}

function clipToWidth(line: string, width: number): string {
	return truncateToWidth(line, Math.max(1, width), glyphs().ellipsis);
}

function clipTeamLine(line: TeamLine, width: number): string {
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
		const renderedLines =
			this.mode === "clip"
				? this.lines.map((line) => clipTeamLine(line, targetWidth))
				: this.lines.flatMap((line) => wrapTeamLine(line, targetWidth));
		this.cachedLines = renderedLines.map((line) => clipToWidth(line, targetWidth));
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

const STATUS_WORD_TOKENS: Record<string, string> = {
	active: "success",
	busy: "success",
	running: "success",
	working: "success",
	blocked: "warning",
	waiting: "warning",
	available: "muted",
	idle: "muted",
	spawned: "muted",
	done: "dim",
	exited: "dim",
	stopped: "dim",
	error: "error",
	failed: "error",
};

/**
 * statusWordToken("working") === "success"; statusWordToken("reviewing") === "accent"
 */
export function statusWordToken(word: string): string {
	return STATUS_WORD_TOKENS[word.trim().toLowerCase()] ?? "accent";
}

function memberRows(theme: ThemeLike, statuses: Record<string, TeamStatusView>, roster: string[], indent = ""): TeamLine[] {
	const names = Object.keys(statuses);
	const nameWidth = Math.max(...names.map((name) => name.length));
	const wordWidth = Math.max(...names.map((name) => statuses[name]!.word.length));
	return names.map((name, index) => {
		const entry = statuses[name]!;
		const branch = index === names.length - 1 ? "└" : "├";
		const left = `${indent}${treeConnector(theme, branch)}${theme.fg(actorHueToken(name, roster), padVisible(name, nameWidth))}  ${theme.fg(statusWordToken(entry.word), padVisible(entry.word, wordWidth))}  ${entry.phrase}`;
		const right = theme.fg("dim", entry.updated);
		return { left, right };
	});
}

export function teamStatusLines(theme: ThemeLike, team: string, statuses: Record<string, TeamStatusView>, roster: string[] = []): TeamLine[] {
	const members = Object.values(statuses);
	const workingCount = members.filter((member) => statusWordToken(member.word) === "success").length;
	const stats = [theme.fg("muted", plural(members.length, "member"))];
	if (workingCount > 0) stats.push(theme.fg("success", `${workingCount} working`));
	return [headerLine(theme, "Team Status", theme.fg("accent", team), stats), ...memberRows(theme, statuses, roster)];
}

export function allTeamsStatusLines(theme: ThemeLike, teams: Record<string, Record<string, TeamStatusView>>, roster: string[] = []): TeamLine[] {
	const teamNames = Object.keys(teams);
	const lines: TeamLine[] = [headerLine(theme, "Team Status", theme.fg("muted", plural(teamNames.length, "team")))];
	teamNames.forEach((teamName, index) => {
		const branch = index === teamNames.length - 1 ? "└" : "├";
		lines.push(`${treeConnector(theme, branch)}${theme.fg("accent", teamName)}`);
		lines.push(...memberRows(theme, teams[teamName]!, roster, treeStem(theme, branch)));
	});
	return lines;
}

interface TeammateSpecView {
	name: string;
	model: string;
	thinking?: string;
}

export function teamSpawnLines(theme: ThemeLike, team: string, teammates: TeammateSpecView[], roster: string[] = []): string[] {
	const header = headerLine(theme, "Team Spawn", theme.fg("accent", team), [theme.fg("muted", plural(teammates.length, "teammate"))]);
	const nameWidth = Math.max(...teammates.map((teammate) => teammate.name.length));
	const rows = teammates.map((teammate, index) => {
		const branch = index === teammates.length - 1 ? "└" : "├";
		const spec = statLine(theme, [theme.fg("muted", teammate.model), theme.fg("dim", teammate.thinking ?? "")]);
		return `${treeConnector(theme, branch)}${theme.fg(actorHueToken(teammate.name, roster), padVisible(teammate.name, nameWidth))}  ${spec}`;
	});
	return [header, ...rows];
}

function quotedBody(theme: ThemeLike, message: string, options: { lineLimit: number; barToken: string }): TeamLine[] {
	const g = glyphs();
	const bar = `  ${theme.fg(options.barToken, g.codeBar)} `;
	const lines = message.replace(/\r\n/g, "\n").split("\n");
	const shown = lines.slice(0, options.lineLimit);
	const body: TeamLine[] = shown.map((line) => ({ prefix: bar, text: line }));
	const hidden = lines.length - shown.length;
	if (hidden > 0) body.push({ prefix: bar, text: theme.fg("dim", `${g.ellipsis} ${hidden} more line${hidden === 1 ? "" : "s"}${g.dot}ctrl+o to expand`) });
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

export function teamSendLines(theme: ThemeLike, options: { to: string[]; message: string; interrupt: boolean; expanded: boolean }, roster: string[] = []): TeamLine[] {
	const header = headerLine(theme, "Team Send", sendTarget(theme, options.to, roster), sendStats(theme, options.message, options.interrupt));
	const lineLimit = options.expanded ? Number.POSITIVE_INFINITY : SEND_PREVIEW_LINES;
	return [header, ...quotedBody(theme, options.message, { lineLimit, barToken: "muted" })];
}

export function teamShutdownLines(theme: ThemeLike, team: string, teammates: string[], roster: string[] = []): string[] {
	const header = headerLine(theme, "Team Shutdown", theme.fg("accent", team), [theme.fg("muted", `${plural(teammates.length, "teammate")} stopped`)]);
	if (teammates.length === 0) return [header];
	return [header, `${treeConnector(theme, "└")}${actorList(theme, teammates, roster, glyphs().dot)}`];
}

const TEAMMATE_HUE_TOKENS = ["mdCode", "customMessageLabel", "mdHeading"] as const;

/**
 * actorHueToken("main", ["scout"]) === "accent"; actorHueToken("scout", ["scout"]) === "mdCode"
 */
export function actorHueToken(name: string, roster: string[]): string {
	if (name === "main") return "accent";
	const index = roster.indexOf(name);
	return index === -1 ? "text" : TEAMMATE_HUE_TOKENS[index % TEAMMATE_HUE_TOKENS.length]!;
}

const DIM_SGR_OPEN = "\x1b[2m";
const DIM_SGR_CLOSE = "\x1b[22m";

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
			const action: LogAction = { ...base, icon: "diamond", iconToken: "borderMuted", action: "turn", details: [textDetail(ellipsis)], startEpoch: entry.epochMilliseconds };
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
			actions.push({ ...base, icon: "diamond", iconToken: "borderMuted", action: "turn", details: countDetails });
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

function logChrome(theme: ThemeLike, branch: "├" | "└", sequence: number, seqWidth: number, epochMilliseconds: number): string {
	return theme.fg("borderMuted", `${treeGlyph(branch)}${padVisible(`#${sequence}`, seqWidth)} ${timeOfDay(epochMilliseconds)}`);
}

function actionRows(theme: ThemeLike, actions: LogAction[], roster: string[], hasFooter: boolean): string[] {
	const g = glyphs();
	const seqWidth = Math.max(...actions.map((action) => `#${action.sequence}`.length));
	const whoWidth = Math.max(...actions.map((action) => action.who.length));
	const actionWidth = Math.max(...actions.map((action) => action.action.length));
	const iconWidth = Math.max(...actions.map((action) => visibleLength(logIconGlyph(action.icon))));
	let previousWho: string | undefined;
	return actions.map((action, index) => {
		const branch = index === actions.length - 1 && !hasFooter ? "└" : "├";
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
		return `${logChrome(theme, branch, action.sequence, seqWidth, action.epochMilliseconds)} ${whoStyled}  ${icon} ${actionName}${detailText ? `${dot}${detailText}` : ""}`;
	});
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
	if (view.entries.length === 0) return [header, `${treeConnector(theme, "└")}${theme.fg("muted", "no matching events")}`];

	const footer = view.nextCursor
		? `${treeConnector(theme, "└")}${theme.fg("muted", `${g.ellipsis} older events${g.dot}cursor "${view.nextCursor}"`)}`
		: undefined;
	const rows = actionRows(theme, actions, view.roster ?? [], Boolean(footer));
	return [header, ...rows, ...(footer ? [footer] : [])];
}

export function teamMessageLines(theme: ThemeLike, details: TeamMessageDetails, roster: string[] = []): TeamLine[] {
	const g = glyphs();
	const header = [
		theme.fg("accent", `${g.diamond} `),
		theme.fg(actorHueToken(details.from, roster), theme.bold(details.from)),
		theme.fg("muted", ` ${g.arrow} ${details.to ?? "main"}`),
		theme.fg("dim", `${g.dot}${details.team}${g.dot}${details.sentAt}`),
	].join("");
	return [header, ...quotedBody(theme, details.message, { lineLimit: Number.POSITIVE_INFINITY, barToken: "accent" })];
}

function teamMessageHeader(theme: ThemeLike, details: TeamMessageDetails, roster: string[]): string {
	const g = glyphs();
	return [
		theme.fg("accent", `${g.diamond} `),
		theme.fg(actorHueToken(details.from, roster), theme.bold(details.from)),
		theme.fg("muted", ` ${g.arrow} ${details.to ?? "main"}`),
		theme.fg("dim", `${g.dot}${details.team}${g.dot}${details.sentAt}`),
	].join("");
}

class TeamSendView {
	private md: Markdown;
	private headerStr: string;
	private barStr: string;
	private barWidth: number;
	private expanded: boolean;
	private theme: ThemeLike;

	constructor(headerStr: string, messageText: string, barStr: string, mdTheme: MarkdownTheme, expanded: boolean, theme: ThemeLike) {
		this.headerStr = headerStr;
		this.barStr = barStr;
		this.barWidth = visibleLength(barStr);
		this.md = new Markdown(messageText, 0, 0, mdTheme);
		this.expanded = expanded;
		this.theme = theme;
	}

	invalidate(): void {
		this.md.invalidate();
	}

	render(width: number): string[] {
		const header = clipToWidth(this.headerStr, width);
		const bodyWidth = Math.max(1, width - this.barWidth);
		const bodyLines = this.md.render(bodyWidth);
		const barred = bodyLines.map((line) => clipToWidth(`${this.barStr}${line}`, width));
		if (this.expanded) return [header, ...barred];
		const shown = barred.slice(0, SEND_PREVIEW_LINES);
		const hidden = barred.length - SEND_PREVIEW_LINES;
		if (hidden > 0) {
			const g = glyphs();
			shown.push(clipToWidth(`${this.barStr}${this.theme.fg("dim", `${g.ellipsis} ${hidden} more line${hidden === 1 ? "" : "s"}${g.dot}ctrl+o to expand`)}`, width));
		}
		return [header, ...shown];
	}
}

class TeamMessageView {
	private md: Markdown;
	private headerLine: string;
	private barStr: string;
	private barWidth: number;

	constructor(headerLine: string, messageText: string, barStr: string, mdTheme: MarkdownTheme) {
		this.headerLine = headerLine;
		this.barStr = barStr;
		this.barWidth = visibleLength(barStr);
		this.md = new Markdown(messageText, 0, 0, mdTheme);
	}

	invalidate(): void {
		this.md.invalidate();
	}

	render(width: number): string[] {
		const bodyWidth = Math.max(1, width - this.barWidth);
		const bodyLines = this.md.render(bodyWidth);
		return [clipToWidth(this.headerLine, width), ...bodyLines.map((line) => clipToWidth(`${this.barStr}${line}`, width))];
	}
}

function accentTeam(theme: ThemeLike, team: unknown): string {
	return typeof team === "string" && team ? theme.fg("accent", team) : "";
}

function callBodyFor(tool: TeamToolName, theme: ThemeLike, args: Record<string, unknown>, roster: string[]): string {
	if (tool === "team_spawn") {
		const teammates = (args.teammates ?? []) as unknown[];
		return callBody(theme, "Team Spawn", accentTeam(theme, args.team), [theme.fg("muted", plural(teammates.length, "teammate"))]);
	}
	if (tool === "teamsend") {
		const message = String(args.message ?? "");
		return callBody(theme, "Team Send", sendTarget(theme, (args.to ?? []) as string[], roster), sendStats(theme, message, Boolean(args.interrupt)));
	}
	if (tool === "teamstatus") {
		const target = accentTeam(theme, args.team) || theme.fg("muted", "all teams");
		const setting = inlineText(`${String(args.word ?? "")} ${String(args.phrase ?? "")}`);
		return callBody(theme, "Team Status", target, setting ? [theme.fg("dim", `set ${setting}`)] : []);
	}
	if (tool === "teamlog") {
		const filterStats = ["teammate", "kind", "search", "since", "cursor"]
			.filter((key) => (typeof args[key] === "string" && args[key]) || (Array.isArray(args[key]) && args[key].length > 0))
			.map((key) => {
				const value = String(args[key]);
				if (key === "teammate") return `${theme.fg("dim", "teammate=")}${theme.fg(actorHueToken(value, roster), value)}`;
				return theme.fg("dim", `${key}=${value}`);
			});
		return callBody(theme, "Team Log", accentTeam(theme, args.team), filterStats);
	}
	return callBody(theme, "Team Shutdown", accentTeam(theme, args.team));
}

function resultLinesFor(tool: TeamToolName, theme: ThemeLike, args: Record<string, unknown>, details: Record<string, unknown>, expanded: boolean, roster: string[]): TeamLine[] {
	if (tool === "team_spawn") {
		return teamSpawnLines(theme, String(details.team), (args.teammates ?? []) as TeammateSpecView[], roster);
	}
	if (tool === "teamsend") {
		return teamSendLines(theme, {
			to: (details.to ?? []) as string[],
			message: String(args.message ?? ""),
			interrupt: Boolean(details.interrupt),
			expanded,
		}, roster);
	}
	if (tool === "teamstatus") {
		if (details.teams) return allTeamsStatusLines(theme, details.teams as Record<string, Record<string, TeamStatusView>>, roster);
		return teamStatusLines(theme, String(details.team), details.status as Record<string, TeamStatusView>, roster);
	}
	if (tool === "teamlog") {
		const filters = (details.filters ?? {}) as Record<string, unknown>;
		return teamLogLines(theme, {
			team: String(details.team),
			roster: roster.length > 0 ? roster : (details.roster ?? []) as string[],
			entries: (details.entries ?? []) as TeamLogEntry[],
			totalMatched: Number(details.totalMatched ?? 0),
			returned: Number(details.returned ?? 0),
			nextCursor: details.nextCursor as string | undefined,
			filters: { teammate: filters.teammate, kind: filters.kind, search: filters.search, since: filters.since },
		});
	}
	return teamShutdownLines(theme, String(details.team), (details.teammates ?? []) as string[], roster);
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
): TeamSendView | TeamLines {
	const args = context?.args ?? {};
	if (context?.isError || result?.isError) {
		return new TeamLines(errorLines(theme, callBodyFor(tool, theme, args, roster), textContent(result)), options.expanded ? "wrap" : "clip");
	}
	const details = (result?.details ?? {}) as Record<string, unknown>;
	if (markdownTheme && tool === "teamsend") {
		const message = String(args.message ?? "");
		const header = headerLine(theme, "Team Send", sendTarget(theme, (details.to ?? []) as string[], roster), sendStats(theme, message, Boolean(details.interrupt)));
		const bar = `  ${theme.fg("muted", glyphs().codeBar)} `;
		return new TeamSendView(header, message, bar, markdownTheme, options.expanded, theme);
	}
	return new TeamLines(resultLinesFor(tool, theme, args, details, options.expanded, roster), options.expanded ? "wrap" : "clip");
}

export function renderTeamMessage(message: { details?: unknown }, theme: ThemeLike, markdownTheme?: MarkdownTheme, roster: string[] = []): TeamMessageView | TeamLines | undefined {
	const details = message.details as TeamMessageDetails | undefined;
	if (!details?.from || !details?.team || typeof details.message !== "string") return undefined;
	if (markdownTheme) {
		const g = glyphs();
		const bar = `  ${theme.fg("accent", g.codeBar)} `;
		return new TeamMessageView(teamMessageHeader(theme, details, roster), details.message, bar, markdownTheme);
	}
	return new TeamLines(teamMessageLines(theme, details, roster), "wrap");
}

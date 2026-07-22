import { Markdown, type MarkdownTheme, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { padVisible, stableRenderWidth, visibleLength } from "./render-support/ansi.ts";
import { glyphs } from "./render-support/glyphs.ts";
import { stackPrefix, toolLabel, treeConnector, treeStem } from "./render-support/theme.ts";
import { plural, renderPendingCall, textContent } from "./render-support/text.ts";
import { timeOfDay, type TeamLogEntry, type TeamLogKind } from "./teamlog.ts";

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
	sentAt: string;
	message: string;
}

interface TeamLogRenderView {
	team: string;
	entries: TeamLogEntry[];
	totalMatched: number;
	returned: number;
	nextCursor?: string;
	filters?: Record<string, unknown>;
}

/** A rendered line; the prefixed form re-applies its prefix (e.g. a quote bar) to wrapped continuations. */
export type TeamLine = string | { prefix: string; text: string };

export function teamLineText(line: TeamLine): string {
	return typeof line === "string" ? line : `${line.prefix}${line.text}`.trimEnd();
}

function wrapTeamLine(line: TeamLine, width: number): string[] {
	if (typeof line === "string") {
		const wrapped = wrapTextWithAnsi(line, width);
		return wrapped.length > 0 ? wrapped : [""];
	}
	const contentWidth = Math.max(10, width - visibleLength(line.prefix));
	const wrapped = wrapTextWithAnsi(line.text, contentWidth);
	const parts = wrapped.length > 0 ? wrapped : [""];
	return parts.map((part) => `${line.prefix}${part}`.trimEnd());
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
		this.cachedLines =
			this.mode === "clip"
				? this.lines.map((line) => truncateToWidth(teamLineText(line), targetWidth, glyphs().ellipsis))
				: this.lines.flatMap((line) => wrapTeamLine(line, targetWidth));
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

function memberRows(theme: ThemeLike, statuses: Record<string, TeamStatusView>, indent = ""): string[] {
	const names = Object.keys(statuses);
	const nameWidth = Math.max(...names.map((name) => name.length));
	const wordWidth = Math.max(...names.map((name) => statuses[name]!.word.length));
	return names.map((name, index) => {
		const entry = statuses[name]!;
		const branch = index === names.length - 1 ? "└" : "├";
		const tail = statLine(theme, [entry.phrase, theme.fg("dim", entry.updated)]);
		return `${indent}${treeConnector(theme, branch)}${theme.fg("accent", padVisible(name, nameWidth))}  ${theme.fg(statusWordToken(entry.word), padVisible(entry.word, wordWidth))}  ${tail}`;
	});
}

export function teamStatusLines(theme: ThemeLike, team: string, statuses: Record<string, TeamStatusView>): string[] {
	const members = Object.values(statuses);
	const workingCount = members.filter((member) => statusWordToken(member.word) === "success").length;
	const stats = [theme.fg("muted", plural(members.length, "member"))];
	if (workingCount > 0) stats.push(theme.fg("success", `${workingCount} working`));
	return [headerLine(theme, "Team Status", theme.fg("accent", team), stats), ...memberRows(theme, statuses)];
}

export function allTeamsStatusLines(theme: ThemeLike, teams: Record<string, Record<string, TeamStatusView>>): string[] {
	const teamNames = Object.keys(teams);
	const lines = [headerLine(theme, "Team Status", theme.fg("muted", plural(teamNames.length, "team")))];
	teamNames.forEach((teamName, index) => {
		const branch = index === teamNames.length - 1 ? "└" : "├";
		lines.push(`${treeConnector(theme, branch)}${theme.fg("accent", teamName)}`);
		lines.push(...memberRows(theme, teams[teamName]!, treeStem(theme, branch)));
	});
	return lines;
}

interface TeammateSpecView {
	name: string;
	model: string;
	thinking?: string;
}

export function teamSpawnLines(theme: ThemeLike, team: string, teammates: TeammateSpecView[]): string[] {
	const header = headerLine(theme, "Team Spawn", theme.fg("accent", team), [theme.fg("muted", plural(teammates.length, "teammate"))]);
	const nameWidth = Math.max(...teammates.map((teammate) => teammate.name.length));
	const rows = teammates.map((teammate, index) => {
		const branch = index === teammates.length - 1 ? "└" : "├";
		const spec = statLine(theme, [theme.fg("muted", teammate.model), theme.fg("dim", teammate.thinking ?? "")]);
		return `${treeConnector(theme, branch)}${theme.fg("accent", padVisible(teammate.name, nameWidth))}  ${spec}`;
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

function sendTarget(theme: ThemeLike, to: string[]): string {
	return `${theme.fg("muted", `${glyphs().arrow} `)}${theme.fg("accent", to.join(", "))}`;
}

function sendStats(theme: ThemeLike, message: string, interrupt: boolean): string[] {
	return [interrupt ? theme.fg("warning", "interrupt") : "", theme.fg("muted", formatCharCount(message.length))];
}

export function teamSendLines(theme: ThemeLike, options: { to: string[]; message: string; interrupt: boolean; expanded: boolean }): TeamLine[] {
	const header = headerLine(theme, "Team Send", sendTarget(theme, options.to), sendStats(theme, options.message, options.interrupt));
	const lineLimit = options.expanded ? Number.POSITIVE_INFINITY : SEND_PREVIEW_LINES;
	return [header, ...quotedBody(theme, options.message, { lineLimit, barToken: "muted" })];
}

export function teamShutdownLines(theme: ThemeLike, team: string, teammates: string[]): string[] {
	const header = headerLine(theme, "Team Shutdown", theme.fg("accent", team), [theme.fg("muted", `${plural(teammates.length, "teammate")} stopped`)]);
	if (teammates.length === 0) return [header];
	return [header, `${treeConnector(theme, "└")}${theme.fg("muted", teammates.join(glyphs().dot))}`];
}

type KindMarkName = "arrow" | "bullet" | "diamond" | "emptyBullet" | "fail" | "ok" | "warn";

const KIND_MARK_SPECS: Record<TeamLogKind, { mark: KindMarkName; token: string }> = {
	spawn: { mark: "diamond", token: "accent" },
	send: { mark: "arrow", token: "accent" },
	deliver: { mark: "arrow", token: "muted" },
	ack: { mark: "ok", token: "dim" },
	status: { mark: "emptyBullet", token: "muted" },
	agent_start: { mark: "bullet", token: "success" },
	agent_end: { mark: "emptyBullet", token: "muted" },
	tool_start: { mark: "emptyBullet", token: "dim" },
	tool_end: { mark: "ok", token: "muted" },
	main_message: { mark: "arrow", token: "success" },
	stderr: { mark: "warn", token: "warning" },
	exit: { mark: "warn", token: "warning" },
	error: { mark: "fail", token: "error" },
};

export function kindMark(entry: Pick<TeamLogEntry, "kind" | "details">): { glyph: string; token: string } {
	const failedToolEnd = entry.kind === "tool_end" && Boolean(entry.details?.isError);
	const spec = failedToolEnd ? { mark: "fail" as const, token: "error" } : KIND_MARK_SPECS[entry.kind];
	const g = glyphs();
	const marks: Record<KindMarkName, string> = {
		arrow: g.arrow,
		bullet: g.bullet.trim(),
		diamond: g.diamond,
		emptyBullet: g.emptyBullet.trim(),
		fail: g.fail,
		ok: g.ok,
		warn: g.warn,
	};
	return { glyph: marks[spec.mark], token: spec.token };
}

function inlineText(value: unknown): string {
	const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
	return text.replace(/\s+/g, " ").trim();
}

function toolResultText(result: unknown): string {
	const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
	const textPart = content?.find((part) => part?.type === "text" && typeof part.text === "string");
	return inlineText(textPart?.text ?? result);
}

function entrySummary(theme: ThemeLike, entry: TeamLogEntry): string {
	const details = entry.details ?? {};
	if (entry.kind === "tool_start") return `${String(details.toolName ?? "tool")} ${theme.fg("dim", inlineText(details.args))}`;
	if (entry.kind === "tool_end") {
		const token = details.isError ? "error" : "dim";
		return `${String(details.toolName ?? "tool")} ${theme.fg(token, toolResultText(details.result))}`;
	}
	if ((entry.kind === "send" || entry.kind === "deliver") && typeof details.from === "string") {
		return `${theme.fg("dim", `${details.from} ${glyphs().arrow} `)}${entry.summary}`;
	}
	if (entry.kind === "error") return theme.fg("error", entry.summary);
	if (entry.kind === "stderr") return theme.fg("warning", entry.summary);
	return entry.summary;
}

export function teamLogLines(theme: ThemeLike, view: TeamLogRenderView): string[] {
	const g = glyphs();
	const stats = [theme.fg("muted", `${view.returned} of ${view.totalMatched} events`)];
	for (const [key, value] of Object.entries(view.filters ?? {})) {
		if (typeof value === "string" && value) stats.push(theme.fg("dim", `${key}=${value}`));
	}
	const header = headerLine(theme, "Team Log", theme.fg("accent", view.team), stats);
	if (view.entries.length === 0) return [header, `${treeConnector(theme, "└")}${theme.fg("muted", "no matching events")}`];

	const seqWidth = Math.max(...view.entries.map((entry) => String(entry.sequence).length)) + 1;
	const nameWidth = Math.max(...view.entries.map((entry) => (entry.teammate ?? "main").length));
	const kindWidth = Math.max(...view.entries.map((entry) => entry.kind.length));
	const footer = view.nextCursor
		? `${treeConnector(theme, "└")}${theme.fg("muted", `${g.ellipsis} older events${g.dot}cursor "${view.nextCursor}"`)}`
		: undefined;
	const rows = view.entries.map((entry, index) => {
		const branch = index === view.entries.length - 1 && !footer ? "└" : "├";
		const mark = kindMark(entry);
		return [
			treeConnector(theme, branch),
			theme.fg("dim", padVisible(`#${entry.sequence}`, seqWidth)),
			` ${theme.fg("dim", timeOfDay(entry.epochMilliseconds))}`,
			` ${theme.fg("accent", padVisible(entry.teammate ?? "main", nameWidth))}`,
			`  ${theme.fg(mark.token, padVisible(mark.glyph, 2))}`,
			theme.fg("muted", padVisible(entry.kind, kindWidth)),
			`  ${entrySummary(theme, entry)}`,
		].join("");
	});
	return [header, ...rows, ...(footer ? [footer] : [])];
}

export function teamMessageLines(theme: ThemeLike, details: TeamMessageDetails): TeamLine[] {
	const g = glyphs();
	const header = [
		theme.fg("accent", `${g.diamond} `),
		theme.fg("accent", theme.bold(details.from)),
		theme.fg("muted", ` ${g.arrow} main`),
		theme.fg("dim", `${g.dot}${details.team}${g.dot}${details.sentAt}`),
	].join("");
	return [header, ...quotedBody(theme, details.message, { lineLimit: Number.POSITIVE_INFINITY, barToken: "accent" })];
}

function teamMessageHeader(theme: ThemeLike, details: TeamMessageDetails): string {
	const g = glyphs();
	return [
		theme.fg("accent", `${g.diamond} `),
		theme.fg("accent", theme.bold(details.from)),
		theme.fg("muted", ` ${g.arrow} main`),
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
		const bodyWidth = Math.max(10, width - this.barWidth);
		const bodyLines = this.md.render(bodyWidth);
		const barred = bodyLines.map((line) => `${this.barStr}${line}`);
		if (this.expanded) return [this.headerStr, ...barred];
		const shown = barred.slice(0, SEND_PREVIEW_LINES);
		const hidden = barred.length - SEND_PREVIEW_LINES;
		if (hidden > 0) {
			const g = glyphs();
			shown.push(`${this.barStr}${this.theme.fg("dim", `${g.ellipsis} ${hidden} more line${hidden === 1 ? "" : "s"}${g.dot}ctrl+o to expand`)}`);
		}
		return [this.headerStr, ...shown];
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
		const bodyWidth = Math.max(10, width - this.barWidth);
		const bodyLines = this.md.render(bodyWidth);
		return [this.headerLine, ...bodyLines.map((line) => `${this.barStr}${line}`)];
	}
}

function accentTeam(theme: ThemeLike, team: unknown): string {
	return typeof team === "string" && team ? theme.fg("accent", team) : "";
}

function callBodyFor(tool: TeamToolName, theme: ThemeLike, args: Record<string, unknown>): string {
	if (tool === "team_spawn") {
		const teammates = (args.teammates ?? []) as unknown[];
		return callBody(theme, "Team Spawn", accentTeam(theme, args.team), [theme.fg("muted", plural(teammates.length, "teammate"))]);
	}
	if (tool === "teamsend") {
		const message = String(args.message ?? "");
		return callBody(theme, "Team Send", sendTarget(theme, (args.to ?? []) as string[]), sendStats(theme, message, Boolean(args.interrupt)));
	}
	if (tool === "teamstatus") {
		const target = accentTeam(theme, args.team) || theme.fg("muted", "all teams");
		const setting = inlineText(`${String(args.word ?? "")} ${String(args.phrase ?? "")}`);
		return callBody(theme, "Team Status", target, setting ? [theme.fg("dim", `set ${setting}`)] : []);
	}
	if (tool === "teamlog") {
		const filterStats = ["teammate", "kind", "search", "since", "cursor"]
			.filter((key) => typeof args[key] === "string" && args[key])
			.map((key) => theme.fg("dim", `${key}=${String(args[key])}`));
		return callBody(theme, "Team Log", accentTeam(theme, args.team), filterStats);
	}
	return callBody(theme, "Team Shutdown", accentTeam(theme, args.team));
}

function resultLinesFor(tool: TeamToolName, theme: ThemeLike, args: Record<string, unknown>, details: Record<string, unknown>, expanded: boolean): TeamLine[] {
	if (tool === "team_spawn") {
		return teamSpawnLines(theme, String(details.team), (args.teammates ?? []) as TeammateSpecView[]);
	}
	if (tool === "teamsend") {
		return teamSendLines(theme, {
			to: (details.to ?? []) as string[],
			message: String(args.message ?? ""),
			interrupt: Boolean(details.interrupt),
			expanded,
		});
	}
	if (tool === "teamstatus") {
		if (details.teams) return allTeamsStatusLines(theme, details.teams as Record<string, Record<string, TeamStatusView>>);
		return teamStatusLines(theme, String(details.team), details.status as Record<string, TeamStatusView>);
	}
	if (tool === "teamlog") {
		const filters = (details.filters ?? {}) as Record<string, unknown>;
		return teamLogLines(theme, {
			team: String(details.team),
			entries: (details.entries ?? []) as TeamLogEntry[],
			totalMatched: Number(details.totalMatched ?? 0),
			returned: Number(details.returned ?? 0),
			nextCursor: details.nextCursor as string | undefined,
			filters: { teammate: filters.teammate, kind: filters.kind, search: filters.search, since: filters.since },
		});
	}
	return teamShutdownLines(theme, String(details.team), (details.teammates ?? []) as string[]);
}

export function renderTeamToolCall(tool: TeamToolName, args: Record<string, unknown>, theme: ThemeLike, context: ToolRenderContextLike) {
	return renderPendingCall(callBodyFor(tool, theme, args ?? {}), theme, context, context?.cwd);
}

export function renderTeamToolResult(
	tool: TeamToolName,
	result: { isError?: boolean; details?: unknown },
	options: { expanded: boolean },
	theme: ThemeLike,
	context: ToolRenderContextLike,
	markdownTheme?: MarkdownTheme,
): TeamSendView | TeamLines {
	const args = context?.args ?? {};
	if (context?.isError || result?.isError) {
		return new TeamLines(errorLines(theme, callBodyFor(tool, theme, args), textContent(result)), options.expanded ? "wrap" : "clip");
	}
	const details = (result?.details ?? {}) as Record<string, unknown>;
	if (markdownTheme && tool === "teamsend") {
		const message = String(args.message ?? "");
		const header = headerLine(theme, "Team Send", sendTarget(theme, (details.to ?? []) as string[]), sendStats(theme, message, Boolean(details.interrupt)));
		const bar = `  ${theme.fg("muted", glyphs().codeBar)} `;
		return new TeamSendView(header, message, bar, markdownTheme, options.expanded, theme);
	}
	return new TeamLines(resultLinesFor(tool, theme, args, details, options.expanded), options.expanded ? "wrap" : "clip");
}

export function renderTeamMessage(message: { details?: unknown }, theme: ThemeLike, markdownTheme?: MarkdownTheme): TeamMessageView | TeamLines | undefined {
	const details = message.details as TeamMessageDetails | undefined;
	if (!details?.from || !details?.team || typeof details.message !== "string") return undefined;
	if (markdownTheme) {
		const g = glyphs();
		const bar = `  ${theme.fg("accent", g.codeBar)} `;
		return new TeamMessageView(teamMessageHeader(theme, details), details.message, bar, markdownTheme);
	}
	return new TeamLines(teamMessageLines(theme, details), "wrap");
}

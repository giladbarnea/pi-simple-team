import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, sliceByColumn, truncateToWidth, visibleWidth, type Component, type SelectItem, type TUI } from "@earendil-works/pi-tui";

import {
	actorHueToken,
	statusWordToken,
	teamLineText,
	teamLogLines,
	teamMessageLines,
	type TeamMessageDetails,
	type TeamStatusView,
	type ThemeLike,
} from "./render.ts";
import type { TeamLogEntry, TeamLogKind } from "./teamlog.ts";

export interface TeamSnapshot {
	name: string;
	created: string;
	showOnHerdrPanes: boolean;
	roster: string[];
	statuses: Record<string, TeamStatusView>;
	log: TeamLogEntry[];
}

export type TeamSnapshotSource = () => readonly TeamSnapshot[];

const RECENT_STATUS_LIMIT = 5;
const RECENT_LOG_ENTRY_LIMIT = 20;
const LIVE_REFRESH_INTERVAL_MILLISECONDS = 500;
const MESSAGE_LOG_KINDS = new Set<TeamLogKind>(["send", "deliver", "ack", "main_message"]);

const overlayOptions = {
	overlay: true,
	overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%" },
} as const;

function teamMessage(entry: TeamLogEntry): TeamMessageDetails | undefined {
	if (entry.kind !== "send" && entry.kind !== "main_message") return undefined;
	const details = entry.details as { from: string; to: string; message: string };
	return {
		team: entry.team,
		from: entry.kind === "main_message" ? entry.teammate! : details.from,
		to: entry.kind === "main_message" ? "main" : details.to,
		sentAt: entry.timestamp,
		message: details.message,
	};
}

/** middleTruncateToWidth("abcdefghij", 7) === "abc…hij" */
function middleTruncateToWidth(text: string, width: number, pad = false): string {
	const targetWidth = Math.max(0, width);
	const textWidth = visibleWidth(text);
	if (textWidth <= targetWidth) return pad ? `${text}${" ".repeat(targetWidth - textWidth)}` : text;
	if (targetWidth === 0) return "";

	const ellipsis = "…";
	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth >= targetWidth) return truncateToWidth(ellipsis, targetWidth, "", pad);

	const retainedWidth = targetWidth - ellipsisWidth;
	const leftWidth = Math.ceil(retainedWidth / 2);
	const rightWidth = Math.floor(retainedWidth / 2);
	const left = sliceByColumn(text, 0, leftWidth, true);
	const right = sliceByColumn(text, textWidth - rightWidth, rightWidth, true);
	const reset = text.includes("\x1b") ? "\x1b[0m" : "";
	const result = `${left}${reset}${ellipsis}${reset}${right}`;
	return pad ? `${result}${" ".repeat(Math.max(0, targetWidth - visibleWidth(result)))}` : result;
}

/** Keeps the most recently updated status first. */
function recentStatuses(statuses: Record<string, TeamStatusView>, limit: number): Array<[string, TeamStatusView]> {
	return Object.entries(statuses)
		.sort(([, left], [, right]) => Date.parse(right.updated) - Date.parse(left.updated))
		.slice(0, limit);
}

function padVisible(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function statusRows(theme: ThemeLike, statuses: Array<[string, TeamStatusView]>, roster: string[], width: number): string[] {
	const contentWidth = Math.max(0, width - 1);
	const nameWidth = Math.max(0, ...statuses.map(([name]) => visibleWidth(name)));
	const wordWidth = Math.max(0, ...statuses.map(([, status]) => visibleWidth(status.word)));
	const timestampWidth = Math.max(0, ...statuses.map(([, status]) => visibleWidth(status.updated)));
	const phraseWidth = Math.max(0, contentWidth - nameWidth - wordWidth - timestampWidth - 6);

	return statuses.map(([name, status]) => {
		const styledName = theme.fg(actorHueToken(name, roster), name);
		const styledWord = theme.fg(statusWordToken(status.word), status.word);
		const timestamp = theme.fg("dim", status.updated);
		const phrase = middleTruncateToWidth(status.phrase, phraseWidth, true);
		return `${padVisible(styledName, nameWidth)}  ${padVisible(styledWord, wordWidth)}  ${phrase}  ${timestamp}`;
	});
}

function limitMessageRows(lines: string[], height: number): string[] {
	if (lines.length <= height) return lines;
	if (height <= 0) return [];
	if (height === 1) return [lines[0]!];
	if (height === 2) return [lines[0]!, `… ${lines.length - 1} message lines omitted …`];

	const body = lines.slice(1);
	const retainedBodyRows = height - 2;
	const leadingRows = Math.ceil(retainedBodyRows / 2);
	const trailingRows = Math.floor(retainedBodyRows / 2);
	return [
		lines[0]!,
		...body.slice(0, leadingRows),
		`… ${body.length - retainedBodyRows} message lines omitted …`,
		...(trailingRows > 0 ? body.slice(-trailingRows) : []),
	];
}

interface MessageLineSelection {
	lines: string[];
	messageCount: number;
}

/** selectNewestMessageLines([["old"], ["new"]], 1).lines[0] === "new" */
function selectNewestMessageLines(groups: string[][], height: number): MessageLineSelection {
	const selectedGroups: string[][] = [];
	let remainingHeight = height;

	for (let index = groups.length - 1; index >= 0; index--) {
		const group = groups[index]!;
		const separatorHeight = selectedGroups.length > 0 ? 1 : 0;
		if (group.length + separatorHeight <= remainingHeight) {
			selectedGroups.unshift(group);
			remainingHeight -= group.length + separatorHeight;
			continue;
		}
		if (selectedGroups.length === 0) selectedGroups.push(limitMessageRows(group, height));
		break;
	}

	return {
		lines: selectedGroups.flatMap((group, index) => [...(index > 0 ? [""] : []), ...group]),
		messageCount: selectedGroups.length,
	};
}

class TeamOverviewOverlay implements Component {
	private selector?: SelectList;
	private selectorTeamNames?: string;
	private selectedTeamName?: string;
	private refreshTimer?: ReturnType<typeof setInterval>;
	private closed = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: ThemeLike,
		private readonly teamSource: TeamSnapshotSource,
		private readonly done: () => void,
	) {
		this.refreshTimer = setInterval(() => this.tui.requestRender(), LIVE_REFRESH_INTERVAL_MILLISECONDS);
		this.refreshTimer.unref?.();
	}

	/** Teams can appear or vanish while the overlay is open, so the selector follows the current snapshot. */
	private refreshSelector(teams: readonly TeamSnapshot[]): void {
		const teamNames = teams.map((team) => team.name).join("\n");
		if (this.selector && this.selectorTeamNames === teamNames) return;
		this.selectorTeamNames = teamNames;
		const items: SelectItem[] = teams.map((team) => ({
			value: team.name,
			label: team.name,
			description: `${team.roster.length} teammate${team.roster.length === 1 ? "" : "s"}`,
		}));
		this.selector = new SelectList(items, this.selectorHeight(teams.length), {
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.fg("accent", text),
			description: (text) => this.theme.fg("muted", text),
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: (text) => this.theme.fg("warning", text),
		});
		this.selector.onSelect = (item) => {
			this.selectedTeamName = item.value;
			this.tui.requestRender();
		};
		this.selector.onCancel = this.close;
	}

	handleInput(data: string): void {
		if (!this.selectedTeamName && this.selector) {
			this.selector.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.close();
	}

	render(width: number): string[] {
		const height = Math.max(4, Math.floor(this.tui.terminal.rows * 0.9));
		const teams = this.teamSource();
		if (this.selectedTeamName && !teams.some((candidate) => candidate.name === this.selectedTeamName)) this.selectedTeamName = undefined;
		if (!this.selectedTeamName && teams.length === 1) this.selectedTeamName = teams[0]!.name;
		if (this.selectedTeamName) {
			const team = teams.find((candidate) => candidate.name === this.selectedTeamName)!;
			return this.dashboard(team, width, height);
		}
		if (teams.length > 1) this.refreshSelector(teams);
		else this.selector = undefined;
		const innerHeight = height - 2;
		return this.frame(this.content(Math.max(1, width - 4), teams).slice(0, innerHeight), width, height);
	}

	invalidate(): void {
		this.selector?.invalidate();
	}

	dispose(): void {
		if (!this.refreshTimer) return;
		clearInterval(this.refreshTimer);
		this.refreshTimer = undefined;
	}

	private readonly close = (): void => {
		if (this.closed) return;
		this.closed = true;
		this.dispose();
		this.done();
	};

	private selectorHeight(teamCount: number): number {
		return Math.max(1, Math.min(teamCount, Math.floor(this.tui.terminal.rows * 0.9) - 8));
	}

	private content(width: number, teams: readonly TeamSnapshot[]): string[] {
		if (teams.length === 0) {
			return [
				this.theme.fg("accent", this.theme.bold("Teams")),
				"",
				"No teams exist.",
				"",
				this.theme.fg("dim", "Esc close"),
			];
		}
		return [
			this.theme.fg("accent", this.theme.bold("Select a team")),
			"",
			...this.selector!.render(width),
			"",
			this.theme.fg("dim", "↑↓ select · Enter open · Esc close"),
		];
	}

	private dashboard(team: TeamSnapshot, width: number, height: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		const contentHeight = Math.max(1, height - 2);
		const headerHeight = Math.min(3, Math.max(1, contentHeight - 3));
		const desiredStatusHeight = Math.min(Object.keys(team.statuses).length, RECENT_STATUS_LIMIT) + 2;
		const statusHeight = Math.max(1, Math.min(desiredStatusHeight, contentHeight - headerHeight - 2));
		const feedHeight = contentHeight - headerHeight - statusHeight;
		const messageHeight = Math.max(1, Math.min(feedHeight - 1, Math.round(feedHeight * 0.55)));
		const logHeight = feedHeight - messageHeight;

		const transport = team.showOnHerdrPanes ? "Herdr" : "RPC";
		const metadata = [
			`Created ${team.created}`,
			`${team.roster.length} teammate${team.roster.length === 1 ? "" : "s"}`,
			transport,
			`${team.log.length} retained event${team.log.length === 1 ? "" : "s"}`,
			"Esc close",
		].join(" · ");

		const statusContentHeight = Math.max(0, statusHeight - 2);
		const statuses = recentStatuses(team.statuses, Math.min(RECENT_STATUS_LIMIT, statusContentHeight));
		const statusLines = statusRows(this.theme, statuses, team.roster, Math.max(0, contentWidth - 2));

		const allMessages = team.log.flatMap((entry) => {
			const message = teamMessage(entry);
			return message ? [message] : [];
		});
		const messageGroups = allMessages.map((message) => teamMessageLines(this.theme, message, team.roster).map(teamLineText));
		const selectedMessages = selectNewestMessageLines(messageGroups, Math.max(0, messageHeight - 2));
		const messageLines = selectedMessages.lines.length > 0 ? selectedMessages.lines : [this.theme.fg("muted", "No recent messages.")];

		const allLogEntries = team.log.filter((entry) => !MESSAGE_LOG_KINDS.has(entry.kind));
		const recentLogEntries = allLogEntries.slice(-RECENT_LOG_ENTRY_LIMIT);
		const renderedLogLines = teamLogLines(this.theme, {
			team: team.name,
			roster: team.roster,
			entries: recentLogEntries,
			totalMatched: allLogEntries.length,
			returned: recentLogEntries.length,
		}).slice(1);
		const logContentHeight = Math.max(0, logHeight - 2);
		const logLines = renderedLogLines.slice(-logContentHeight);

		const content = [
			...this.region(this.theme.fg("accent", this.theme.bold(`Team: ${team.name}`)), [this.theme.fg("muted", metadata)], contentWidth, headerHeight),
			...this.region(`Team Status ${team.name} · latest ${statuses.length} of ${Object.keys(team.statuses).length}`, statusLines, contentWidth, statusHeight),
			...this.region(`Messages · latest ${selectedMessages.messageCount} of ${allMessages.length}`, messageLines, contentWidth, messageHeight),
			...this.region(`Team Log ${team.name} · latest ${logLines.length} rows · ${allLogEntries.length} events`, logLines, contentWidth, logHeight),
		];
		return this.frame(content, width, height);
	}

	private region(title: string, content: string[], width: number, height: number): string[] {
		const frameWidth = Math.max(1, width);
		const border = (text: string): string => this.theme.fg("border", text);
		if (frameWidth < 3) {
			const top = border(frameWidth === 1 ? "╭" : "╭╮");
			if (height === 1) return [top];
			const row = border("│".repeat(frameWidth));
			return [top, ...Array.from({ length: Math.max(0, height - 2) }, () => row), border(frameWidth === 1 ? "╰" : "╰╯")];
		}

		const innerWidth = frameWidth - 2;
		const labelWidth = Math.max(0, innerWidth - 3);
		const label = middleTruncateToWidth(title, labelWidth);
		const topFill = "─".repeat(Math.max(0, innerWidth - 3 - visibleWidth(label)));
		const top = innerWidth < 3 ? border(`╭${"─".repeat(innerWidth)}╮`) : `${border("╭─ ")}${label}${border(` ${topFill}╮`)}`;
		if (height === 1) return [top];

		const visibleContent = content.slice(0, Math.max(0, height - 2));
		while (visibleContent.length < height - 2) visibleContent.push("");
		const row = (text: string): string => `${border("│")}${middleTruncateToWidth(` ${text}`, innerWidth, true)}${border("│")}`;
		return [top, ...visibleContent.map(row), border(`╰${"─".repeat(innerWidth)}╯`)];
	}

	private frame(content: string[], width: number, height: number): string[] {
		const frameWidth = Math.max(1, width);
		const innerHeight = height - 2;
		const border = (text: string): string => this.theme.fg("border", text);
		if (frameWidth < 3) {
			const row = border("│".repeat(frameWidth));
			return [border(frameWidth === 1 ? "╭" : "╭╮"), ...Array.from({ length: innerHeight }, () => row), border(frameWidth === 1 ? "╰" : "╰╯")];
		}

		const innerWidth = frameWidth - 2;
		const visibleContent = content.slice(0, innerHeight);
		while (visibleContent.length < innerHeight) visibleContent.push("");
		const row = (text: string): string => `${border("│")}${middleTruncateToWidth(text, innerWidth, true)}${border("│")}`;
		return [border(`╭${"─".repeat(innerWidth)}╮`), ...visibleContent.map(row), border(`╰${"─".repeat(innerWidth)}╯`)];
	}
}

export async function openTeamOverview(context: ExtensionCommandContext, teamSource: TeamSnapshotSource): Promise<void> {
	if (context.mode !== "tui") {
		context.ui.notify("/team is available only in interactive mode.", "warning");
		return;
	}
	await context.ui.custom<void>(
		(tui, theme, _keybindings, done) => new TeamOverviewOverlay(tui, theme, teamSource, done),
		overlayOptions,
	);
}

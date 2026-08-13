import assert from "node:assert/strict";

import { describe, test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type OverlayOptions, type TUI } from "@earendil-works/pi-tui";

import teamExtension from "../index.ts";
import { openTeamOverview, type TeamSnapshot } from "../team-ui.ts";
import type { TeamLogEntry } from "../teamlog.ts";

type JsonRecord = Record<string, unknown>;
type EventHandler = (event: JsonRecord, context: ExtensionContext) => Promise<unknown> | unknown;
type ToolResult = { content: Array<{ type: string; text: string }>; details?: JsonRecord };
type RegisteredTool = {
	name: string;
	execute: (toolCallId: string, params: JsonRecord, signal: AbortSignal, onUpdate: undefined, context: ExtensionContext) => Promise<ToolResult>;
};
type RegisteredCommand = {
	handler: (args: string, context: ExtensionCommandContext) => Promise<void> | void;
};
type OverlaySettings = { overlay?: boolean; overlayOptions?: OverlayOptions };
type OverlayDriver = (component: Component, settings: OverlaySettings) => void;

const identityTheme = {
	bold: (text: string) => text,
	bg: (_token: string, text: string) => text,
	fg: (_token: string, text: string) => text,
};

class TeamCommandHost {
	readonly commands = new Map<string, RegisteredCommand>();
	readonly tools = new Map<string, RegisteredTool>();
	readonly shutdownHandlers: EventHandler[] = [];
	readonly notifications: string[] = [];
	readonly context: ExtensionCommandContext;
	private overlayDriver?: OverlayDriver;

	constructor(rows = 40) {
		const tui = {
			terminal: { rows },
			requestRender: () => undefined,
		} as unknown as TUI;
		const ui = {
			theme: identityTheme,
			notify: (message: string) => this.notifications.push(message),
			custom: async (
				factory: (tui: TUI, theme: typeof identityTheme, keybindings: unknown, done: (value: unknown) => void) => Component,
				settings: OverlaySettings,
			): Promise<unknown> =>
				new Promise((resolve, reject) => {
					const component = factory(tui, identityTheme, {}, resolve);
					try {
						assert.ok(this.overlayDriver, "Expected the test to provide an overlay driver.");
						this.overlayDriver(component, settings);
					} catch (error) {
						reject(error);
					}
				}),
		};
		this.context = {
			mode: "tui",
			hasUI: true,
			ui,
			scopedModels: [],
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionFile: () => "/tmp/pi-simple-team-test-session.jsonl" },
		} as unknown as ExtensionCommandContext;

		const api = {
			on: (event: string, handler: EventHandler) => {
				if (event === "session_shutdown") this.shutdownHandlers.push(handler);
				if (event === "session_start") handler({ reason: "startup" }, this.context);
			},
			registerCommand: (name: string, command: RegisteredCommand) => this.commands.set(name, command),
			registerMessageRenderer: () => undefined,
			registerTool: (tool: RegisteredTool) => this.tools.set(tool.name, tool),
			sendMessage: () => undefined,
		} as unknown as ExtensionAPI;
		teamExtension(api);
	}

	async spawnEmptyTeam(name: string): Promise<void> {
		const tool = this.tools.get("team_spawn");
		assert.ok(tool, "Expected team_spawn to be registered.");
		await tool.execute(
			"test-call",
			{ team: name, teamPrompt: "Team command test.", teammates: [] },
			new AbortController().signal,
			undefined,
			this.context,
		);
	}

	async openTeam(driver: OverlayDriver): Promise<void> {
		const command = this.commands.get("team");
		assert.ok(command, "Expected /team to be registered.");
		this.overlayDriver = driver;
		await command.handler("", this.context);
	}

	async openSnapshots(source: () => readonly TeamSnapshot[], driver: OverlayDriver): Promise<void> {
		this.overlayDriver = driver;
		await openTeamOverview(this.context, source);
	}

	async shutdown(): Promise<void> {
		for (const handler of this.shutdownHandlers) await handler({ reason: "quit" }, this.context);
	}
}

function close(component: Component): void {
	component.handleInput?.("\u001b");
}

function assertLargeCenteredOverlay(settings: OverlaySettings): void {
	assert.deepEqual(settings, {
		overlay: true,
		overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%" },
	});
}

function logEntry(overrides: Partial<TeamLogEntry> & Pick<TeamLogEntry, "sequence" | "kind">): TeamLogEntry {
	return {
		timestamp: "August 12, 10:00:00",
		epochMilliseconds: 1_786_531_200_000 + overrides.sequence * 1_000,
		team: "live-team-command-test",
		teammate: "reviewer",
		direction: "runtime",
		summary: `event ${overrides.sequence}`,
		...overrides,
	};
}

function liveSnapshot(log: TeamLogEntry[], statusPhrase = "Standing by"): TeamSnapshot {
	return {
		name: "live-team-command-test",
		created: "August 12, 09:59:00",
		showOnHerdrPanes: false,
		roster: ["reviewer"],
		statuses: {
			main: { word: "waiting", phrase: "Watching the team", updated: "August 12, 10:00:00" },
			reviewer: { word: "working", phrase: statusPhrase, updated: "August 12, 10:00:01" },
		},
		log,
	};
}

describe("/team", () => {
	test("shows an empty state and excludes teams owned by another session", async () => {
		const foreignHost = new TeamCommandHost();
		const host = new TeamCommandHost();
		try {
			await foreignHost.spawnEmptyTeam("foreign-team-command-test");
			await host.openTeam((component, settings) => {
				assertLargeCenteredOverlay(settings);
				const lines = component.render(90);
				assert.equal(lines.length, 36, "Expected the component to fill 90% of a 40-row terminal.");
				assert.match(lines.join("\n"), /No teams exist/);
				assert.doesNotMatch(lines.join("\n"), /foreign-team-command-test/);
				for (const line of component.render(2)) assert.ok(visibleWidth(line) <= 2);
				close(component);
			});
		} finally {
			await host.shutdown();
			await foreignHost.shutdown();
		}
	});

	test("opens the only team without a selection step", async () => {
		const host = new TeamCommandHost();
		try {
			await host.spawnEmptyTeam("single-team-command-test");
			await host.openTeam((component, settings) => {
				assertLargeCenteredOverlay(settings);
				const text = component.render(90).join("\n");
				assert.match(text, /Team: single-team-command-test/);
				assert.match(text, /Team Status single-team-command-test/);
				assert.doesNotMatch(text, /Select a team/);
				close(component);
			});
		} finally {
			await host.shutdown();
		}
	});

	test("selects a team before opening its overview when several teams exist", async () => {
		const host = new TeamCommandHost();
		try {
			await host.spawnEmptyTeam("first-team-command-test");
			await host.spawnEmptyTeam("second-team-command-test");
			await host.openTeam((component, settings) => {
				assertLargeCenteredOverlay(settings);
				const selectionText = component.render(90).join("\n");
				assert.match(selectionText, /Select a team/);
				assert.match(selectionText, /first-team-command-test/);
				assert.match(selectionText, /second-team-command-test/);

				component.handleInput?.("\u001b[B");
				component.handleInput?.("\r");
				const overviewText = component.render(90).join("\n");
				assert.match(overviewText, /Team: second-team-command-test/);
				assert.doesNotMatch(overviewText, /Select a team/);
				close(component);
			});
		} finally {
			await host.shutdown();
		}
	});

	test("wraps the team dashboard in an external border", async () => {
		const host = new TeamCommandHost();
		try {
			await host.openSnapshots(() => [liveSnapshot([])], (component) => {
				const lines = component.render(90);
				assert.equal(lines.length, 36);
				for (const line of lines) assert.equal(visibleWidth(line), 90);
				assert.match(lines[0]!, /^╭─+╮$/);
				assert.match(lines[1]!, /^│╭─ Team: live-team-command-test/);
				assert.match(lines[2]!, /^││/);
				assert.match(lines.at(-1)!, /^╰─+╯$/);
				close(component);
			});
		} finally {
			await host.shutdown();
		}
	});

	test("keeps fixed bordered regions and bounds statuses by latest update", async () => {
		const host = new TeamCommandHost();
		const names = ["main", ...Array.from({ length: 7 }, (_, index) => `teammate-${index + 1}`)];
		const statuses: TeamSnapshot["statuses"] = Object.fromEntries(
			names.map((name, index) => [name, { word: "idle", phrase: `status ${name}`, updated: `August 12, 10:00:0${index + 1}` }]),
		);
		const snapshot: TeamSnapshot = {
			...liveSnapshot([]),
			roster: names.slice(1),
			statuses,
		};

		try {
			await host.openSnapshots(() => [snapshot], (component) => {
				const lines = component.render(90);
				assert.equal(lines.length, 36);
				for (const line of lines) assert.equal(visibleWidth(line), 90);
				assert.match(lines[1]!, /Team: live-team-command-test/);
				assert.match(lines[4]!, /Status/);
				assert.match(lines[11]!, /Messages/);
				assert.ok(lines.some((line) => line.includes("Team Log")));

				const statusRows = lines.slice(5, 10).join("\n");
				assert.match(statusRows, /teammate-7[\s\S]*teammate-6[\s\S]*teammate-5[\s\S]*teammate-4[\s\S]*teammate-3/);
				assert.doesNotMatch(statusRows, /teammate-[12]/);
				assert.doesNotMatch(statusRows, /\bmain\b/);
				close(component);
			});
		} finally {
			await host.shutdown();
		}
	});

	test("aligns status columns and right-aligns updated timestamps", async () => {
		const host = new TeamCommandHost();
		const snapshot = liveSnapshot([]);
		snapshot.statuses = {
			main: { word: "waiting", phrase: "STATUS-BEGIN-" + "x".repeat(120) + "-STATUS-END", updated: "August 12, 10:00:00" },
			reviewer: { word: "working", phrase: "Short phrase", updated: "August 12, 10:00:01" },
		};

		try {
			await host.openSnapshots(() => [snapshot], (component) => {
				const rows = component.render(100).slice(5, 7);
				const mainRow = rows.find((row) => row.includes("main"));
				const reviewerRow = rows.find((row) => row.includes("reviewer"));
				assert.ok(mainRow);
				assert.ok(reviewerRow);
				assert.equal(mainRow.indexOf("main"), reviewerRow.indexOf("reviewer"));
				assert.equal(mainRow.indexOf("waiting"), reviewerRow.indexOf("working"));
				assert.equal(mainRow.indexOf("STATUS-BEGIN"), reviewerRow.indexOf("Short phrase"));
				assert.equal(mainRow.indexOf("August"), reviewerRow.indexOf("August"));
				assert.ok(mainRow.endsWith("August 12, 10:00:00││"));
				assert.ok(reviewerRow.endsWith("August 12, 10:00:01││"));
				assert.match(mainRow, /STATUS-BEGIN.*….*STATUS-END/);
				close(component);
			});
		} finally {
			await host.shutdown();
		}
	});

	test("middle-truncates status, message, and team-log rows", async () => {
		const host = new TeamCommandHost();
		const middle = "x".repeat(140);
		const log = [
			logEntry({
				sequence: 1,
				kind: "send",
				direction: "main->teammate",
				summary: "message",
				details: { from: "main", to: "reviewer", message: `MESSAGE-BEGIN-${middle}-MESSAGE-END` },
			}),
			logEntry({ sequence: 2, kind: "error", teammate: "main", summary: `LOG-BEGIN-${middle}-LOG-END` }),
		];
		const snapshot = liveSnapshot(log, `STATUS-BEGIN-${middle}-STATUS-END`);

		try {
			await host.openSnapshots(() => [snapshot], (component) => {
				const lines = component.render(100);
				const statusLine = lines.find((line) => line.includes("STATUS-BEGIN"));
				const messageLine = lines.find((line) => line.includes("MESSAGE-BEGIN"));
				const logLine = lines.find((line) => line.includes("LOG-BEGIN"));
				for (const line of [statusLine, messageLine, logLine]) {
					assert.ok(line);
					assert.match(line, /…/);
				}
				assert.match(statusLine, /STATUS-END/);
				assert.match(messageLine, /MESSAGE-END/);
				assert.match(logLine, /LOG-END/);
				close(component);
			});
		} finally {
			await host.shutdown();
		}
	});

	test("reads fresh team data on every live render", async () => {
		const host = new TeamCommandHost();
		let snapshot = liveSnapshot([]);
		try {
			await host.openSnapshots(() => [snapshot], (component) => {
				assert.doesNotMatch(component.render(90).join("\n"), /Finished live update/);
				snapshot = liveSnapshot([
					logEntry({ sequence: 1, kind: "status", summary: "done Finished live update", details: { word: "done", phrase: "Finished live update" } }),
				], "Finished live update");
				assert.match(component.render(90).join("\n"), /Finished live update/);
				close(component);
			});
		} finally {
			await host.shutdown();
		}
	});

	test("shows the newest fitting messages and logs chronologically without scrolling", async () => {
		const host = new TeamCommandHost(24);
		const messages = Array.from({ length: 6 }, (_, index) =>
			logEntry({
				sequence: index + 1,
				kind: "send",
				direction: "main->teammate",
				summary: `message ${index + 1}`,
				details: { from: "main", to: "reviewer", message: `message ${index + 1}` },
			}),
		);
		const logs = Array.from({ length: 8 }, (_, index) =>
			logEntry({ sequence: index + 7, kind: "error", teammate: "reviewer", summary: `log ${index + 1}` }),
		);
		let snapshot = liveSnapshot([]);

		try {
			await host.openSnapshots(() => [snapshot], (component) => {
				const emptyLines = component.render(90);
				snapshot = liveSnapshot([...messages, ...logs]);
				const populatedLines = component.render(90);
				const borderIndexes = (lines: string[]) => lines.flatMap((line, index) => (/Messages|Team Log/.test(line) ? [index] : []));
				assert.deepEqual(borderIndexes(populatedLines), borderIndexes(emptyLines));

				const text = populatedLines.join("\n");
				assert.doesNotMatch(text, /message [1-4]/);
				assert.match(text, /message 5[\s\S]*message 6/);
				assert.doesNotMatch(text, /log [1-5]/);
				assert.match(text, /log 6[\s\S]*log 7[\s\S]*log 8/);
				component.handleInput?.("\u001b[B");
				component.handleInput?.("\u001b[6~");
				assert.deepEqual(component.render(90), populatedLines);
				close(component);
			});
		} finally {
			await host.shutdown();
		}
	});
});

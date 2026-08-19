import { describe, expect, test } from "bun:test";
import { Container, type TUI } from "@earendil-works/pi-tui";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";

import { stableRenderWidth, stripAnsi, visibleLength } from "../render-support/ansi.ts";
import { glyphs } from "../render-support/glyphs.ts";
import {
	TeamLines,
	actorHueToken,
	allTeamsStatusLines,
	formatCharCount,
	renderTeamMessage,
	renderTeamToolCall,
	renderTeamToolResult,
	statusWordToken,
	teamAddLines,
	teamListLines,
	teamLogLines,
	teamMessageLines,
	teamResumeLines,
	teamSendLines,
	teamShutdownLines,
	teamLineText,
	teamSpawnLines,
	teamStatusLines,
	type ThemeLike,
} from "../render.ts";
import { monthDay, timeOfDay, type TeamLogEntry } from "../teamlog.ts";

initTheme("dark");

const identityTheme: ThemeLike = {
	bold: (text: string) => text,
	fg: (_token: string, text: string) => text,
};

const taggingTheme: ThemeLike = {
	bold: (text: string) => text,
	fg: (token: string, text: string) => `«${token}:${text}»`,
};

const g = glyphs();

const markdownThemeKeys = ["heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet", "bold", "italic", "strikethrough", "underline"] as const;
const identityMarkdownTheme = Object.fromEntries(markdownThemeKeys.map((key) => [key, (text: string) => text])) as MarkdownTheme;

function logEntry(overrides: Partial<TeamLogEntry>): TeamLogEntry {
	return {
		sequence: 1,
		timestamp: "July 16, 22:48:52",
		epochMilliseconds: 1_784_000_000_000,
		team: "demo-team",
		teammate: "reviewer",
		kind: "status",
		summary: "working Writing findings",
		...overrides,
	};
}

describe("formatCharCount", () => {
	test("formats small, thousands, and ten-thousands counts", () => {
		expect(formatCharCount(4)).toBe("4 chars");
		expect(formatCharCount(4463)).toBe("4.5k chars");
		expect(formatCharCount(45210)).toBe("45k chars");
	});
});

describe("statusWordToken", () => {
	test("maps known status words to semantic tokens", () => {
		expect(statusWordToken("working")).toBe("success");
		expect(statusWordToken("Waiting")).toBe("warning");
		expect(statusWordToken("stopped")).toBe("dim");
		expect(statusWordToken("error")).toBe("error");
	});

	test("gives free-form activity words the accent token", () => {
		expect(statusWordToken("reviewing")).toBe("accent");
	});
});

describe("teamStatusLines", () => {
	const statuses = {
		implementer: { word: "working", phrase: "Running gates", updated: "July 16, 23:01:01" },
		main: { word: "waiting", phrase: "wake me up when done", updated: "July 16, 22:53:47" },
		reviewer: { word: "waiting", phrase: "Standing by", updated: "July 16, 23:01:10" },
	};

	test("renders a stat-line header and one tree row per member", () => {
		const lines = teamStatusLines(identityTheme, "demo-team", statuses).map(teamLineText);
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("Team Status demo-team");
		expect(lines[0]).toContain("3 members");
		expect(lines[0]).toContain("1 working");
		expect(lines[1]).toContain(g.tree.mid.trim());
		expect(lines[3]).toContain(g.tree.last.trim());
	});

	test("aligns the status word column across rows", () => {
		const lines = teamStatusLines(identityTheme, "demo-team", statuses).map(teamLineText);
		const wordColumns = [lines[1]!.indexOf("working"), lines[2]!.indexOf("waiting"), lines[3]!.indexOf("waiting")];
		expect(new Set(wordColumns).size).toBe(1);
	});

	test("colors each status word by its semantic token", () => {
		const lines = teamStatusLines(taggingTheme, "demo-team", statuses).map(teamLineText);
		expect(lines[1]).toContain("«success:working");
		expect(lines[2]).toContain("«warning:waiting");
	});

	test("uses the Team Log actor colors for member names", () => {
		const lines = teamStatusLines(taggingTheme, "demo-team", statuses, ["implementer", "reviewer"]).map(teamLineText);
		expect(lines[1]).toContain("«mdCode:implementer");
		expect(lines[2]).toContain("«accent:main");
		expect(lines[3]).toContain("«customMessageLabel:reviewer");
	});

	test("renders ISO updated timestamps as relative time and passes legacy strings through", () => {
		const lines = teamStatusLines(identityTheme, "demo-team", {
			implementer: { word: "working", phrase: "Running gates", updated: new Date(Date.now() - 12.5 * 60_000).toISOString() },
			main: { word: "waiting", phrase: "Standing by", updated: "July 16, 22:53:47" },
		}).map(teamLineText);
		expect(lines[1]).toEndWith("12m ago");
		expect(lines[2]).toEndWith("July 16, 22:53:47");
	});
});

describe("allTeamsStatusLines", () => {
	test("groups member rows under accent team rows", () => {
		const lines = allTeamsStatusLines(identityTheme, {
			alpha: { main: { word: "waiting", phrase: "", updated: "July 16, 22:00:00" } },
			beta: { main: { word: "working", phrase: "on it", updated: "July 16, 22:00:01" } },
		}).map(teamLineText);
		expect(lines[0]).toContain("2 teams");
		expect(lines[1]).toContain("alpha");
		expect(lines[2]).toContain("waiting");
		expect(lines[3]).toContain("beta");
		expect(lines[4]).toContain("working");
	});

	test("keeps member colors across teams", () => {
		const lines = allTeamsStatusLines(
			taggingTheme,
			{
				alpha: { scout: { word: "working", phrase: "", updated: "July 16, 22:00:00" } },
				beta: { reviewer: { word: "waiting", phrase: "", updated: "July 16, 22:00:01" } },
			},
			["scout", "reviewer"],
		).map(teamLineText);
		expect(lines.join("\n")).toContain("«mdCode:scout");
		expect(lines.join("\n")).toContain("«customMessageLabel:reviewer");
	});
});

describe("teamSpawnLines", () => {
	test("lists each teammate with model and thinking level", () => {
		const lines = teamSpawnLines(identityTheme, "demo-team", [
			{ name: "implementer", model: "claude-bridge/claude-opus-4-6", thinking: "xhigh" },
			{ name: "reviewer", model: "claude-bridge/claude-sonnet-5", thinking: "high" },
		]);
		expect(lines[0]).toContain("Team Spawn demo-team");
		expect(lines[0]).toContain("2 teammates");
		expect(lines[1]).toContain("claude-bridge/claude-opus-4-6");
		expect(lines[1]).toContain("xhigh");
		expect(lines[2]).toContain(g.tree.last.trim());
	});

	test("colors teammate names from the session roster", () => {
		const teammates = [
			{ name: "implementer", model: "model-a" },
			{ name: "reviewer", model: "model-b" },
		];
		const lines = teamSpawnLines(taggingTheme, "demo-team", teammates, ["implementer", "reviewer"]);
		expect(lines[1]).toContain("«mdCode:implementer");
		expect(lines[2]).toContain("«customMessageLabel:reviewer");
	});
});

describe("teamAddLines", () => {
	test("summarizes growth and lists each added teammate like Team Spawn", () => {
		const lines = teamAddLines(identityTheme, "demo-team", [
			{ name: "security-scout", model: "anthropic/claude-sonnet-5", thinking: "high" },
			{ name: "release", model: "anthropic/claude-sonnet-5" },
		], 5);
		expect(lines[0]).toContain("Team Add demo-team");
		expect(lines[0]).toContain("2 added");
		expect(lines[0]).toContain("5 members");
		expect(lines[1]).toContain("anthropic/claude-sonnet-5");
		expect(lines[1]).toContain("high");
		expect(lines[2]).toContain(g.tree.last.trim());
	});

	test("colors added teammate names from the session roster", () => {
		const lines = teamAddLines(taggingTheme, "demo-team", [{ name: "scout", model: "model-a" }], 3, ["scout"]);
		expect(lines[1]).toContain("«mdCode:scout");
	});
});

describe("teamResumeLines", () => {
	test("distinguishes restored history from empty restarts", () => {
		const lines = teamResumeLines(identityTheme, "demo-team", [
			{ name: "scout", restored: true },
			{ name: "reviewer", restored: false },
		], 3);
		expect(lines[0]).toContain("Team Resume demo-team");
		expect(lines[0]).toContain("2 of 3 resumed");
		expect(lines[1]).toContain("resumed");
		expect(lines[1]).toContain("history restored");
		expect(lines[2]).toContain("restarted");
		expect(lines[2]).toContain("empty session");
	});

	test("a full resume drops the of-count", () => {
		const lines = teamResumeLines(identityTheme, "demo-team", [{ name: "scout", restored: true }], 1);
		expect(lines[0]).toContain("1 resumed");
		expect(lines[0]).not.toContain(" of ");
	});

	test("shows a muted row when nothing was stopped", () => {
		const lines = teamResumeLines(identityTheme, "demo-team", [], 2);
		expect(lines[0]).toContain("0 of 2 resumed");
		expect(lines[1]).toContain("no stopped teammates");
	});
});

describe("teamListLines", () => {
	const MINUTE = 60_000;
	const DAY = 86_400_000;
	const teams = [
		{
			name: "shared-room",
			state: "active",
			leaseState: "claimed",
			members: [
				{ name: "scout", live: true, canOverseeOwnTeams: false },
				{ name: "reviewer", live: false, canOverseeOwnTeams: true },
			],
			updatedAt: new Date(Date.now() - 12.5 * MINUTE).toISOString(),
		},
		{
			name: "profitability-branch",
			state: "dormant",
			leaseState: "stale",
			members: [{ name: "branch-a", live: false, canOverseeOwnTeams: false }],
			updatedAt: new Date(Date.now() - 6.5 * DAY).toISOString(),
			expiresAt: new Date(Date.now() + 20.5 * DAY).toISOString(),
		},
	];

	test("renders one row per team with relative updated and future expires timestamps", () => {
		const lines = teamListLines(identityTheme, teams).map(teamLineText);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("Team List");
		expect(lines[0]).toContain("2 teams");
		expect(lines[0]).toContain("1 active");
		expect(lines[1]).toContain("shared-room");
		expect(lines[1]).toEndWith("updated 12m ago");
		expect(lines[2]).toContain(g.tree.last.trim());
		expect(lines[2]).toEndWith("expires in 2w");
	});

	test("colors the state word, flags a stale lease, and marks overseers", () => {
		const lines = teamListLines(taggingTheme, teams, ["scout", "reviewer"]).map(teamLineText);
		expect(lines[1]).toContain("«success:active");
		expect(lines[1]).toContain("«mdCode:scout»");
		expect(lines[1]).toContain("«customMessageLabel:reviewer»");
		expect(lines[1]).toContain(`«dim:${g.diamond}»`);
		expect(lines[2]).toContain("«muted:dormant");
		expect(lines[2]).toContain("«error:stale lease»");
	});

	test("dims stopped members only in active teams", () => {
		const lines = teamListLines(identityTheme, teams).map(teamLineText);
		expect(lines[1]).toContain("\u001b[2mreviewer\u001b[22m");
		expect(lines[2]).not.toContain("\u001b[2m");
	});

	test("shows an empty state when no teams exist", () => {
		const lines = teamListLines(identityTheme, []).map(teamLineText);
		expect(lines[0]).toContain("0 teams");
		expect(lines[0]).not.toContain("active");
		expect(lines[1]).toContain("no teams");
	});
});

describe("teamSendLines", () => {
	const message = ["## Review", "Line two", "Line three", "Line four", "Line five"].join("\n");

	test("renders arrow, recipients, and size in the header", () => {
		const lines = teamSendLines(identityTheme, { to: ["implementer", "reviewer"], message, interrupt: false, expanded: false }).map(teamLineText);
		expect(lines[0]).toContain(`${g.arrow} implementer, reviewer`);
		expect(lines[0]).toContain(`${message.length} chars`);
		expect(lines[0]).not.toContain("interrupt");
	});

	test("shows the interrupt stat only when set", () => {
		const lines = teamSendLines(identityTheme, { to: ["reviewer"], message, interrupt: true, expanded: false }).map(teamLineText);
		expect(lines[0]).toContain("interrupt");
	});

	test("colors each recipient from the session roster", () => {
		const lines = teamSendLines(
			taggingTheme,
			{ to: ["implementer", "reviewer"], message, interrupt: false, expanded: false },
			["implementer", "reviewer"],
		).map(teamLineText);
		expect(lines[0]).toContain("«mdCode:implementer»");
		expect(lines[0]).toContain("«customMessageLabel:reviewer»");
	});

	test("collapsed body shows a quote-barred preview with an expand hint", () => {
		const lines = teamSendLines(identityTheme, { to: ["reviewer"], message, interrupt: false, expanded: false }).map(teamLineText);
		expect(lines).toHaveLength(5);
		expect(lines[1]).toContain(g.codeBar);
		expect(lines[1]).toContain("## Review");
		expect(lines[4]).toContain("2 more lines");
		expect(lines[4]).toContain("ctrl+o to expand");
	});

	test("expanded body shows every line without a hint", () => {
		const lines = teamSendLines(identityTheme, { to: ["reviewer"], message, interrupt: false, expanded: true }).map(teamLineText);
		expect(lines).toHaveLength(6);
		expect(lines[5]).toContain("Line five");
	});
});

describe("teamShutdownLines", () => {
	test("summarizes the stop and lists teammate names", () => {
		const lines = teamShutdownLines(identityTheme, "demo-team", ["implementer", "reviewer"]);
		expect(lines[0]).toContain("Team Shutdown demo-team");
		expect(lines[0]).toContain("2 teammates stopped");
		expect(lines[1]).toContain("implementer");
		expect(lines[1]).toContain("reviewer");
	});

	test("colors stopped teammate names from the session roster", () => {
		const lines = teamShutdownLines(taggingTheme, "demo-team", ["implementer", "reviewer"], ["implementer", "reviewer"]);
		expect(lines[1]).toContain("«mdCode:implementer»");
		expect(lines[1]).toContain("«customMessageLabel:reviewer»");
	});
});

describe("actorHueToken", () => {
	test("main is accent; teammates cycle hue tokens by roster order", () => {
		expect(actorHueToken("main", ["a", "b"])).toBe("accent");
		expect(actorHueToken("a", ["a", "b", "c", "d"])).toBe("mdCode");
		expect(actorHueToken("b", ["a", "b", "c", "d"])).toBe("customMessageLabel");
		expect(actorHueToken("c", ["a", "b", "c", "d"])).toBe("mdHeading");
		expect(actorHueToken("d", ["a", "b", "c", "d"])).toBe("mdCode");
	});

	test("actors outside the roster fall back to plain text", () => {
		expect(actorHueToken("ghost", ["a"])).toBe("text");
	});
});

describe("teamLogLines", () => {
	const T = 1_784_000_000_000;

	function logView(entries: TeamLogEntry[], overrides: Record<string, unknown> = {}) {
		return {
			team: "demo-team",
			roster: ["implementer", "reviewer"],
			entries,
			totalMatched: entries.length,
			returned: entries.length,
			nowMilliseconds: T,
			...overrides,
		};
	}

	function toolPair(isError: boolean, resultText: string): TeamLogEntry[] {
		return [
			logEntry({ sequence: 10, kind: "tool_start", teammate: "implementer", epochMilliseconds: T, details: { toolCallId: "c1", toolName: "bash", args: { command: "ls -la" } } }),
			logEntry({
				sequence: 11,
				kind: "tool_end",
				teammate: "implementer",
				epochMilliseconds: T + 1000,
				details: { toolCallId: "c1", toolName: "bash", isError, result: { content: [{ type: "text", text: resultText }] } },
			}),
		];
	}

	test("folds a tool pair into one action row with duration and salient arg", () => {
		const lines = teamLogLines(identityTheme, logView(toolPair(false, "total 0")));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("1 action");
		expect(lines[0]).toContain("2 events");
		expect(lines[1]).toContain("#10");
		expect(lines[1]).toContain("bash");
		expect(lines[1]).toContain("1s");
		expect(lines[1]).toContain("ls -la");
		expect(lines[1]).not.toContain("total 0");
	});

	test("a successful tool colors the chevron with the success token", () => {
		const lines = teamLogLines(taggingTheme, logView(toolPair(false, "total 0")));
		expect(lines[1]).toContain(`«success:${g.chevron}`);
	});

	test("a failed tool colors the chevron red and leads details with the exit code", () => {
		const lines = teamLogLines(taggingTheme, logView(toolPair(true, "boom\nExit code: 1")));
		expect(lines[1]).toContain(`«error:${g.chevron}`);
		expect(lines[1]).toContain("«error:1»");
		expect(lines[1]).toContain("1s");
		expect(lines[1]).toContain("ls -la");
	});

	test("a failure without an exit code falls back to the first result line", () => {
		const lines = teamLogLines(taggingTheme, logView(toolPair(true, "command not found\nmore context")));
		expect(lines[1]).toContain("«error:command not found»");
	});

	test("an unfinished tool stays neutral with an ellipsis in the duration slot", () => {
		const entries = [logEntry({ sequence: 10, kind: "tool_start", teammate: "implementer", epochMilliseconds: T, details: { toolCallId: "c1", toolName: "bash", args: { command: "sleep 60" } } })];
		const lines = teamLogLines(taggingTheme, logView(entries));
		expect(lines[1]).toContain(`«borderMuted:${g.chevron}`);
		expect(lines[1]).toContain(g.ellipsis);
	});

	test("groups consecutive send frames by sender and message into one message row", () => {
		const entries = [
			logEntry({ sequence: 20, kind: "send", teammate: "implementer", summary: "please review", details: { from: "main", to: "implementer" } }),
			logEntry({ sequence: 21, kind: "send", teammate: "reviewer", summary: "please review", details: { from: "main", to: "reviewer" } }),
		];
		const lines = teamLogLines(identityTheme, logView(entries));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("1 action");
		expect(lines[0]).toContain("2 events");
		expect(lines[1]).toContain("main");
		expect(lines[1]).toContain("message");
		expect(lines[1]).toContain("implementer, reviewer");
		expect(lines[1]).toContain("please review");
	});

	test("recipients keep their owner's hue inside details", () => {
		const entries = [
			logEntry({ sequence: 20, kind: "send", teammate: "implementer", summary: "please review", details: { from: "main", to: "implementer" } }),
			logEntry({ sequence: 21, kind: "send", teammate: "reviewer", summary: "please review", details: { from: "main", to: "reviewer" } }),
		];
		const lines = teamLogLines(taggingTheme, logView(entries));
		expect(lines[1]).toContain("«accent:main");
		expect(lines[1]).toContain("«mdCode:implementer»");
		expect(lines[1]).toContain("«customMessageLabel:reviewer»");
	});

	test("deliver and ack frames never render in the collapsed view", () => {
		const entries = [
			logEntry({ sequence: 20, kind: "send", teammate: "reviewer", summary: "go", details: { from: "main", to: "reviewer" } }),
			logEntry({ sequence: 21, kind: "deliver", teammate: "reviewer", summary: "go", details: { from: "main", to: "reviewer" } }),
			logEntry({ sequence: 22, kind: "ack", teammate: "reviewer", summary: "prompt accepted" }),
		];
		const lines = teamLogLines(identityTheme, logView(entries));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("1 action");
		expect(lines[0]).toContain("3 events");
		expect(lines[1]).not.toContain("deliver");
		expect(lines[1]).not.toContain("prompt accepted");
	});

	test("interrupt sends carry a warning chip", () => {
		const entries = [logEntry({ sequence: 20, kind: "send", teammate: "reviewer", summary: "stop", details: { from: "main", to: "reviewer", interrupt: true } })];
		const lines = teamLogLines(taggingTheme, logView(entries));
		expect(lines[1]).toContain("«warning:interrupt»");
	});

	test("a teammain report renders as a message to main", () => {
		const entries = [logEntry({ sequence: 30, kind: "main_message", teammate: "implementer", summary: "all gates green" })];
		const lines = teamLogLines(taggingTheme, logView(entries));
		expect(lines[1]).toContain("message");
		expect(lines[1]).toContain("«accent:main»");
		expect(lines[1]).toContain("all gates green");
	});

	test("status rows quote word and phrase from details", () => {
		const entries = [logEntry({ sequence: 40, kind: "status", teammate: "reviewer", details: { word: "reporting", phrase: "Writing findings" } })];
		const lines = teamLogLines(identityTheme, logView(entries));
		expect(lines[1]).toContain("status");
		expect(lines[1]).toContain("reporting");
		expect(lines[1]).toContain("Writing findings");
	});

	test("a turn opens with an ellipsis and closes in place with duration and message count", () => {
		const openOnly = teamLogLines(identityTheme, logView([logEntry({ sequence: 50, kind: "agent_start", teammate: "reviewer", epochMilliseconds: T })]));
		expect(openOnly[1]).toContain("turn");
		expect(openOnly[1]).toContain(g.ellipsis);

		const closed = teamLogLines(
			identityTheme,
			logView([
				logEntry({ sequence: 50, kind: "agent_start", teammate: "reviewer", epochMilliseconds: T }),
				logEntry({ sequence: 58, kind: "agent_end", teammate: "reviewer", epochMilliseconds: T + 41_000, details: { messageCount: 14 } }),
			]),
		);
		expect(closed).toHaveLength(2);
		expect(closed[1]).toContain("41s");
		expect(closed[1]).toContain("14 messages");
		expect(closed[1]).not.toContain(g.ellipsis);
	});

	test("spawn rows carry model and thinking from details", () => {
		const entries = [logEntry({ sequence: 1, kind: "spawn", teammate: "reviewer", details: { model: "claude-bridge/claude-fable-5", thinking: "xhigh" } })];
		const lines = teamLogLines(identityTheme, logView(entries));
		expect(lines[1]).toContain("spawn");
		expect(lines[1]).toContain("claude-bridge/claude-fable-5");
		expect(lines[1]).toContain("xhigh");
	});

	test("a repeated actor dims", () => {
		const entries = [
			logEntry({ sequence: 60, kind: "status", teammate: "reviewer", details: { word: "working", phrase: "a" } }),
			logEntry({ sequence: 61, kind: "status", teammate: "reviewer", details: { word: "working", phrase: "b" } }),
		];
		const lines = teamLogLines(identityTheme, logView(entries));
		expect(lines[1]).not.toContain("\x1b[2m");
		expect(lines[2]).toContain("\x1b[2m");
	});

	test("header shows action and event counts, humanizes since, and keeps the cursor footer", () => {
		const since = new Date(T).toISOString();
		const entries = [logEntry({ sequence: 70, kind: "status", teammate: "reviewer", details: { word: "working", phrase: "" } })];
		const lines = teamLogLines(identityTheme, logView(entries, { totalMatched: 7, nextCursor: "before:70", filters: { kind: ["status", "error"], since } }));
		expect(lines[0]).toContain("Team Log demo-team");
		expect(lines[0]).toContain("1 action");
		expect(lines[0]).toContain("1 of 7 events");
		expect(lines[0]).toContain("kind=status,error");
		expect(lines[0]).toContain(`since ${timeOfDay(T)}`);
		expect(lines.at(-1)).toContain('cursor "before:70"');
	});

	test("colors a teammate filter from the session roster", () => {
		const entries = [logEntry({ teammate: "reviewer" })];
		const lines = teamLogLines(taggingTheme, logView(entries, { filters: { teammate: "reviewer" } }));
		expect(lines[0]).toContain("«borderMuted:teammate=»«customMessageLabel:reviewer»");
	});

	test("renders an empty state row when nothing matched", () => {
		const lines = teamLogLines(identityTheme, { team: "demo-team", entries: [], totalMatched: 0, returned: 0 });
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("no matching events");
	});

	test("log rows carry no tree connectors", () => {
		const lines = teamLogLines(identityTheme, logView(toolPair(false, "total 0")));
		expect(lines[1]).not.toContain(g.tree.mid.trim());
		expect(lines[1]).not.toContain(g.tree.last.trim());
		expect(lines[1]).toStartWith("  #10");
	});

	test("opens with a day divider when the first entry is not from today", () => {
		const DAY = 86_400_000;
		const entries = [logEntry({ sequence: 10, kind: "status", teammate: "reviewer", epochMilliseconds: T - DAY, details: { word: "working", phrase: "" } })];
		const lines = teamLogLines(identityTheme, logView(entries));
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain(monthDay(T - DAY));
		expect(lines[2]).toContain("#10");
	});

	test("inserts a day divider between rows when the local day changes", () => {
		const DAY = 86_400_000;
		const entries = [
			logEntry({ sequence: 10, kind: "status", teammate: "reviewer", epochMilliseconds: T - 2 * DAY, details: { word: "working", phrase: "" } }),
			logEntry({ sequence: 11, kind: "status", teammate: "reviewer", epochMilliseconds: T, details: { word: "done", phrase: "" } }),
		];
		const lines = teamLogLines(identityTheme, logView(entries));
		expect(lines).toHaveLength(5);
		expect(lines[1]).toContain(monthDay(T - 2 * DAY));
		expect(lines[2]).toContain("#10");
		expect(lines[3]).toContain(monthDay(T));
		expect(lines[4]).toContain("#11");
	});

	test("a same-day log renders no day divider", () => {
		const lines = teamLogLines(identityTheme, logView(toolPair(false, "total 0")));
		expect(lines).toHaveLength(2);
		expect(lines.join("\n")).not.toContain(monthDay(T));
	});
});

describe("teamMessageLines", () => {
	test("renders a speech header and quote-barred full body", () => {
		const lines = teamMessageLines(identityTheme, {
			team: "demo-team",
			from: "reviewer",
			sentAt: "July 16, 22:49:46",
			message: "Checkpoint verified.\n\nWaiting for the final gate.",
		}).map(teamLineText);
		expect(lines[0]).toContain(g.diamond);
		expect(lines[0]).toContain(`reviewer ${g.arrow} main`);
		expect(lines[0]).toContain("demo-team");
		expect(lines[0]).toContain("July 16, 22:49:46");
		expect(lines).toHaveLength(4);
		expect(lines[1]).toContain(g.codeBar);
		expect(lines[1]).toContain("Checkpoint verified.");
		expect(lines[3]).toContain("Waiting for the final gate.");
	});

	test("renders an ISO sentAt as relative time", () => {
		const lines = teamMessageLines(identityTheme, {
			team: "demo-team",
			from: "reviewer",
			sentAt: new Date(Date.now() - 5.5 * 60_000).toISOString(),
			message: "hi",
		}).map(teamLineText);
		expect(lines[0]).toContain("5m ago");
	});
});

describe("renderTeamMessage", () => {
	test("returns undefined without well-formed details so the default renderer takes over", () => {
		expect(renderTeamMessage({ details: undefined }, identityTheme)).toBeUndefined();
		expect(renderTeamMessage({ details: { team: "demo" } }, identityTheme)).toBeUndefined();
	});

	test("returns a component for well-formed details", () => {
		const component = renderTeamMessage({ details: { team: "demo", from: "reviewer", sentAt: "July 16, 22:49:46", message: "hi" } }, identityTheme);
		expect(component?.render(80)[0]).toContain("reviewer");
	});

	test("colors the sender from the session roster", () => {
		const component = renderTeamMessage(
			{ details: { team: "demo", from: "reviewer", sentAt: "July 16, 22:49:46", message: "hi" } },
			taggingTheme,
			identityMarkdownTheme,
			["implementer", "reviewer"],
		);
		expect(component?.render(80)[0]).toContain("«customMessageLabel:reviewer»");
	});
});

describe("renderTeamToolResult", () => {
	test("renders the call header with the error in red on failure", () => {
		const component = renderTeamToolResult(
			"teamsend",
			{ isError: true, content: [{ type: "text", text: "Unknown teammate(s) in demo-team: main" }] } as never,
			{ expanded: false },
			taggingTheme,
			{ args: { to: ["main"], message: "hi" }, isError: true },
		);
		const line = component.render(400)[0]!;
		expect(line).toContain("Team Send");
		expect(line).toContain("«error:Unknown teammate(s) in demo-team: main»");
	});

	test("colors Team Send recipients when rendering a Markdown body", () => {
		const component = renderTeamToolResult(
			"teamsend",
			{ details: { to: ["implementer", "reviewer"], interrupt: false } },
			{ expanded: false },
			taggingTheme,
			{ args: { message: "Please review." } },
			identityMarkdownTheme,
			["implementer", "reviewer"],
		);
		const header = component.render(200)[0];
		expect(header).toContain("«mdCode:implementer»");
		expect(header).toContain("«customMessageLabel:reviewer»");
	});

	test("right-aligns Team Status timestamps and truncates phrases to the remaining width", () => {
		const width = 80;
		const component = renderTeamToolResult(
			"teamstatus",
			{
				details: {
					team: "demo-team",
					status: {
						afterword: {
							word: "completed",
							phrase: "Translated and verified the afterword; no non-English prose remains",
							updated: "August 04, 21:31:00",
						},
						readme: { word: "completed", phrase: "Verified README", updated: "August 04, 21:31:33" },
					},
				},
			},
			{ expanded: false },
			identityTheme,
			{},
		);
		const rows = component.render(width).slice(1);
		const plainRows = rows.map(stripAnsi);

		expect(rows).toHaveLength(2);
		for (const row of rows) expect(visibleLength(row)).toBe(stableRenderWidth(width));
		expect(plainRows[0]).toEndWith("August 04, 21:31:00");
		expect(plainRows[1]).toEndWith("August 04, 21:31:33");
		for (const row of plainRows) expect(row).not.toContain(" · August");
		expect(plainRows[0]!.indexOf("August")).toBe(plainRows[1]!.indexOf("August"));
		expect(plainRows[0]).toContain(g.ellipsis);
		expect(plainRows[0]).not.toContain("no non-English prose remains");
	});

	test("translates Team Resume result details into restored and restarted rows", () => {
		const component = renderTeamToolResult(
			"team_resume",
			{
				details: {
					team: "demo-team",
					teammates: ["scout", "reviewer", "release"],
					resumed: ["scout", "reviewer"],
					restartedEmpty: ["reviewer"],
				},
			},
			{ expanded: false },
			taggingTheme,
			{ args: { team: "session-id-demo-team" } },
			undefined,
			["scout", "reviewer"],
		);
		const lines = component.render(200);
		expect(lines[0]).toContain("2 of 3 resumed");
		expect(lines[1]).toContain("«mdCode:scout");
		expect(lines[1]).toContain("«success:resumed");
		expect(lines[1]).toContain("history restored");
		expect(lines[2]).toContain("«customMessageLabel:reviewer»");
		expect(lines[2]).toContain("«warning:restarted");
		expect(lines[2]).toContain("empty session");
	});

	test("keeps a teammate color consistent across Team Status and Team Log", () => {
		const roster = ["implementer", "reviewer"];
		const status = renderTeamToolResult(
			"teamstatus",
			{ details: { team: "demo-team", status: { reviewer: { word: "working", phrase: "Reviewing", updated: "July 16, 23:01:10" } } } },
			{ expanded: false },
			taggingTheme,
			{},
			undefined,
			roster,
		);
		const log = renderTeamToolResult(
			"teamlog",
			{
				details: {
					team: "demo-team",
					roster: ["reviewer", "implementer"],
					entries: [logEntry({ teammate: "reviewer" })],
					totalMatched: 1,
					returned: 1,
				},
			},
			{ expanded: false },
			taggingTheme,
			{},
			undefined,
			roster,
		);
		expect(status.render(200).join("\n")).toContain("«customMessageLabel:reviewer»");
		expect(log.render(200).join("\n")).toContain("«customMessageLabel:reviewer»");
	});
});

describe("renderTeamToolCall", () => {
	test("renders multiple Team Log kinds as one OR filter", () => {
		const component = renderTeamToolCall(
			"teamlog",
			{ team: "demo-team", kind: ["status", "error"] },
			taggingTheme,
			{ executionStarted: true, isPartial: true },
		);
		expect(component.render(200)[0]).toContain("«dim:kind=status,error»");
	});

	test("colors a Team Log teammate filter from the session roster", () => {
		const component = renderTeamToolCall(
			"teamlog",
			{ team: "demo-team", teammate: "reviewer" },
			taggingTheme,
			{ executionStarted: true, isPartial: true },
			["implementer", "reviewer"],
		);
		expect(component.render(200)[0]).toContain("«dim:teammate=»«customMessageLabel:reviewer»");
	});
});

describe("TeamLines", () => {
	test("clips each logical line to the render width when collapsed", () => {
		const component = new TeamLines(["x".repeat(120)], "clip");
		const rendered = component.render(40);
		expect(rendered).toHaveLength(1);
		expect(stripAnsi(rendered[0]!).length).toBeLessThanOrEqual(40);
		expect(rendered[0]).toContain(g.ellipsis);
	});

	test("wraps logical lines when expanded", () => {
		const component = new TeamLines(["word ".repeat(30).trim()], "wrap");
		expect(component.render(40).length).toBeGreaterThan(1);
	});

	test("re-applies the quote-bar prefix to wrapped continuation lines", () => {
		const component = new TeamLines([{ prefix: `  ${g.codeBar} `, text: "word ".repeat(30).trim() }], "wrap");
		const rendered = component.render(40);
		expect(rendered.length).toBeGreaterThan(1);
		for (const line of rendered) expect(line).toStartWith(`  ${g.codeBar} `);
	});
});

describe("markdown views in a narrow terminal", () => {
	const NARROW = 54;
	const VERY_NARROW = 9;

	function assertLinesFit(lines: string[], width: number): void {
		for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(width);
	}

	test("a teammate message header is clipped instead of overflowing", () => {
		const component = renderTeamMessage(
			{ details: { team: "narrow-terminal-repro", from: "navigator", sentAt: "July 31, 01:39:01", message: "Working directory report." } },
			identityTheme,
			identityMarkdownTheme,
		)!;
		const rendered = component.render(NARROW);
		expect(visibleLength(rendered[0]!)).toBeGreaterThan(NARROW - 5);
		for (const line of rendered) expect(visibleLength(line)).toBeLessThanOrEqual(NARROW);
	});

	test("a team send header is clipped instead of overflowing", () => {
		const component = renderTeamToolResult(
			"teamsend",
			{ details: { to: ["surveyor", "navigator", "quartermaster"] } },
			{ expanded: false },
			identityTheme,
			{ args: { message: "x".repeat(1200) } },
			identityMarkdownTheme,
		);
		for (const line of component.render(NARROW)) expect(visibleLength(line)).toBeLessThanOrEqual(NARROW);
	});

	test("team spawn call and result fit a nine-column render width", () => {
		const args = { team: "visible-team", teammates: [{ name: "reviewer", model: "fake-model", thinking: "low" }] };
		const call = renderTeamToolCall("team_spawn", args, identityTheme, { executionStarted: true, isPartial: true });
		const result = renderTeamToolResult("team_spawn", { details: { team: "visible-team" } }, { expanded: false }, identityTheme, { args });
		assertLinesFit(call.render(VERY_NARROW), VERY_NARROW);
		assertLinesFit(result.render(VERY_NARROW), VERY_NARROW);
	});

	test("shared prefixed rows and message bodies fit a nine-column render width", () => {
		assertLinesFit(new TeamLines([{ prefix: `  ${g.codeBar} `, text: "hello" }], "wrap").render(VERY_NARROW), VERY_NARROW);
		const send = renderTeamToolResult("teamsend", { details: { to: ["reviewer"] } }, { expanded: false }, identityTheme, { args: { message: "hello" } }, identityMarkdownTheme);
		const message = renderTeamMessage({ details: { team: "team", from: "reviewer", sentAt: "12:00:00", message: "hello" } }, identityTheme, identityMarkdownTheme);
		assertLinesFit(send.render(VERY_NARROW), VERY_NARROW);
		assertLinesFit(message!.render(VERY_NARROW), VERY_NARROW);
	});

	test("keeps the composed in-progress Team Spawn row within a nine-column render width", () => {
		const toolDefinition = (name: "teamsend" | "team_spawn") => ({
			name,
			label: name,
			description: name,
			parameters: {},
			renderShell: "self" as const,
			renderCall: (args: Record<string, unknown>, theme: ThemeLike, context: { executionStarted?: boolean; isPartial?: boolean; cwd?: string }) => renderTeamToolCall(name, args, theme, context),
			renderResult: (result: { isError?: boolean; details?: unknown }, options: { expanded: boolean }, theme: ThemeLike, context: { args?: Record<string, unknown>; isError?: boolean; cwd?: string }) =>
				renderTeamToolResult(name, result, options, theme, context, name === "teamsend" ? identityMarkdownTheme : undefined),
		});
		const ui = { requestRender() {} } as unknown as TUI;
		const send = new ToolExecutionComponent(
			"teamsend",
			"send-call",
			{ message: "START_POC_20260808" },
			undefined,
			toolDefinition("teamsend") as never,
			ui,
			process.cwd(),
		);
		send.markExecutionStarted();
		send.updateResult({ content: [{ type: "text", text: "accepted" }], details: { to: ["alpha"] }, isError: false });

		const spawn = new ToolExecutionComponent(
			"team_spawn",
			"spawn-call",
			{ team: "visible-team", teammates: [{ name: "alpha", model: "fake-model", thinking: "low" }] },
			undefined,
			toolDefinition("team_spawn") as never,
			ui,
			process.cwd(),
		);
		spawn.markExecutionStarted();

		const composed = new Container();
		composed.addChild(send);
		composed.addChild(spawn);
		assertLinesFit(composed.render(VERY_NARROW), VERY_NARROW);
	});
});

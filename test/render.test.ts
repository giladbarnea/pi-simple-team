import { describe, expect, test } from "bun:test";

import { stripAnsi } from "../render-support/ansi.ts";
import { glyphs } from "../render-support/glyphs.ts";
import {
	TeamLines,
	actorHueToken,
	allTeamsStatusLines,
	formatCharCount,
	renderTeamMessage,
	renderTeamToolResult,
	statusWordToken,
	teamLogLines,
	teamMessageLines,
	teamSendLines,
	teamShutdownLines,
	teamLineText,
	teamSpawnLines,
	teamStatusLines,
	type ThemeLike,
} from "../render.ts";
import { timeOfDay, type TeamLogEntry } from "../teamlog.ts";

const identityTheme: ThemeLike = {
	bold: (text: string) => text,
	fg: (_token: string, text: string) => text,
};

const taggingTheme: ThemeLike = {
	bold: (text: string) => text,
	fg: (token: string, text: string) => `«${token}:${text}»`,
};

const g = glyphs();

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
		const lines = teamStatusLines(identityTheme, "demo-team", statuses);
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("Team Status demo-team");
		expect(lines[0]).toContain("3 members");
		expect(lines[0]).toContain("1 working");
		expect(lines[1]).toContain(g.tree.mid.trim());
		expect(lines[3]).toContain(g.tree.last.trim());
	});

	test("aligns the status word column across rows", () => {
		const lines = teamStatusLines(identityTheme, "demo-team", statuses);
		const wordColumns = [lines[1]!.indexOf("working"), lines[2]!.indexOf("waiting"), lines[3]!.indexOf("waiting")];
		expect(new Set(wordColumns).size).toBe(1);
	});

	test("colors each status word by its semantic token", () => {
		const lines = teamStatusLines(taggingTheme, "demo-team", statuses);
		expect(lines[1]).toContain("«success:working");
		expect(lines[2]).toContain("«warning:waiting");
	});
});

describe("allTeamsStatusLines", () => {
	test("groups member rows under accent team rows", () => {
		const lines = allTeamsStatusLines(identityTheme, {
			alpha: { main: { word: "waiting", phrase: "", updated: "July 16, 22:00:00" } },
			beta: { main: { word: "working", phrase: "on it", updated: "July 16, 22:00:01" } },
		});
		expect(lines[0]).toContain("2 teams");
		expect(lines[1]).toContain("alpha");
		expect(lines[2]).toContain("waiting");
		expect(lines[3]).toContain("beta");
		expect(lines[4]).toContain("working");
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
		const lines = teamLogLines(identityTheme, logView(entries, { totalMatched: 7, nextCursor: "before:70", filters: { kind: "status", since } }));
		expect(lines[0]).toContain("Team Log demo-team");
		expect(lines[0]).toContain("1 action");
		expect(lines[0]).toContain("1 of 7 events");
		expect(lines[0]).toContain("kind=status");
		expect(lines[0]).toContain(`since ${timeOfDay(T)}`);
		expect(lines.at(-1)).toContain('cursor "before:70"');
	});

	test("renders an empty state row when nothing matched", () => {
		const lines = teamLogLines(identityTheme, { team: "demo-team", entries: [], totalMatched: 0, returned: 0 });
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("no matching events");
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

import { describe, expect, test } from "bun:test";

import { stripAnsi } from "../render-support/ansi.ts";
import { glyphs } from "../render-support/glyphs.ts";
import {
	TeamLines,
	allTeamsStatusLines,
	formatCharCount,
	kindMark,
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

describe("kindMark", () => {
	test("maps event kinds to glyph and token", () => {
		expect(kindMark(logEntry({ kind: "spawn" }))).toEqual({ glyph: g.diamond, token: "accent" });
		expect(kindMark(logEntry({ kind: "error" }))).toEqual({ glyph: g.fail, token: "error" });
		expect(kindMark(logEntry({ kind: "tool_end" }))).toEqual({ glyph: g.ok, token: "muted" });
	});

	test("marks a failed tool_end as an error", () => {
		expect(kindMark(logEntry({ kind: "tool_end", details: { isError: true } }))).toEqual({ glyph: g.fail, token: "error" });
	});
});

describe("teamLogLines", () => {
	test("renders header counts, filter stats, rows, and a cursor footer", () => {
		const entries = [
			logEntry({ sequence: 180, kind: "tool_start", summary: "reviewer started teamstatus: {...}", details: { toolName: "teamstatus", args: { word: "working" } } }),
			logEntry({ sequence: 181, kind: "status", summary: "working Writing findings" }),
		];
		const lines = teamLogLines(identityTheme, {
			team: "demo-team",
			entries,
			totalMatched: 7,
			returned: 2,
			nextCursor: "before:180",
			filters: { kind: "tool_start" },
		});
		expect(lines[0]).toContain("Team Log demo-team");
		expect(lines[0]).toContain("2 of 7 events");
		expect(lines[0]).toContain("kind=tool_start");
		expect(lines[1]).toContain("#180");
		expect(lines[1]).toContain(timeOfDay(entries[0]!.epochMilliseconds));
		expect(lines[3]).toContain('cursor "before:180"');
	});

	test("tool rows show the tool name and payload instead of the spoken summary", () => {
		const lines = teamLogLines(identityTheme, {
			team: "demo-team",
			entries: [logEntry({ kind: "tool_start", summary: "reviewer started teamstatus: {...}", details: { toolName: "teamstatus", args: { word: "working" } } })],
			totalMatched: 1,
			returned: 1,
		});
		expect(lines[1]).toContain('teamstatus {"word":"working"}');
		expect(lines[1]).not.toContain("started");
	});

	test("tool_end rows preview the result content text", () => {
		const lines = teamLogLines(identityTheme, {
			team: "demo-team",
			entries: [
				logEntry({
					kind: "tool_end",
					summary: "reviewer finished teamsend: {...}",
					details: { toolName: "teamsend", result: { content: [{ type: "text", text: '{\n  "accepted": true\n}' }] } },
				}),
			],
			totalMatched: 1,
			returned: 1,
		});
		expect(lines[1]).toContain('teamsend { "accepted": true }');
	});

	test("send rows name the sender before the message preview", () => {
		const lines = teamLogLines(identityTheme, {
			team: "demo-team",
			entries: [logEntry({ kind: "send", teammate: "implementer", summary: "please review", details: { from: "main", to: "implementer" } })],
			totalMatched: 1,
			returned: 1,
		});
		expect(lines[1]).toContain(`main ${g.arrow} please review`);
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

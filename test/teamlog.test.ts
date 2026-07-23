import { describe, test, expect } from "bun:test";
import {
	appendTeamLog,
	filterTeamLog,
	nowText,
	normalizeChildEvent,
	pageTeamLog,
	preview,
	renderTeamLogPage,
	timeOfDay,
	type TeamLogEntry,
	type TeamLogState,
} from "../teamlog.ts";

function makeState(nextLogSequence = 1): TeamLogState {
	return { log: [], nextLogSequence };
}

function makeEntry(overrides: Partial<TeamLogEntry> & Pick<TeamLogEntry, "sequence">): TeamLogEntry {
	return {
		timestamp: "July 08, 21:00:00",
		epochMilliseconds: 1_000_000 + overrides.sequence * 1_000,
		team: "demo-team",
		teammate: "Implementer",
		direction: "runtime",
		kind: "status",
		summary: `event ${overrides.sequence}`,
		...overrides,
	};
}

function makeEntries(count: number): TeamLogEntry[] {
	return Array.from({ length: count }, (_, index) => makeEntry({ sequence: index + 1 }));
}

describe("preview", () => {
	test("returns short strings unchanged", () => {
		expect(preview("hello world")).toBe("hello world");
	});

	test("collapses and trims internal whitespace", () => {
		expect(preview("  hello   \n\t world  ")).toBe("hello world");
	});

	test("truncates strings past the default 160-character limit and reports the original length", () => {
		const text = "a".repeat(200);
		expect(preview(text)).toBe(`${"a".repeat(160)} (truncated, 200 chars)`);
	});

	test("respects a custom maxLength", () => {
		expect(preview("abcdefghij", 5)).toBe("abcde (truncated, 10 chars)");
	});

	test("stringifies non-string values as compact JSON", () => {
		expect(preview({ foo: "bar", baz: 1 })).toBe('{"foo":"bar","baz":1}');
	});

	test("falls back to String() instead of throwing on unstringifiable values", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => preview(circular)).not.toThrow();
		expect(preview(circular)).toBe("[object Object]");
	});
});

describe("nowText / timeOfDay", () => {
	test("nowText formats month, day, and second-level time", () => {
		expect(nowText(new Date(2026, 6, 8, 21, 5, 44))).toBe("July 08, 21:05:44");
	});

	test("timeOfDay formats just the second-level time from an epoch", () => {
		const epoch = new Date(2026, 6, 8, 9, 2, 7).getTime();
		expect(timeOfDay(epoch)).toBe("09:02:07");
	});
});

describe("appendTeamLog", () => {
	test("assigns incrementing sequence numbers and returns the created entry", () => {
		const state = makeState(1);
		const first = appendTeamLog(state, { team: "demo-team", kind: "spawn", summary: "spawned" });
		const second = appendTeamLog(state, { team: "demo-team", kind: "status", summary: "idle" });
		expect(first.sequence).toBe(1);
		expect(second.sequence).toBe(2);
		expect(state.log).toEqual([first, second]);
	});

	test("stamps timestamp and epochMilliseconds from the provided now", () => {
		const state = makeState(1);
		const now = new Date(2026, 6, 8, 21, 5, 44);
		const entry = appendTeamLog(state, { team: "demo-team", kind: "spawn", summary: "spawned" }, now);
		expect(entry.timestamp).toBe("July 08, 21:05:44");
		expect(entry.epochMilliseconds).toBe(now.getTime());
	});

	test("caps retained entries at 1000 and drops the oldest", () => {
		const state = makeState(1);
		for (let index = 0; index < 1005; index++) {
			appendTeamLog(state, { team: "demo-team", kind: "status", summary: `event ${index}` });
		}
		expect(state.log.length).toBe(1000);
		expect(state.log[0]?.summary).toBe("event 5");
		expect(state.log.at(-1)?.summary).toBe("event 1004");
	});
});

describe("filterTeamLog", () => {
	const entries: TeamLogEntry[] = [
		makeEntry({ sequence: 1, teammate: "Implementer", kind: "send", summary: "sent handoff", epochMilliseconds: 1_000 }),
		makeEntry({ sequence: 2, teammate: "Reviewer", kind: "status", summary: "reviewing tests", epochMilliseconds: 2_000 }),
		makeEntry({
			sequence: 3,
			teammate: "Implementer",
			kind: "error",
			summary: "wrote missing file",
			epochMilliseconds: 3_000,
			details: { path: "teamlog.ts" },
		}),
	];

	test("filters by teammate", () => {
		expect(filterTeamLog(entries, { teammate: "Implementer" }).map((entry) => entry.sequence)).toEqual([1, 3]);
	});

	test("returns zero rows for an unknown teammate rather than throwing", () => {
		expect(filterTeamLog(entries, { teammate: "Ghost" })).toEqual([]);
	});

	test("filters by kind", () => {
		expect(filterTeamLog(entries, { kind: "status" }).map((entry) => entry.sequence)).toEqual([2]);
	});

	test("returns zero rows for an unknown kind rather than throwing", () => {
		expect(filterTeamLog(entries, { kind: "nonexistent" })).toEqual([]);
	});

	test("search matches summary, teammate, kind, and stringified details case-insensitively", () => {
		expect(filterTeamLog(entries, { search: "HANDOFF" }).map((entry) => entry.sequence)).toEqual([1]);
		expect(filterTeamLog(entries, { search: "reviewer" }).map((entry) => entry.sequence)).toEqual([2]);
		expect(filterTeamLog(entries, { search: "teamlog.ts" }).map((entry) => entry.sequence)).toEqual([3]);
	});

	test("filters by since, keeping entries at or after the threshold", () => {
		expect(filterTeamLog(entries, { since: new Date(2_000).toISOString() }).map((entry) => entry.sequence)).toEqual([2, 3]);
	});

	test("throws on an unparseable since value", () => {
		expect(() => filterTeamLog(entries, { since: "not-a-date" })).toThrow();
	});

	test("combines filters with AND semantics", () => {
		expect(filterTeamLog(entries, { teammate: "Implementer", kind: "error" }).map((entry) => entry.sequence)).toEqual([3]);
	});
});

describe("pageTeamLog", () => {
	test("defaults to the latest 20 entries when limit is omitted", () => {
		const entries = makeEntries(25);
		const page = pageTeamLog(entries, {});
		expect(page.limit).toBe(20);
		expect(page.returned).toBe(20);
		expect(page.entries.map((entry) => entry.sequence)).toEqual(Array.from({ length: 20 }, (_, index) => index + 6));
	});

	test("keeps page entries in chronological (oldest-to-newest) order", () => {
		const entries = makeEntries(5);
		const page = pageTeamLog(entries, { limit: 5 });
		expect(page.entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5]);
	});

	test("clamps limit above 100 down to the 100 max", () => {
		const entries = makeEntries(150);
		const page = pageTeamLog(entries, { limit: 500 });
		expect(page.limit).toBe(100);
		expect(page.returned).toBe(100);
	});

	test("floors a fractional limit", () => {
		const entries = makeEntries(10);
		const page = pageTeamLog(entries, { limit: 3.9 });
		expect(page.limit).toBe(3);
		expect(page.returned).toBe(3);
	});

	test("rejects a limit below 1", () => {
		expect(() => pageTeamLog(makeEntries(5), { limit: 0 })).toThrow();
		expect(() => pageTeamLog(makeEntries(5), { limit: -3 })).toThrow();
	});

	test("rejects a non-finite limit", () => {
		expect(() => pageTeamLog(makeEntries(5), { limit: Number.NaN })).toThrow();
		expect(() => pageTeamLog(makeEntries(5), { limit: Number.POSITIVE_INFINITY })).toThrow();
	});

	test("totalMatched reflects the full input set regardless of cursor position", () => {
		const entries = makeEntries(25);
		const firstPage = pageTeamLog(entries, { limit: 20 });
		const secondPage = pageTeamLog(entries, { limit: 20, cursor: firstPage.nextCursor });
		expect(firstPage.totalMatched).toBe(25);
		expect(secondPage.totalMatched).toBe(25);
	});

	test("nextCursor points to the oldest sequence in the page when older entries remain", () => {
		const entries = makeEntries(25);
		const page = pageTeamLog(entries, { limit: 20 });
		expect(page.nextCursor).toBe("before:6");
	});

	test("omits nextCursor when the page reaches the oldest entry", () => {
		const entries = makeEntries(5);
		const page = pageTeamLog(entries, { limit: 20 });
		expect(page.nextCursor).toBeUndefined();
	});

	test("walks backward through every page via nextCursor until exhausted", () => {
		const entries = makeEntries(45);
		const pages: number[][] = [];
		let cursor: string | undefined;
		for (let guard = 0; guard < 10; guard++) {
			const page = pageTeamLog(entries, { limit: 20, cursor });
			pages.push(page.entries.map((entry) => entry.sequence));
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		expect(pages).toEqual([
			Array.from({ length: 20 }, (_, index) => index + 26),
			Array.from({ length: 20 }, (_, index) => index + 6),
			Array.from({ length: 5 }, (_, index) => index + 1),
		]);
	});

	test("rejects a malformed cursor", () => {
		expect(() => pageTeamLog(makeEntries(5), { cursor: "not-a-cursor" })).toThrow();
		expect(() => pageTeamLog(makeEntries(5), { cursor: "after:3" })).toThrow();
	});
});

describe("renderTeamLogPage", () => {
	test("renders a header with team name and matched/returned counts", () => {
		const entries = makeEntries(3);
		const page = pageTeamLog(entries, { limit: 20 });
		const text = renderTeamLogPage({ ...page, team: "demo-team" });
		expect(text.split("\n")[0]).toBe("Team demo-team — latest 3 of 3 matching events");
	});

	test("includes a column header naming every field", () => {
		const page = pageTeamLog(makeEntries(1), {});
		const text = renderTeamLogPage({ ...page, team: "demo-team" });
		const columnHeader = text.split("\n")[1];
		for (const label of ["seq", "time", "teammate", "kind", "dir", "summary"]) {
			expect(columnHeader).toContain(label);
		}
	});

	test("renders one row per entry with zero-padded sequence and defaults teammate to main when absent", () => {
		const entries = [makeEntry({ sequence: 7, teammate: undefined, summary: "no teammate on this row" })];
		const page = pageTeamLog(entries, {});
		const text = renderTeamLogPage({ ...page, team: "demo-team" });
		const row = text.split("\n")[2];
		expect(row.startsWith("007")).toBe(true);
		expect(row).toContain("main");
		expect(row).toContain("no teammate on this row");
	});

	test("footer reports counts and appends nextCursor when present", () => {
		const entries = makeEntries(25);
		const page = pageTeamLog(entries, { limit: 20 });
		const text = renderTeamLogPage({ ...page, team: "demo-team" });
		expect(text.split("\n").at(-1)).toBe('Showing 20 of 25 matching events. nextCursor="before:6"');
	});

	test("footer omits nextCursor when there is no older page", () => {
		const entries = makeEntries(3);
		const page = pageTeamLog(entries, { limit: 20 });
		const text = renderTeamLogPage({ ...page, team: "demo-team" });
		expect(text.split("\n").at(-1)).toBe("Showing 3 of 3 matching events.");
	});

	test("renders without crashing on an empty page", () => {
		const page = pageTeamLog([], {});
		const text = renderTeamLogPage({ ...page, team: "demo-team" });
		expect(text.split("\n").at(-1)).toBe("Showing 0 of 0 matching events.");
	});
});

describe("normalizeChildEvent (child agent/tool lifecycle normalization)", () => {
	test("maps agent_start to an agent_start entry", () => {
		const entry = normalizeChildEvent("demo-team", "Implementer", { type: "agent_start" });
		expect(entry?.kind).toBe("agent_start");
		expect(entry?.direction).toBe("runtime");
		expect(entry?.team).toBe("demo-team");
		expect(entry?.teammate).toBe("Implementer");
	});

	test("maps agent_end to an agent_end entry and mentions the message count when present", () => {
		const entry = normalizeChildEvent("demo-team", "Implementer", { type: "agent_end", messages: [{}, {}, {}] });
		expect(entry?.kind).toBe("agent_end");
		expect(entry?.summary).toContain("3");
		expect(entry?.details).toEqual({ messageCount: 3 });
	});

	test("maps agent_end without a messages array", () => {
		const entry = normalizeChildEvent("demo-team", "Implementer", { type: "agent_end" });
		expect(entry?.kind).toBe("agent_end");
		expect(entry?.summary).toBe("Implementer finished");
	});

	test("maps tool_execution_start to a tool_start entry carrying tool name and args", () => {
		const entry = normalizeChildEvent("demo-team", "Implementer", {
			type: "tool_execution_start",
			toolCallId: "call_1",
			toolName: "bash",
			args: { command: "ls -la" },
		});
		expect(entry?.kind).toBe("tool_start");
		expect(entry?.summary).toContain("bash");
		expect(entry?.summary).toContain("ls -la");
		expect(entry?.details).toEqual({ toolCallId: "call_1", toolName: "bash", args: { command: "ls -la" } });
	});

	test("maps a successful tool_execution_end to a tool_end entry", () => {
		const entry = normalizeChildEvent("demo-team", "Implementer", {
			type: "tool_execution_end",
			toolCallId: "call_1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "total 0" }] },
			isError: false,
		});
		expect(entry?.kind).toBe("tool_end");
		expect(entry?.summary).toContain("finished");
		expect((entry?.details as Record<string, unknown> | undefined)?.isError).toBe(false);
	});

	test("maps a failed tool_execution_end and surfaces the failure in the summary", () => {
		const entry = normalizeChildEvent("demo-team", "Implementer", {
			type: "tool_execution_end",
			toolCallId: "call_1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "command not found" }] },
			isError: true,
		});
		expect(entry?.kind).toBe("tool_end");
		expect(entry?.summary).toContain("failed");
		expect((entry?.details as Record<string, unknown> | undefined)?.isError).toBe(true);
	});

	test("skips tool frames for the team child tools, whose semantic entries carry the story", () => {
		for (const toolName of ["teamsend", "teammain", "teamstatus"]) {
			expect(normalizeChildEvent("demo-team", "Implementer", { type: "tool_execution_start", toolCallId: "c1", toolName, args: {} })).toBeUndefined();
			expect(normalizeChildEvent("demo-team", "Implementer", { type: "tool_execution_end", toolCallId: "c1", toolName, result: {}, isError: false })).toBeUndefined();
		}
	});

	test("maps extension_error to an error entry", () => {
		const entry = normalizeChildEvent("demo-team", "Implementer", {
			type: "extension_error",
			extensionPath: "/path/to/extension.ts",
			event: "tool_call",
			error: "boom",
		});
		expect(entry?.kind).toBe("error");
		expect(entry?.summary).toContain("boom");
	});

	test("drops noisy event types that should not be logged in MVP", () => {
		for (const type of ["message_update", "turn_start", "turn_end", "message_start", "message_end", "response", "queue_update"]) {
			expect(normalizeChildEvent("demo-team", "Implementer", { type })).toBeUndefined();
		}
	});
});

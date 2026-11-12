import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import teamExtension from "../index.ts";
import { canonicalProjectDirectory, writeTeamManifest, type TeamManifest } from "../team-registry.ts";

type JsonRecord = Record<string, unknown>;
type ToolResult = { content: Array<{ type: string; text: string }>; details: JsonRecord };
type RegisteredTool = { name: string; execute: (id: string, params: JsonRecord, signal: AbortSignal, update: undefined, context: unknown) => Promise<ToolResult> };
type ListedTeam = { teamName: string; teamId: string; state: string; teammates: JsonRecord[] };

const longPrompt = "Remember every detail of this mission. ".repeat(500);

/** Main's team_list over a project whose stored teams the test writes directly. */
function startMain() {
	const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-list-"));
	const tools = new Map<string, RegisteredTool>();
	teamExtension({
		on: () => undefined, registerCommand: () => undefined, registerMessageRenderer: () => undefined, sendMessage: () => undefined,
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
	} as unknown as ExtensionAPI);
	const context = { cwd: projectDirectory, sessionManager: { getCwd: () => projectDirectory, getSessionId: () => "list-main" } };
	const list = async (params: JsonRecord = {}) => {
		const result = await tools.get("team_list")!.execute("list", params, new AbortController().signal, undefined, context);
		return { result, payload: JSON.parse(result.content[0]!.text) as { teams: ListedTeam[]; nextCursor?: string; dormantTeamsHidden?: number; instruction?: string } };
	};
	/** Stores team `index`, created `index` minutes after a fixed start, with one teammate holding a long prompt. */
	const store = (index: number, state: "active" | "dormant", updatedAt = "2026-11-12T00:00:00.000Z"): void => {
		const createdAt = new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString();
		const manifest: TeamManifest = {
			version: 2, id: `list-main-team-${index}`, name: `team-${index}`, originMainSessionId: "list-main",
			projectDirectory: canonicalProjectDirectory(projectDirectory), teamPrompt: longPrompt, showOnHerdrPanes: false,
			members: [{ name: `mate-${index}`, systemPrompt: longPrompt, model: "fake/fake-model", thinking: "high", forkContext: false, canManageOwnTeams: false, showOnHerdrPane: false, live: false, active: false, teammateId: `session-${index}`, sessionFile: path.join(projectDirectory, `session-${index}.jsonl`), sessionMaterialized: true, extensionPaths: [projectDirectory] }],
			state, createdAt, updatedAt,
			...(state === "dormant" ? { shutdownAt: updatedAt, expiresAt: "2026-12-12T00:00:00.000Z" } : {}),
		};
		writeTeamManifest(manifest);
	};
	return { list, store, close: () => fs.rmSync(projectDirectory, { recursive: true, force: true }) };
}

const names = (teams: ListedTeam[]): string[] => teams.map((team) => team.teamName);

describe("team_list shows short rows of active teams by default", () => {
	test("hides dormant teams, says how many it hid, and leaves prompts and settings out of the model's text", async () => {
		const main = startMain();
		try {
			main.store(1, "active");
			main.store(2, "dormant");
			main.store(3, "active");
			const { result, payload } = await main.list();
			{
				assert.deepEqual(names(payload.teams), ["team-3", "team-1"], "Active teams only, newest created first.");
				assert.equal(payload.dormantTeamsHidden, 1);
				assert.match(payload.instruction!, /includeDormantTeams: true/);
				assert.deepEqual(payload.teams[0]!.teammates, [{ name: "mate-3", teammateId: "session-3", model: "fake/fake-model", live: false, active: false }]);
				assert.doesNotMatch(result.content[0]!.text, /Remember every detail|systemPrompt|sessionFile|extensionPaths/, "Prompts and settings stay out of the default text.");
				assert.match(JSON.stringify(result.details.teams), /Remember every detail/, "The renderer still receives full records.");
			}
		} finally {
			main.close();
		}
	});

	test("includeDormantTeams lists every team, and team returns one team's full records", async () => {
		const main = startMain();
		try {
			main.store(1, "active");
			main.store(2, "dormant");
			assert.deepEqual(names((await main.list({ includeDormantTeams: true })).payload.teams), ["team-2", "team-1"]);
			assert.equal((await main.list({ includeDormantTeams: true })).payload.dormantTeamsHidden, undefined);
			const detail = (await main.list({ team: "team-2" })).payload.teams[0]!;
			assert.equal(detail.state, "dormant");
			assert.equal((detail.teammates[0] as JsonRecord).systemPrompt, longPrompt, "team returns the full saved definition.");
			await assert.rejects(main.list({ team: "team-9" }), /Unknown current-project team: "team-9"\. Call team_list with includeDormantTeams: true/);
		} finally {
			main.close();
		}
	});

	test("40 retained teams with 20 KB prompts stay under 8 KB per default page of 20, and paging reaches the oldest", async () => {
		const main = startMain();
		try {
			for (let index = 1; index <= 40; index += 1) main.store(index, "active");
			const first = await main.list();
			assert.equal(first.payload.teams.length, 20);
			assert.ok(first.result.content[0]!.text.length < 8_000, `Default page bytes: ${first.result.content[0]!.text.length}`);
			const second = await main.list({ cursor: first.payload.nextCursor });
			assert.deepEqual(names(second.payload.teams).at(-1), "team-1");
			assert.equal(second.payload.nextCursor, undefined);
		} finally {
			main.close();
		}
	});
});

describe("team_list paging survives teams changing between pages", () => {
	test("a team that refreshes, shuts down or resumes between pages is neither repeated nor skipped", async () => {
		const main = startMain();
		try {
			for (let index = 1; index <= 5; index += 1) main.store(index, "active");
			main.store(6, "dormant");
			const first = await main.list({ limit: 2 });
			assert.deepEqual(names(first.payload.teams), ["team-5", "team-4"]);
			main.store(4, "active", "2026-11-12T09:00:00.000Z");
			main.store(2, "dormant", "2026-11-12T09:00:00.000Z");
			main.store(6, "active", "2026-11-12T09:00:00.000Z");
			const second = await main.list({ limit: 2, cursor: first.payload.nextCursor });
			assert.deepEqual(names(second.payload.teams), ["team-3", "team-1"], "Team 4 is not repeated after its activity, team 3 is not skipped, and team 2 is hidden once dormant.");
			assert.equal(second.payload.nextCursor, undefined);
			assert.deepEqual(names((await main.list({ limit: 2 })).payload.teams), ["team-6", "team-5"], "A fresh listing shows the team that resumed.");
		} finally {
			main.close();
		}
	});

	test("with includeDormantTeams, a team that shuts down between pages still appears exactly once", async () => {
		const main = startMain();
		try {
			for (let index = 1; index <= 4; index += 1) main.store(index, "active");
			const first = await main.list({ limit: 2, includeDormantTeams: true });
			main.store(2, "dormant", "2026-11-12T09:00:00.000Z");
			main.store(4, "dormant", "2026-11-12T09:00:00.000Z");
			const second = await main.list({ limit: 2, includeDormantTeams: true, cursor: first.payload.nextCursor });
			assert.deepEqual([...names(first.payload.teams), ...names(second.payload.teams)], ["team-4", "team-3", "team-2", "team-1"]);
			assert.equal(second.payload.teams[0]!.state, "dormant");
		} finally {
			main.close();
		}
	});

	test("a cursor needs the same includeDormantTeams, and a bad cursor fails clearly", async () => {
		const main = startMain();
		try {
			for (let index = 1; index <= 3; index += 1) main.store(index, "active");
			const first = await main.list({ limit: 1 });
			await assert.rejects(main.list({ limit: 1, includeDormantTeams: true, cursor: first.payload.nextCursor }), /Keep the same includeDormantTeams/);
			await assert.rejects(main.list({ cursor: "not-a-cursor" }), /Invalid team_list cursor/);
			await assert.rejects(main.list({ team: "team-1", cursor: first.payload.nextCursor }), /either team or cursor/);
		} finally {
			main.close();
		}
	});
});

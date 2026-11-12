import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import teamExtension from "../index.ts";
import { canonicalProjectDirectory, claimTeamLease, writeTeamManifest } from "../team-registry.ts";
import { loadAsBunStandalonePi, useEnvironment } from "./pi-launch.ts";

type JsonRecord = Record<string, unknown>;
type ToolResult = { content: Array<{ type: string; text: string }>; details: JsonRecord };
type RegisteredTool = { name: string; execute: (id: string, params: JsonRecord, signal: AbortSignal, update: undefined, context: unknown) => Promise<ToolResult> };
type ModelRequest = { model: string; reasoning_effort?: string; messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function?: { name?: string } }> };
type TeammateRecord = { name: string; teammateId: string; model: string; thinking: string; extensionPaths?: string[]; sessionFile: string; live: boolean; active: boolean; held?: boolean };
type SessionEntry = { type: string; provider?: string; modelId?: string; thinkingLevel?: string };
type Status = { word: string; phrase: string };

const teamName = "update";

/**
 * Main with one real-Pi team: models local/a and local/b answer from a canned local provider that records every request.
 * `holdResponses` keeps each later request open until `release`, so a teammate stays busy. `failNextResponse` fails the next request.
 * Each request's text carries its teammate's name in the briefing, so `requestsFor` separates teammates.
 */
async function startMain(directory: string) {
	const executable = Bun.which("pi");
	assert.ok(executable, "The real-Pi check requires pi on PATH.");
	const agentDirectory = path.join(directory, "agent");
	const projectDirectory = path.join(directory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);
	const modelRequests: ModelRequest[] = [];
	const notices: string[] = [];
	const held: Array<() => void> = [];
	let holdResponses = false;
	let failNextResponse = false;
	const provider = Bun.serve({
		hostname: "127.0.0.1", port: 0, idleTimeout: 0,
		async fetch(request: Request): Promise<Response> {
			modelRequests.push(await request.json() as ModelRequest);
			if (holdResponses) await new Promise<void>((resolve) => held.push(resolve));
			if (failNextResponse) {
				failNextResponse = false;
				return new Response("canned provider failure", { status: 500 });
			}
			const chunk = (delta: JsonRecord, finishReason: string | null): string => `data: ${JSON.stringify({ id: "update-probe", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
			return new Response(chunk({ role: "assistant", content: "Done." }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		},
	});
	const model = (id: string) => ({ id, name: id, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 });
	fs.writeFileSync(path.join(agentDirectory, "models.json"), JSON.stringify({ providers: { local: {
		baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", apiKey: "local-fixture", models: [model("a"), model("b")],
	} } }));
	fs.writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
	const launcher = path.join(directory, "pi-launcher");
	const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
	fs.writeFileSync(launcher, `#!/bin/sh\nexec ${quote(executable)} --no-skills --no-context-files "$@"\n`, { mode: 0o755 });
	const restoreAgentEnvironment = useEnvironment({ PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1" });
	const tools = new Map<string, RegisteredTool>();
	const shutdownHandlers: Array<() => Promise<void>> = [];
	const context = {
		cwd: projectDirectory, scopedModels: [], modelRegistry: { getAvailable: () => [{ provider: "local", id: "a" }, { provider: "local", id: "b" }] },
		sessionManager: { getCwd: () => projectDirectory, getSessionId: () => "update-main", getSessionFile: () => path.join(directory, "main.jsonl") },
	};
	const api = {
		on: (event: string, handler: (event: JsonRecord, context: unknown) => Promise<void>) => {
			if (event === "session_start") void handler({ reason: "startup" }, context);
			if (event === "session_shutdown") shutdownHandlers.push(() => handler({ reason: "quit" }, context));
		},
		registerCommand: () => undefined, registerMessageRenderer: () => undefined,
		sendMessage: (message: { content: string }) => notices.push(message.content),
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
	} as unknown as ExtensionAPI;
	loadAsBunStandalonePi(launcher, () => teamExtension(api));
	const execute = async (name: string, params: JsonRecord): Promise<ToolResult> => {
		const tool = tools.get(name);
		assert.ok(tool, `Expected the ${name} tool. Registered: ${[...tools.keys()]}`);
		return tool.execute(name, params, new AbortController().signal, undefined, context);
	};
	const roster = async (): Promise<TeammateRecord[]> => ((await execute("team_list", { team: teamName })).details.teams as Array<{ teammates: TeammateRecord[] }>)[0]!.teammates;
	const listed = async (name = "x"): Promise<TeammateRecord> => (await roster()).find((teammate) => teammate.name === name)!;
	const statusOf = async (name = "x"): Promise<Status> => ((await execute("team_status", { team: teamName })).details.status as Record<string, Status>)[name]!;
	const waitFor = async (description: string, condition: () => boolean | Promise<boolean>): Promise<void> => {
		for (let attempt = 0; attempt < 1500; attempt += 1) {
			if (await condition()) return;
			await Bun.sleep(10);
		}
		assert.fail(`Timed out waiting for ${description}.`);
	};
	return {
		modelRequests, notices, projectDirectory, execute, roster, listed, statusOf, waitFor,
		requestsFor: (name: string): ModelRequest[] => modelRequests.filter((request) => JSON.stringify(request.messages).includes(`You are ${name}, a teammate`)),
		holdResponses: () => { holdResponses = true; },
		failNextResponse: () => { failNextResponse = true; },
		release: () => { holdResponses = false; for (const resolve of held.splice(0)) resolve(); },
		spawn: (startIdle: boolean, teammates: JsonRecord[] = [{ name: "x" }]) => execute("team_spawn", {
			teamName, commonPrompt: "Answer.", startIdle,
			teammates: teammates.map((teammate) => ({ model: "local/a", thinking: "low", systemPrompt: "Answer.", ...teammate })),
		}),
		close: async (): Promise<void> => {
			holdResponses = false;
			for (const resolve of held.splice(0)) resolve();
			for (const shutdown of shutdownHandlers) await shutdown();
			provider.stop(true);
			restoreAgentEnvironment();
		},
	};
}

type Main = Awaited<ReturnType<typeof startMain>>;

async function withMain(run: (main: Main, directory: string) => Promise<void>): Promise<void> {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-update-"));
	const main = await startMain(directory);
	try {
		await run(main, directory);
	} finally {
		await main.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

/** A tiny extension file that registers one named tool. */
function writeToolExtension(directory: string, toolName: string): string {
	const file = path.join(directory, `${toolName}.ts`);
	fs.writeFileSync(file, `export default function (pi) { pi.registerTool({ name: ${JSON.stringify(toolName)}, label: "Probe", description: "Probe tool.", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "ok" }] }; } }); }\n`);
	return file;
}

/**
 * A team the managing teammate's own session created, with one teammate, as its manifest and lease record it.
 * `lease: "live"` holds the lease for a living process of the manager; `"stale"` leaves it to a process that died, as an abrupt manager death does;
 * `"another main"` gives it to a living process of another session, as when another main resumed the team.
 */
function storeManagedTeam(main: Main, managerSessionId: string, teammateActive: boolean, lease: "live" | "stale" | "another main"): void {
	const now = new Date().toISOString();
	const teamId = `${managerSessionId}-sub`;
	writeTeamManifest({
		version: 2, id: teamId, name: "sub", originMainSessionId: managerSessionId,
		projectDirectory: canonicalProjectDirectory(main.projectDirectory), teamPrompt: "Work.", showOnHerdrPanes: false,
		members: [{ name: "w", systemPrompt: "Work.", model: "local/a", thinking: "low", forkContext: false, canManageOwnTeams: false, showOnHerdrPane: false, live: true, active: teammateActive, teammateId: "w-session", sessionFile: path.join(main.projectDirectory, "w.jsonl"), sessionMaterialized: false }],
		state: "active", createdAt: now, updatedAt: now,
	});
	const leaseFile = path.join(process.env.PI_CODING_AGENT_DIR!, "pi-simple-team", "teams-v2", `${encodeURIComponent(teamId)}.lease`);
	if (!fs.existsSync(leaseFile)) claimTeamLease(teamId, managerSessionId);
	const record = JSON.parse(fs.readFileSync(leaseFile, "utf8")) as { processId: number; mainSessionId: string };
	fs.writeFileSync(leaseFile, JSON.stringify({ ...record, processId: lease === "stale" ? 2_147_483_000 : process.pid, mainSessionId: lease === "another main" ? "another-main-session" : managerSessionId }));
}

const sessionEntries = (sessionFile: string): SessionEntry[] => fs.readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as SessionEntry);
const declaredTools = (request: ModelRequest): string[] => (request.tools ?? []).map((tool) => String(tool.function?.name));
const conversationText = (request: ModelRequest): string => request.messages.map((message) => typeof message.content === "string" ? message.content : (message.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("")).join("\n");

/** Waits for each teammate's first turn and returns its saved session bytes once it is idle. */
async function finishFirstTurns(main: Main, names: string[] = ["x"]): Promise<Map<string, { teammate: TeammateRecord; sessionBytes: Buffer }>> {
	await main.waitFor("the first turns", () => names.every((name) => main.requestsFor(name).length === 1));
	await main.waitFor("idle teammates with saved sessions", async () => (await main.roster()).every((teammate) => !teammate.active && fs.existsSync(teammate.sessionFile)));
	const records = await main.roster();
	return new Map(names.map((name) => {
		const teammate = records.find((record) => record.name === name)!;
		return [name, { teammate, sessionBytes: fs.readFileSync(teammate.sessionFile) }];
	}));
}

/** Starts a run on the teammate and keeps it open, so the teammate is busy until `main.release()`. */
async function holdBusyRun(main: Main, name = "x"): Promise<void> {
	const before = main.requestsFor(name).length;
	main.holdResponses();
	await main.execute("team_send_message", { targets: [name], message: "Long task." });
	await main.waitFor("the busy run's request", () => main.requestsFor(name).length === before + 1);
}

const realPi = describe.skipIf(process.env.PI_SIMPLE_TEAM_TEST_REAL_PI !== "1");

realPi("team_update_teammates changes a live teammate in its own conversation", () => {
	test("an idle teammate's next run uses the new model, thinking level and extension after its saved history, and its teammate keeps everything", async () => {
		await withMain(async (main, directory) => {
			await main.spawn(false, [{ name: "x" }, { name: "y" }]);
			const before = await finishFirstTurns(main, ["x", "y"]);
			const extensionPath = writeToolExtension(directory, "updated_probe");
			const result = await main.execute("team_update_teammates", { teammates: [{ teammate: "x", model: "local/b", thinking: "high", extensionPaths: [extensionPath] }] });
			const updated = (result.details.teammates as TeammateRecord[])[0]!;
			assert.deepEqual([updated.name, updated.model, updated.thinking, updated.extensionPaths, updated.held], ["x", "local/b", "high", [extensionPath], false]);
			await main.execute("team_send_message", { targets: ["x", "y"], message: "Second question." });
			await main.waitFor("both second turns", () => main.requestsFor("x").length === 2 && main.requestsFor("y").length === 2);
			const second = main.requestsFor("x")[1]!;
			assert.equal(second.model, "b", "The next run must use the new model.");
			assert.equal(second.reasoning_effort, "high", "The next run must use the new thinking level.");
			assert.ok(declaredTools(second).includes("updated_probe"), `The new extension's tool must load. Declared: ${declaredTools(second)}`);
			assert.match(conversationText(second), /Answer\.[\s\S]*Done\.[\s\S]*Second question\./, "The conversation must continue after the first exchange.");
			assert.match(conversationText(second), /Main changed your configuration: model: local\/b, thinking: high, extensions: \[[^\]]*updated_probe\.ts[^\]]*\]\. You continue in this conversation with these settings\./, "The restarted teammate must learn its new settings.");
			const other = main.requestsFor("y")[1]!;
			assert.deepEqual([other.model, other.reasoning_effort, declaredTools(other).includes("updated_probe")], ["a", "low", false], "The other teammate must keep its settings.");
			assert.match(conversationText(other), /Answer\.[\s\S]*Done\.[\s\S]*Second question\./, "The other teammate must keep its conversation.");
			const after = await main.listed("x");
			assert.equal(after.teammateId, before.get("x")!.teammate.teammateId, "The teammate must keep its session identity.");
			assert.deepEqual(fs.readFileSync(after.sessionFile).subarray(0, before.get("x")!.sessionBytes.length), before.get("x")!.sessionBytes, "The saved history must stay byte-identical.");
			assert.deepEqual([after.model, after.thinking, after.extensionPaths], ["local/b", "high", [extensionPath]], "The saved settings must change.");
			const changes = sessionEntries(after.sessionFile).slice(before.get("x")!.sessionBytes.toString().trim().split("\n").length).filter((entry) => entry.type === "model_change" || entry.type === "thinking_level_change");
			assert.deepEqual(changes.map((entry) => entry.modelId ?? entry.thinkingLevel), ["b", "high"], "The session must record the switch as Pi records one.");
			const otherAfter = await main.listed("y");
			assert.deepEqual([otherAfter.teammateId, otherAfter.model, otherAfter.thinking, otherAfter.extensionPaths], [before.get("y")!.teammate.teammateId, "local/a", "low", undefined]);
			assert.equal(sessionEntries(otherAfter.sessionFile).some((entry) => entry.type === "model_change" && entry.modelId === "b"), false, "The other teammate's session must not change settings.");
		});
	});

	test("a busy teammate finishes its run before the update applies, interrupt: false never aborts it, and main hears when it applies", async () => {
		await withMain(async (main) => {
			await main.spawn(false);
			await finishFirstTurns(main);
			await holdBusyRun(main);
			const result = await main.execute("team_update_teammates", { teammates: [{ teammate: "x", model: "local/b" }] });
			assert.equal((result.details.teammates as TeammateRecord[])[0]!.held, true, "A busy teammate's update must wait.");
			await Bun.sleep(500);
			assert.equal((await main.listed()).model, "local/a", "The update must not apply while the teammate works.");
			main.release();
			await main.waitFor("the update after the run settles", async () => (await main.listed()).model === "local/b" && (await main.listed()).live);
			const stopReasons = fs.readFileSync((await main.listed()).sessionFile, "utf8").match(/"stopReason":"(\w+)"/g);
			assert.deepEqual(stopReasons, ['"stopReason":"stop"', '"stopReason":"stop"'], "The busy run must complete, not abort.");
			await main.waitFor("main's notice", () => main.notices.some((notice) => /held settings update is applied \(model: local\/b\)/.test(notice)));
			await main.execute("team_send_message", { targets: ["x"], message: "After the update." });
			await main.waitFor("the next turn", () => main.modelRequests.length === 3);
			assert.equal(main.modelRequests[2]!.model, "b");
		});
	});

	test("interrupt: true stops the busy run, then applies the update", async () => {
		await withMain(async (main) => {
			await main.spawn(false);
			await finishFirstTurns(main);
			await holdBusyRun(main);
			const result = await main.execute("team_update_teammates", { teammates: [{ teammate: "x", thinking: "high" }], interrupt: true });
			const updated = (result.details.teammates as TeammateRecord[])[0]!;
			assert.deepEqual([updated.held, updated.thinking, updated.live], [false, "high", true]);
			main.release();
			await main.execute("team_send_message", { targets: ["x"], message: "After the update." });
			await main.waitFor("the next turn", () => main.modelRequests.length === 3);
			assert.equal(main.modelRequests[2]!.reasoning_effort, "high");
			assert.match(conversationText(main.modelRequests[2]!), /interrupted your run to update your configuration/, "The teammate must learn why its run stopped.");
		});
	});

	test("a held update keeps a failed run's error status visible after it applies", async () => {
		await withMain(async (main) => {
			await main.spawn(false);
			await finishFirstTurns(main);
			await holdBusyRun(main);
			await main.execute("team_update_teammates", { teammates: [{ teammate: "x", thinking: "high" }] });
			main.failNextResponse();
			main.release();
			await main.waitFor("main's notice that the held update applied", () => main.notices.some((notice) => /held settings update is applied/.test(notice)));
			assert.equal((await main.listed()).thinking, "high");
			const status = await main.statusOf();
			assert.equal(status.word, "error", `The failed run must stay visible after the restart. Got: ${JSON.stringify(status)}`);
		});
	});

	test("rejects unknown teammates, unavailable models and empty updates before changing anything", async () => {
		await withMain(async (main) => {
			await main.spawn(true);
			await main.waitFor("a registered teammate", async () => (await main.listed()).live);
			await assert.rejects(main.execute("team_update_teammates", { teammates: [{ teammate: "nobody", model: "local/b" }] }), /Unknown target "nobody"/);
			await assert.rejects(main.execute("team_update_teammates", { teammates: [{ teammate: "x", model: "local/missing" }] }), /Model "local\/missing" for teammate "x" is not available/);
			await assert.rejects(main.execute("team_update_teammates", { teammates: [{ teammate: "x" }] }), /Teammate "x" has no settings to change/);
			assert.equal((await main.listed()).model, "local/a");
		});
	});
});

realPi("a held update never outlives its teammate's process or its team", () => {
	test("team_shutdown reports a held update it drops, and the next resume keeps the saved settings", async () => {
		await withMain(async (main) => {
			await main.spawn(false);
			await finishFirstTurns(main);
			await holdBusyRun(main);
			await main.execute("team_update_teammates", { teammates: [{ teammate: "x", model: "local/b" }] });
			const shutdown = await main.execute("team_shutdown", { team: teamName });
			assert.deepEqual(shutdown.details.droppedUpdates, [{ name: "x", teammateId: (await main.listed()).teammateId, settings: "model: local/b" }]);
			main.release();
			await main.execute("team_resume", { team: teamName, resumptionPrompt: "Back." });
			await main.waitFor("the resumed turn", () => main.modelRequests.at(-1)?.messages.some((message) => JSON.stringify(message.content).includes("Back.")) ?? false);
			assert.equal(main.modelRequests.at(-1)!.model, "a", "A dropped update must not apply later.");
		});
	});

	test("a teammate that dies with a held update reports it, and a resume with newer settings is not overridden", async () => {
		await withMain(async (main) => {
			await main.spawn(false);
			await finishFirstTurns(main);
			await holdBusyRun(main);
			await main.execute("team_update_teammates", { teammates: [{ teammate: "x", model: "local/b" }] });
			execFileSync("pkill", ["-KILL", "-f", path.resolve(import.meta.dir, "..", "index.ts")]);
			await main.waitFor("the end notice", () => main.notices.some((notice) => /held settings update \(model: local\/b\) was not applied/.test(notice)));
			main.release();
			await main.execute("team_resume", { team: teamName, teammateUpdates: [{ teammate: "x", thinking: "high" }], resumptionPrompt: "Back." });
			await main.waitFor("the resumed turn", () => main.modelRequests.at(-1)?.messages.some((message) => JSON.stringify(message.content).includes("Back.")) ?? false);
			await main.waitFor("an idle resumed teammate", async () => !(await main.listed()).active);
			await Bun.sleep(300);
			const after = await main.listed();
			assert.deepEqual([main.modelRequests.at(-1)!.model, main.modelRequests.at(-1)!.reasoning_effort, after.model, after.thinking], ["a", "high", "local/a", "high"], "The stale held model must not apply.");
		});
	});
});

realPi("a managing teammate is updated only while its own teammates are idle", () => {
	test("the update fails early while one of its teammates works, then succeeds once they are idle and tells it to resume its teams", async () => {
		await withMain(async (main) => {
			await main.spawn(false, [{ name: "x", canManageOwnTeams: true }]);
			const { teammate } = (await finishFirstTurns(main)).get("x")!;
			storeManagedTeam(main, teammate.teammateId, true, "live");
			await assert.rejects(
				main.execute("team_update_teammates", { teammates: [{ teammate: "x", model: "local/b" }] }),
				/Teammate "x" has active teammates: "w" on team "sub"\. Ask it to soft-pause them, because you want to reload its process without cutting them off\. Once it reports them all idle, call team_update_teammates again\./,
			);
			await assert.rejects(main.execute("team_update_teammates", { teammates: [{ teammate: "x", model: "local/b" }], interrupt: true }), /has active teammates/);
			await main.execute("team_send_message", { targets: ["x"], message: "Report." });
			await main.waitFor("the manager settling", async () => main.modelRequests.length === 2 && !(await main.listed()).active);
			await Bun.sleep(300);
			assert.equal((await main.listed()).model, "local/a", "A refused update must not be held for later.");
			await holdBusyRun(main);
			storeManagedTeam(main, teammate.teammateId, false, "live");
			await assert.rejects(main.execute("team_update_teammates", { teammates: [{ teammate: "x", model: "local/b" }] }), /Teammate "x" manages teams and is working, so its update is not held/);
			main.release();
			await main.waitFor("the manager settling again", async () => !(await main.listed()).active);
			const result = await main.execute("team_update_teammates", { teammates: [{ teammate: "x", model: "local/b" }] });
			assert.deepEqual([(result.details.teammates as TeammateRecord[])[0]!.held, (result.details.teammates as TeammateRecord[])[0]!.model], [false, "local/b"]);
			await main.execute("team_send_message", { targets: ["x"], message: "Continue." });
			await main.waitFor("the manager's next turn", () => main.modelRequests.length === 4);
			assert.equal(main.modelRequests[3]!.model, "b");
			assert.match(conversationText(main.modelRequests[3]!), /Main changed your configuration: model: local\/b\.[\s\S]*Your restart stopped the teams you manage: "sub" \(team ID: [^)]+-sub\)\.[\s\S]*Resume them with team_resume when you continue\./, "The restarted manager must learn its settings and which teams to resume.");
		});
	});

	test("a team another main resumed counts as that main's, not the manager's", async () => {
		await withMain(async (main) => {
			await main.spawn(false, [{ name: "x", canManageOwnTeams: true }]);
			const { teammate } = (await finishFirstTurns(main)).get("x")!;
			storeManagedTeam(main, teammate.teammateId, true, "another main");
			const result = await main.execute("team_update_teammates", { teammates: [{ teammate: "x", thinking: "high" }] });
			assert.deepEqual([(result.details.teammates as TeammateRecord[])[0]!.held, (result.details.teammates as TeammateRecord[])[0]!.thinking], [false, "high"]);
		});
	});

	test("teams left active behind a stale lease, as a dead manager leaves them, do not block its update", async () => {
		await withMain(async (main) => {
			await main.spawn(false, [{ name: "x", canManageOwnTeams: true }]);
			const { teammate } = (await finishFirstTurns(main)).get("x")!;
			storeManagedTeam(main, teammate.teammateId, true, "stale");
			const result = await main.execute("team_update_teammates", { teammates: [{ teammate: "x", thinking: "high" }] });
			assert.deepEqual([(result.details.teammates as TeammateRecord[])[0]!.held, (result.details.teammates as TeammateRecord[])[0]!.thinking], [false, "high"]);
		});
	});
});

realPi("team_resume changes stopped teammates as they resume", () => {
	test("a resumed teammate runs on the new settings in its saved conversation, and keeps them on a later resume", async () => {
		await withMain(async (main) => {
			await main.spawn(false);
			const before = (await finishFirstTurns(main)).get("x")!;
			await main.execute("team_shutdown", { team: teamName });
			await assert.rejects(main.execute("team_update_teammates", { team: teamName, teammates: [{ teammate: "x", model: "local/b" }] }), /team_resume/);
			await main.execute("team_resume", { team: teamName, teammateUpdates: [{ teammate: "x", model: "local/b", thinking: "high" }], resumptionPrompt: "You now run on model b." });
			await main.waitFor("the resumed turn", () => main.modelRequests.length === 2);
			assert.deepEqual([main.modelRequests[1]!.model, main.modelRequests[1]!.reasoning_effort], ["b", "high"]);
			assert.match(conversationText(main.modelRequests[1]!), /Answer\.[\s\S]*Done\.[\s\S]*You now run on model b\.[\s\S]*Main changed your configuration: model: local\/b, thinking: high\./, "The resumed teammate must learn its new settings after the resumption prompt.");
			await main.waitFor("an idle resumed teammate", async () => !(await main.listed()).active);
			const after = await main.listed();
			assert.equal(after.teammateId, before.teammate.teammateId);
			assert.deepEqual(fs.readFileSync(after.sessionFile).subarray(0, before.sessionBytes.length), before.sessionBytes);
			assert.deepEqual([after.model, after.thinking], ["local/b", "high"]);
			await main.execute("team_shutdown", { team: teamName });
			await main.execute("team_resume", { team: teamName, resumptionPrompt: "Again." });
			await main.waitFor("the plain resumed turn", () => main.modelRequests.length === 3);
			assert.deepEqual([main.modelRequests[2]!.model, main.modelRequests[2]!.reasoning_effort], ["b", "high"], "A later resume must keep the new settings.");
		});
	});

	test("rejects updates for teammates the call does not resume", async () => {
		await withMain(async (main) => {
			await main.spawn(true);
			await main.waitFor("a registered teammate", async () => (await main.listed()).live);
			await assert.rejects(main.execute("team_resume", { team: teamName, teammateUpdates: [{ teammate: "x", model: "local/b" }] }), /Teammate "x" is running\. Use team_update_teammates/);
		});
	});
});

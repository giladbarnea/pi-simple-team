import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "bun:test";
import { fauxAssistantMessage, validateToolArguments } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import teamExtension from "../index.ts";
import { claimTeamLease, releaseTeamLease } from "../team-registry.ts";
import { loadAsBunStandalonePi, useEnvironment } from "./pi-launch.ts";

type JsonRecord = Record<string, unknown>;
type ToolResult = { content: Array<{ type: string; text: string }>; details: JsonRecord };
type RegisteredTool = { name: string; parameters: object; execute: (id: string, params: JsonRecord, signal: AbortSignal, update: undefined, context: ExtensionContext) => Promise<ToolResult> };
type Member = { name: string; teammateId: string; sessionFile: string; model: string; thinking: string; live: boolean; active: boolean; contextRestored?: boolean };
type ModelRequest = { model: string; reasoning_effort?: string; messages: unknown[] };

async function withMain(run: (main: Awaited<ReturnType<typeof startMain>>, directory: string) => Promise<void>): Promise<void> {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-attachment-"));
	const main = await startMain(directory);
	try {
		await run(main, directory);
	} finally {
		await main.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

async function startMain(directory: string) {
	const agentDirectory = path.join(directory, "agent");
	const projectDirectory = path.join(directory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);
	const requests: ModelRequest[] = [];
	const notices: string[] = [];
	const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request: Request): Promise<Response> => {
		requests.push(await request.json() as ModelRequest);
		const chunk = (delta: JsonRecord, finish_reason: string | null) => `data: ${JSON.stringify({ id: "attachment", object: "chat.completion.chunk", created: 1, model: "a", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
		return new Response(chunk({ role: "assistant", content: "Attached." }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	} });
	fs.writeFileSync(path.join(agentDirectory, "models.json"), JSON.stringify({ providers: { local: {
		baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", apiKey: "local-fixture",
		models: ["a", "b"].map((id) => ({ id, name: id, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 })),
	} } }));
	fs.writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "a", defaultThinkingLevel: "medium", compaction: { enabled: false }, retry: { enabled: false } }));
	const executable = Bun.which("pi");
	assert.ok(executable, "Run attachment tests with a pinned Pi on PATH.");
	const launcher = path.join(directory, "pi-launcher");
	fs.writeFileSync(launcher, `#!/bin/sh\nexec '${executable.replaceAll("'", "'\\''")}' --no-skills --no-context-files "$@"\n`, { mode: 0o755 });
	const restore = useEnvironment({ PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1" });
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, Array<(event: JsonRecord, context: ExtensionContext) => Promise<void>>>();
	const context = {
		cwd: projectDirectory, scopedModels: [], modelRegistry: { getAvailable: () => [{ provider: "local", id: "a" }, { provider: "local", id: "b" }] },
		sessionManager: { getCwd: () => projectDirectory, getSessionId: () => "attachment-main", getSessionFile: () => path.join(directory, "main.jsonl"), getEntries: () => [] },
	} as unknown as ExtensionContext;
	const api = {
		on: (event: string, handler: (event: JsonRecord, context: ExtensionContext) => Promise<void>) => handlers.set(event, [...handlers.get(event) ?? [], handler]),
		registerCommand: () => undefined, registerMessageRenderer: () => undefined,
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		sendMessage: (message: { content: string }) => notices.push(message.content),
	} as unknown as ExtensionAPI;
	loadAsBunStandalonePi(launcher, () => teamExtension(api));
	const emit = async (event: string, payload: JsonRecord): Promise<void> => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, context);
	};
	await emit("session_start", { reason: "startup" });
	const execute = async (name: string, params: JsonRecord): Promise<ToolResult> => {
		const tool = tools.get(name)!;
		validateToolArguments(tool as Parameters<typeof validateToolArguments>[0], { type: "toolCall", id: name, name, arguments: params });
		return tool.execute(name, params, new AbortController().signal, undefined, context);
	};
	return {
		projectDirectory, agentDirectory, requests, notices, tools, execute, emit,
		spawn: (teammates: JsonRecord[], teamName = "imported", startIdle = true) => execute("team_spawn", { teamName, commonPrompt: "New team assignment.", startIdle, teammates }),
		waitFor: async (condition: () => boolean | Promise<boolean>): Promise<void> => {
			for (let attempt = 0; attempt < 1000; attempt++) {
				if (await condition()) return;
				await Bun.sleep(10);
			}
			assert.fail(`Attachment did not settle. Notices: ${JSON.stringify(notices)}`);
		},
		close: async (): Promise<void> => { await emit("session_shutdown", { reason: "new" }); provider.stop(true); restore(); },
	};
}

function ordinarySession(projectDirectory: string, id: string): SessionManager {
	const session = SessionManager.create(projectDirectory, undefined, { id });
	session.appendModelChange("local", "a");
	session.appendThinkingLevelChange("low");
	session.appendMessage({ role: "user", content: "Remember the ordinary conversation's secret: violet telescope.", timestamp: Date.now() });
	session.appendMessage({ ...fauxAssistantMessage("I remember violet telescope."), provider: "local", model: "a" });
	return session;
}

const attachmentTest = test.skipIf(process.env.PI_SIMPLE_TEAM_TEST_REAL_PI !== "1");

attachmentTest("completed reminders and inherited records permit non-idle attachment, whose first request has the new assignment", async () => {
	await withMain(async (main) => {
		const session = ordinarySession(main.projectDirectory, "ordinary-completed");
		const record = { sessionId: session.getSessionId(), id: "reminder-1", slug: "amber-beacon", message: "Old work.", armedAt: "1999-01-01T00:00:00Z", wakeAt: "2000-01-01T00:00:00Z", state: "pending" };
		session.appendCustomEntry("pi-simple-team-reminder", record);
		session.appendCustomEntry("pi-simple-team-reminder", { ...record, state: "cancelled" });
		session.appendCustomEntry("pi-simple-team-reminder", { ...record, id: "reminder-2", state: "delivered" });
		session.appendCustomEntry("pi-simple-team-reminder", { ...record, sessionId: "inherited-origin" });
		session.appendCustomEntry("pi-simple-team-teammate", { sessionId: "inherited-origin", teamId: "past-team", parentSessionId: "past-main" });
		const original = fs.readFileSync(session.getSessionFile()!);
		await main.spawn([{ name: "historian", systemPrompt: "Use the saved history.", session: session.getSessionFile(), canManageOwnTeams: true }], "imported", false);
		await main.waitFor(() => main.requests.length === 1);
		assert.match(JSON.stringify(main.requests[0].messages), /violet telescope[\s\S]*New team assignment\.[\s\S]*Use the saved history/);
		assert.deepEqual(fs.readFileSync(session.getSessionFile()!).subarray(0, original.length), original);
		assert.equal(main.requests.length, 1, "Completed and copied reminders must not wake independently.");
	});
}, 20000);

attachmentTest("a live main lease without a materialized team manifest blocks import and names its place", async () => {
	await withMain(async (main) => {
		const session = ordinarySession(main.projectDirectory, "ordinary-main");
		const lease = claimTeamLease("ordinary-main-owned-team", session.getSessionId());
		try {
			await assert.rejects(main.spawn([{ name: "x", systemPrompt: "Wait.", session: session.getSessionId() }]), /ordinary-main[\s\S]*live[\s\S]*ordinary-main-owned-team/);
		} finally {
			releaseTeamLease(lease);
		}
	});
}, 20000);

attachmentTest("failed startup releases a reservation only after its child exits, without stranding an unresolved member", async () => {
	await withMain(async (main, directory) => {
		const session = ordinarySession(main.projectDirectory, "ordinary-failed");
		const started = path.join(directory, "failed-pid");
		const extension = path.join(directory, "fail.ts");
		fs.writeFileSync(extension, `import fs from 'node:fs'; export default function () { fs.writeFileSync(${JSON.stringify(started)}, String(process.pid)); process.exit(1); }`);
		await assert.rejects(main.spawn([{ name: "failed", systemPrompt: "Wait.", session: session.getSessionId(), extensionPaths: [extension] }]), /failed exited/);
		assert.throws(() => process.kill(Number(fs.readFileSync(started, "utf8")), 0), /ESRCH/, "Rollback must wait for the child to exit.");
		const result = await main.spawn([{ name: "retry", systemPrompt: "Wait.", session: session.getSessionId() }]);
		assert.equal((result.details.teammates as Member[])[0].teammateId, "ordinary-failed", "A known-stopped failed startup must not strand the reservation.");
	});
}, 20000);

for (const operation of ["spawn", "add"] as const) attachmentTest(`a registered import survives a later ${operation} startup failure and resumes with its new briefing`, async () => {
	await withMain(async (main, directory) => {
		if (operation === "add") await main.spawn([{ name: "existing", systemPrompt: "Wait.", model: "local/a" }]);
		const session = ordinarySession(main.projectDirectory, `survivor-${operation}`);
		const original = fs.readFileSync(session.getSessionFile()!);
		const extension = path.join(directory, "fail-second.ts");
		fs.writeFileSync(extension, "export default function () { process.exit(1); }");
		const teammates = [
			{ name: "survivor", systemPrompt: "Use the preserved history.", session: session.getSessionId() },
			{ name: "failed", systemPrompt: "Wait.", model: "local/a", extensionPaths: [extension] },
			{ name: "unstarted", systemPrompt: "Wait.", session: `unstarted-${operation}` },
		];
		const attempt = operation === "spawn" ? main.spawn(teammates, "imported", false) : main.execute("team_add_teammates", { team: "imported", teammates });
		await assert.rejects(attempt, /failed exited/);
		assert.deepEqual(fs.readFileSync(session.getSessionFile()!).subarray(0, original.length), original);
		assert.match(fs.readFileSync(session.getSessionFile()!, "utf8"), /pi-simple-team-teammate/, "The registered child has already acquired its immutable team provenance.");
		const listing = await main.execute("team_list", { includeDormantTeams: true });
		const team = (listing.details.teams as Array<{ teamId: string; state: string; teammates: Member[] }>).find((candidate) => candidate.teammates.some((member) => member.teammateId === session.getSessionId()));
		assert.ok(team, `The registered import must remain resumable after ${operation} fails: ${JSON.stringify(listing.details)}`);
		assert.deepEqual(team.teammates.map(({ name, live }) => ({ name, live })), operation === "spawn" ? [{ name: "survivor", live: false }] : [{ name: "existing", live: true }, { name: "survivor", live: false }]);
		assert.equal(team.state, operation === "spawn" ? "dormant" : "active");
		assert.equal(main.requests.length, 0, "The incomplete batch must not start any model work.");
		const recovered = await main.execute("team_resume", { team: team.teamId, teammates: [session.getSessionId()], startIdle: true });
		const survivor = (recovered.details.teammates as Member[]).find((member) => member.name === "survivor")!;
		assert.deepEqual([survivor.teammateId, survivor.sessionFile, survivor.contextRestored], [session.getSessionId(), session.getSessionFile(), true]);
		assert.equal(main.requests.length, 0, "Recovery must stage instructions without waking the old work.");
		await main.execute("team_send_message", { targets: [session.getSessionId()], message: "Continue after recovery." });
		await main.waitFor(() => main.requests.length === 1);
		const first = JSON.stringify(main.requests[0].messages);
		assert.match(first, /violet telescope[\s\S]*New team assignment\.[\s\S]*Use the preserved history\.[\s\S]*Continue after recovery/);
		assert.equal(first.match(/<team-system-message>/g)?.length, 1, "Recovery must initialize the full team briefing before its first request.");
		await main.waitFor(async () => {
			const result = await main.execute("team_list", { team: team.teamId });
			return !(result.details.teams as Array<{ teammates: Member[] }>)[0].teammates.find((member) => member.name === "survivor")!.active;
		});
		await main.execute("team_shutdown", { team: team.teamId });
		await main.execute("team_resume", { team: team.teamId, teammates: [session.getSessionId()], startIdle: true });
		await main.execute("team_send_message", { targets: [session.getSessionId()], message: "A later ordinary resume." });
		await main.waitFor(() => main.requests.length === 2);
		assert.equal(JSON.stringify(main.requests[1].messages).match(/<team-system-message>/g)?.length, 1, "A later normal resume must inherit the already delivered briefing, not repeat it.");
		assert.deepEqual(fs.readFileSync(session.getSessionFile()!).subarray(0, original.length), original);
	});
}, 20000);

attachmentTest("self, fork conflicts, foreign projects and invalid files refuse with their current place before startup", async () => {
	await withMain(async (main, directory) => {
		const ordinary = ordinarySession(main.projectDirectory, "ordinary-conflict");
		const foreignProject = path.join(directory, "foreign");
		fs.mkdirSync(foreignProject);
		const foreign = ordinarySession(foreignProject, "foreign-session");
		const empty = path.join(directory, "empty.jsonl");
		const invalid = path.join(directory, "invalid.jsonl");
		fs.writeFileSync(empty, "");
		fs.writeFileSync(invalid, "not json\n");
		for (const [session, extra, expected] of [
			["attachment-main", {}, /attachment-main.*(current|main|own)/i],
			[ordinary.getSessionId(), { forkContext: true }, /session.*forkContext/],
			[foreign.getSessionFile(), {}, /foreign-session.*belongs to project.*foreign/],
			[empty, {}, /empty.jsonl.*(header|empty|valid)/],
			[invalid, {}, /invalid.jsonl.*(JSON|valid)/],
			[path.join(directory, "missing.jsonl"), {}, /missing.jsonl/],
			["relative/session.jsonl", {}, /relative.session.jsonl.*project/],
		] as Array<[string, JsonRecord, RegExp]>) await assert.rejects(main.spawn([{ name: "x", systemPrompt: "Wait.", session, ...extra }]), expected);
		assert.equal(main.requests.length, 0);
		assert.deepEqual((await main.execute("team_status", {})).details.teams, []);
	});
}, 20000);

attachmentTest("an uncertain pending import survives expiry and refuses explicit resume and automatic reattachment", async () => {
	await withMain(async (main) => {
		const session = ordinarySession(main.projectDirectory, "ordinary-uncertain");
		await main.spawn([{ name: "historian", systemPrompt: "Wait.", session: session.getSessionId() }]);
		const prefix = path.join(main.agentDirectory, "pi-simple-team", "teams-v2", "attachment-main-imported");
		const lease = JSON.parse(fs.readFileSync(prefix + ".lease", "utf8"));
		await main.execute("team_shutdown", { team: "imported" });
		const manifest = JSON.parse(fs.readFileSync(prefix + ".json", "utf8"));
		manifest.members[0].importPending = true;
		manifest.expiresAt = "2000-01-01T00:00:00Z";
		fs.writeFileSync(prefix + ".json", JSON.stringify(manifest));
		const listed = await main.execute("team_list", { includeDormantTeams: true });
		assert.equal((listed.details.teams as unknown[]).length, 1, "An unknown writer must not be forgotten by TTL expiry.");
		await assert.rejects(main.execute("team_resume", { team: "imported", startIdle: true }), /ordinary-uncertain[\s\S]*import pending[\s\S]*attachment-main-imported/i);
		manifest.state = "active";
		manifest.members[0].live = true;
		fs.writeFileSync(prefix + ".json", JSON.stringify(manifest));
		fs.writeFileSync(prefix + ".lease", JSON.stringify({ ...lease, processId: 2147483647 }));
		await main.emit("session_start", { reason: "startup" });
		assert.deepEqual((await main.execute("team_status", {})).details.teams, []);
		assert.match(main.notices.join("\n"), /ordinary-uncertain[\s\S]*import pending[\s\S]*attachment-main-imported/i);
		assert.doesNotMatch(main.notices.join("\n"), /Use team_resume to restart it/, "An unresolved import must not recommend a resume that it refuses.");
		assert.equal(main.requests.length, 0);
	});
}, 20000);

attachmentTest("retained and former team ownership refusals name the session, team and main", async () => {
	await withMain(async (main) => {
		const session = ordinarySession(main.projectDirectory, "ordinary-owned");
		await main.spawn([{ name: "historian", systemPrompt: "Wait.", session: session.getSessionId() }], "original");
		await main.execute("team_shutdown", { team: "original" });
		const bytes = fs.readFileSync(session.getSessionFile()!);
		const refused = async (): Promise<void> => assert.rejects(main.spawn([{ name: "moved", systemPrompt: "Wait.", session: session.getSessionId() }], "destination"), (error: Error) => {
			for (const fact of ["ordinary-owned", "attachment-main-original", "attachment-main"]) assert.ok(error.message.includes(fact), error.message);
			return true;
		});
		await refused();
		fs.rmSync(path.join(main.agentDirectory, "pi-simple-team", "teams-v2", "attachment-main-original.json"));
		await refused();
		assert.deepEqual(fs.readFileSync(session.getSessionFile()!), bytes);
	});
}, 20000);

attachmentTest("two overlapping ID/path imports reserve once before either child registers", async () => {
	await withMain(async (main, directory) => {
		const session = ordinarySession(main.projectDirectory, "ordinary-race");
		const gate = path.join(directory, "gate");
		const started = path.join(directory, "started");
		const extension = path.join(directory, "gate.ts");
		fs.writeFileSync(extension, `import fs from 'node:fs'; export default async function () { fs.writeFileSync(${JSON.stringify(started)}, String(process.pid)); while (!fs.existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 10)); }`);
		const first = main.spawn([{ name: "winner", systemPrompt: "Wait.", session: session.getSessionId(), extensionPaths: [extension] }], "first");
		const outcome = first.then((value) => ({ value }), (error: Error) => ({ error }));
		try {
			await main.waitFor(() => fs.existsSync(started));
			await assert.rejects(main.spawn([{ name: "loser", systemPrompt: "Wait.", session: session.getSessionFile() }], "second"), /ordinary-race[\s\S]*(reserved|pending|listed)[\s\S]*attachment-main-first/i);
			const worker = Bun.spawn([process.execPath, path.join(import.meta.dir, "session-attachment-worker.ts"), main.projectDirectory, session.getSessionFile()!, path.join(directory, "pi-launcher")], { env: process.env, stdout: "pipe", stderr: "pipe" });
			const output = await new Response(worker.stdout).text();
			const stderr = await new Response(worker.stderr).text();
			assert.equal(await worker.exited, 0, stderr);
			assert.match(JSON.parse(output).error ?? "", /ordinary-race[\s\S]*reserved[\s\S]*attachment-main-first/, `A separate parent process must refuse the same reservation: ${output}`);
		} finally {
			fs.writeFileSync(gate, "open");
			const settled = await outcome;
			assert.ok("value" in settled, JSON.stringify(settled));
		}
		const listed = await main.execute("team_list", { includeDormantTeams: true });
		assert.equal((listed.details.teams as unknown[]).length, 1, "Only the winning team may have launched a child.");
		assert.equal(main.requests.length, 0);
	});
}, 20000);

for (const due of ["2000-01-01T00:00:00Z", "2099-01-01T00:00:00Z"]) attachmentTest(`pending reminder due ${due} refuses the whole batch read-only before loading or starting siblings`, async () => {
	await withMain(async (main) => {
		const session = ordinarySession(main.projectDirectory, "ordinary-reminder");
		session.appendCustomEntry("pi-simple-team-reminder", { sessionId: session.getSessionId(), id: "reminder-1", slug: "amber-beacon", message: "Old work must not wake.", armedAt: "1999-01-01T00:00:00Z", wakeAt: due, state: "pending" });
		session.branch(session.getEntries().find((entry) => entry.type === "message")!.id);
		session.appendCustomEntry("active-branch", {});
		const file = session.getSessionFile()!;
		fs.writeFileSync(file, fs.readFileSync(file, "utf8").trimEnd());
		const original = fs.readFileSync(file);
		await assert.rejects(main.spawn([{ name: "sibling", systemPrompt: "Wait.", model: "local/a" }, { name: "historian", systemPrompt: "Wait.", session: file, model: "local/b", thinking: "high", canManageOwnTeams: true }]), (error: Error) => {
			for (const fact of ["ordinary-reminder", file, "1 pending reminder", "reminder-1", "amber-beacon"]) assert.ok(error.message.includes(fact), `Refusal must include ${fact}: ${error.message}`);
			return true;
		});
		assert.deepEqual(fs.readFileSync(file), original, "Refusal must not even repair the missing final newline.");
		assert.equal(main.requests.length, 0, "Neither old reminders nor new siblings may start work.");
		assert.deepEqual((await main.execute("team_status", {})).details.teams, [], "The rejected batch must leave no team runtime.");
	});
}, 20000);

attachmentTest("spawn attaches a never-teamed exact ID, preserving history and settings and staging the new briefing without a turn", async () => {
	await withMain(async (main) => {
		const session = ordinarySession(main.projectDirectory, "ordinary-exact");
		const original = fs.readFileSync(session.getSessionFile()!);
		const result = await main.spawn([{ name: "historian", systemPrompt: "Explain previous decisions.", session: session.getSessionId() }]);
		const [member] = result.details.teammates as Member[];
		assert.deepEqual([member.teammateId, member.sessionFile, member.contextRestored, member.model, member.thinking], ["ordinary-exact", session.getSessionFile(), true, "local/a", "low"]);
		assert.deepEqual(fs.readFileSync(member.sessionFile).subarray(0, original.length), original, "Attachment must append without rewriting conversation history.");
		assert.equal(main.requests.length, 0, "startIdle must not wake old work.");
		await main.execute("team_send_message", { targets: [member.teammateId], message: "What do you remember?" });
		await main.waitFor(() => main.requests.length === 1);
		assert.match(JSON.stringify(main.requests[0].messages), /violet telescope[\s\S]*New team assignment\.[\s\S]*Explain previous decisions\.[\s\S]*What do you remember/);
	});
}, 20000);

attachmentTest("add attaches an absolute JSONL path and appends explicit settings without losing the selected branch", async () => {
	await withMain(async (main) => {
		await main.spawn([]);
		const session = ordinarySession(main.projectDirectory, "ordinary-path");
		const savedLeaf = session.getLeafId()!;
		session.appendMessage({ role: "user", content: "ABANDONED_BRANCH_MUST_NOT_REPLAY", timestamp: Date.now() });
		session.branch(savedLeaf);
		session.appendCustomEntry("active-branch", {});
		const original = fs.readFileSync(session.getSessionFile()!);
		const result = await main.execute("team_add_teammates", { team: "imported", startIdle: true, teammates: [{ name: "historian", systemPrompt: "Use the saved history.", session: session.getSessionFile(), model: "local/b", thinking: "high" }] });
		const [member] = result.details.teammates as Member[];
		assert.deepEqual([member.teammateId, member.sessionFile, member.contextRestored], ["ordinary-path", session.getSessionFile(), true]);
		assert.deepEqual(fs.readFileSync(member.sessionFile).subarray(0, original.length), original);
		assert.equal(main.requests.length, 0);
		await main.execute("team_send_message", { targets: ["historian"], message: "Continue." });
		await main.waitFor(() => main.requests.length === 1);
		assert.deepEqual([main.requests[0].model, main.requests[0].reasoning_effort], ["b", "high"]);
		assert.match(JSON.stringify(main.requests[0].messages), /violet telescope/);
		assert.doesNotMatch(JSON.stringify(main.requests[0].messages), /ABANDONED_BRANCH_MUST_NOT_REPLAY/);
	});
}, 20000);

attachmentTest("a missing exact ID uses Pi defaults and keeps that ID through a never-materialized shutdown and resume", async () => {
	await withMain(async (main) => {
		ordinarySession(main.projectDirectory, "short-prefix-longer");
		const result = await main.spawn([{ name: "newcomer", systemPrompt: "Wait.", session: "short-prefix" }]);
		const [member] = result.details.teammates as Member[];
		assert.deepEqual([member.teammateId, member.contextRestored, member.model, member.thinking], ["short-prefix", false, "local/a", "medium"]);
		assert.equal(fs.existsSync(member.sessionFile), false, "Idle setup follows Pi's ordinary delayed materialization.");
		await main.execute("team_shutdown", { team: "imported" });
		const resumed = await main.execute("team_resume", { team: "imported", startIdle: true });
		const [restarted] = resumed.details.teammates as Member[];
		assert.equal(restarted.teammateId, "short-prefix");
		assert.equal(main.requests.length, 0);
		await main.execute("team_send_message", { targets: ["newcomer"], message: "Make this ID durable." });
		await main.waitFor(() => main.requests.length === 1 && fs.existsSync(restarted.sessionFile));
		assert.equal(JSON.parse(fs.readFileSync(restarted.sessionFile, "utf8").split("\n")[0]).id, "short-prefix");
	});
}, 20000);

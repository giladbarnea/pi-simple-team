import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readChildRuntimeConfig } from "../child-tools.ts";
import teamExtension from "../index.ts";
import { loadAsBunStandalonePi } from "./pi-launch.ts";
import type { TeamLogEntry } from "../teamlog.ts";

type JsonRecord = Record<string, unknown>;
type ToolResult = { content: Array<{ type: string; text: string }>; details: JsonRecord };
type RegisteredTool = { name: string; execute: (id: string, params: JsonRecord, signal: AbortSignal, update: undefined, context: unknown) => Promise<ToolResult> };
type ModelMessage = { role: string; content: unknown };
type ModelRequest = { messages: ModelMessage[]; tools?: Array<{ function?: { name?: string } }> };
type TeammateListing = { name: string; teammateId: string; sessionFile: string; live: boolean; active: boolean };

const extensionPath = path.resolve(import.meta.dir, "..", "index.ts");
const model = "local-nested/probe";

/** @example quote("it's") // "'it'\\''s'" */
function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		if (await check()) return;
		await Bun.sleep(50);
	}
	assert.fail(`Timed out waiting for ${label}`);
}

/** @example messageText({ role: "user", content: [{ type: "text", text: "hi" }] }) // "hi" */
function messageText(message: ModelMessage | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return (message.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");
}

function lastUserText(request: ModelRequest): string {
	return messageText(request.messages.findLast((message) => message.role === "user"));
}

/** The local model acts out each `TOOL <name> <json arguments>` line of the latest user message, one call per step, then answers. */
function scriptedReply(request: ModelRequest): { delta: JsonRecord; finishReason: string } {
	const lastUser = request.messages.findLastIndex((message) => message.role === "user");
	const steps = [...messageText(request.messages[lastUser]).matchAll(/^TOOL (\S+) (.+)$/gm)];
	const step = request.messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
	const directive = steps[step];
	if (!directive) return { delta: { content: "Done." }, finishReason: "stop" };
	return { delta: { tool_calls: [{ index: 0, id: `call-${step}`, type: "function", function: { name: directive[1], arguments: directive[2] } }] }, finishReason: "tool_calls" };
}

/** A disposable Pi agent directory with one scripted local model, and pi-simple-team loaded as main in this process. */
function startHarness() {
	assert.deepEqual(Object.keys(process.env).filter((name) => name.startsWith("PI_SIMPLE_TEAM_") && name !== "PI_SIMPLE_TEAM_TEST_REAL_PI"), [], "Run nested-process tests without live team routing or credentials.");
	const executable = Bun.which("pi");
	assert.ok(executable, "The real-Pi check requires Pi on PATH.");
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-nested-"));
	const agentDirectory = path.join(directory, "agent");
	fs.mkdirSync(agentDirectory);
	const requests: ModelRequest[] = [];
	const provider = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request: Request): Promise<Response> {
			const body = await request.json() as ModelRequest;
			requests.push(body);
			const { delta, finishReason } = scriptedReply(body);
			const chunk = (payload: JsonRecord, reason: string | null): string => `data: ${JSON.stringify({ id: "nested-probe", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta: payload, finish_reason: reason }] })}\n\n`;
			return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, finishReason) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		},
	});
	fs.writeFileSync(path.join(agentDirectory, "models.json"), JSON.stringify({ providers: { "local-nested": {
		baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", apiKey: "local-fixture",
		models: [{ id: "probe", name: "Nested probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
	} } }));
	fs.writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
	const launcher = path.join(directory, "pi-launcher");
	fs.writeFileSync(launcher, `#!/bin/sh\nexec ${quote(executable)} --no-skills --no-context-files --no-prompt-templates --no-themes "$@"\n`, { mode: 0o755 });
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	const previousOffline = process.env.PI_OFFLINE;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.PI_OFFLINE = "1";
	const tools = new Map<string, RegisteredTool>();
	const shutdownHandlers: Array<() => Promise<void>> = [];
	const mainMessages: string[] = [];
	const context = {
		cwd: directory, scopedModels: [], getContextUsage: () => ({ tokens: 0, contextWindow: 32000, percent: 0 }),
		modelRegistry: { getAvailable: () => [{ provider: "local-nested", id: "probe" }] },
		sessionManager: { getCwd: () => directory, getSessionId: () => "nested-main", getSessionFile: () => path.join(directory, "main.jsonl") },
	};
	const api = {
		on: (event: string, handler: (event: JsonRecord, context: unknown) => Promise<void>) => {
			if (event === "session_start") void handler({ reason: "startup" }, context);
			if (event === "session_shutdown") shutdownHandlers.push(() => handler({ reason: "quit" }, context));
		},
		registerCommand: () => undefined, registerMessageRenderer: () => undefined,
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		sendMessage: (message: { content: string }) => { mainMessages.push(message.content); },
	} as unknown as ExtensionAPI;
	const execute = async (name: string, parameters: JsonRecord): Promise<ToolResult> => {
		const tool = tools.get(name);
		assert.ok(tool, `Missing tool ${name}`);
		return tool.execute("nested-probe", parameters, new AbortController().signal, undefined, context);
	};
	loadAsBunStandalonePi(launcher, () => teamExtension(api));
	return {
		execute, requests, mainMessages,
		/** A shell command that starts a nested Pi process with pi-simple-team loaded, as a teammate's script would. */
		nestedPiCommand: (prompt: string): string => [launcher, "--no-extensions", "-e", extensionPath, "--model", model, "-p", prompt].map(quote).join(" "),
		teammate: async (team: string, name: string): Promise<TeammateListing> => {
			const listing = await execute("team_list", {});
			const listed = (listing.details.teams as Array<{ teamName: string; teammates: TeammateListing[] }>).find((candidate) => candidate.teamName === team);
			const teammate = listed?.teammates.find((candidate) => candidate.name === name);
			assert.ok(teammate, `Team ${team} must list ${name}. Listing: ${JSON.stringify(listing.details)}`);
			return teammate;
		},
		log: async (target: string): Promise<TeamLogEntry[]> => (await execute("team_log", { targets: [target], limit: 100 })).details.entries as TeamLogEntry[],
		close: async (): Promise<void> => {
			for (const shutdown of shutdownHandlers) await shutdown();
			provider.stop(true);
			if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
			if (previousOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previousOffline;
			fs.rmSync(directory, { recursive: true, force: true });
		},
	};
}

function toolLine(name: string, parameters: JsonRecord): string {
	return `TOOL ${name} ${JSON.stringify(parameters)}`;
}

test("a subprocess inherits the team environment but not the teammate identity", () => {
	const environment = {
		PI_SIMPLE_TEAM_CHILD: "1",
		PI_SIMPLE_TEAM_CALLBACK_URL: "http://127.0.0.1:1/callback",
		PI_SIMPLE_TEAM_CALLBACK_TOKEN: "unused",
		PI_SIMPLE_TEAM_TEAM: "claim-team-id",
		PI_SIMPLE_TEAM_TEAM_NAME: "claim-team",
		PI_SIMPLE_TEAM_MEMBER: "probe",
		PI_SIMPLE_TEAM_PARTICIPANTS: JSON.stringify(["probe"]),
		PI_SIMPLE_TEAM_CAN_MANAGE_OWN_TEAMS: "0",
	};
	const previousEnvironment = Object.fromEntries(Object.keys(environment).map((name) => [name, process.env[name]]));
	Object.assign(process.env, environment);
	try {
		assert.equal(readChildRuntimeConfig()?.teammateName, "probe", "The process that main starts is the teammate.");
		assert.equal(readChildRuntimeConfig()?.teammateName, "probe", "Pi reloads extensions in the same process, which must stay the teammate.");
		const childToolsPath = path.resolve(import.meta.dir, "..", "child-tools.ts");
		const nested = spawnSync(process.execPath, ["--eval", `const { readChildRuntimeConfig } = await import(${JSON.stringify(childToolsPath)}); console.log(JSON.stringify(readChildRuntimeConfig() ?? null));`], { env: process.env, encoding: "utf8" });
		assert.equal(nested.status, 0, nested.stderr);
		assert.equal(nested.stdout.trim(), "null", "A process that the teammate starts must not load as the teammate.");
	} finally {
		for (const [name, value] of Object.entries(previousEnvironment)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

describe.skipIf(process.env.PI_SIMPLE_TEAM_TEST_REAL_PI !== "1")("nested Pi processes started by a teammate", () => {
	test("leave the teammate's identity, delivery, liveness, status, and log with the real teammate", async () => {
		const harness = startHarness();
		try {
			const teammate = (name: string) => ({ name, model, thinking: "low", systemPrompt: "Act out each TOOL line." });
			await harness.execute("team_spawn", { teamName: "nested", startIdle: true, commonPrompt: "Follow main.", teammates: [teammate("probe"), teammate("peer")] });
			const spawned = await harness.teammate("nested", "probe");
			await harness.execute("team_send_message", { targets: ["probe"], message: [
				toolLine("bash", { command: harness.nestedPiCommand("NESTED_PROMPT") }),
				toolLine("team_send_message", { targets: ["peer"], message: "PEER_PING" }),
				toolLine("send_main_message", { message: "PROBE_STILL_ALIVE" }),
			].join("\n") });
			await waitFor(async () => harness.mainMessages.some((message) => message.includes("PROBE_STILL_ALIVE")) && !(await harness.teammate("nested", "probe")).active, "the real teammate to finish after its nested Pi process exited");
			await waitFor(() => harness.requests.some((request) => lastUserText(request).includes("PEER_PING")), "the peer to receive the teammate's message");

			const nested = harness.requests.find((request) => lastUserText(request) === "NESTED_PROMPT");
			assert.ok(nested, "The fixture must actually run the nested Pi process.");
			const nestedTools = (nested.tools ?? []).map((tool) => tool.function?.name);
			assert.ok(nestedTools.includes("team_spawn") && !nestedTools.includes("send_main_message"), `A nested Pi process loads pi-simple-team as an ordinary main session, not as the teammate. Its tools: ${JSON.stringify(nestedTools)}`);

			const afterNested = await harness.teammate("nested", "probe");
			assert.deepEqual({ teammateId: afterNested.teammateId, sessionFile: afterNested.sessionFile, live: afterNested.live }, { teammateId: spawned.teammateId, sessionFile: spawned.sessionFile, live: true }, "The registry must keep the real teammate's identity and liveness.");
			const status = (await harness.execute("team_status", { team: "nested" })).details.status as Record<string, { word: string; phrase: string }>;
			assert.notEqual(status.probe?.word, "stopped", `A nested process exit must not stop the teammate. Status: ${JSON.stringify(status.probe)}`);
			const probeLog = await harness.log("probe");
			assert.deepEqual(probeLog.filter((entry) => entry.kind === "exit"), [], "The teammate log must not record the nested process exit.");
			assert.equal(probeLog.filter((entry) => entry.kind === "agent_start").length, 1, "The teammate log must contain only the real teammate's run.");

			await harness.execute("team_send_message", { targets: ["probe"], message: "MAIN_PING" });
			await waitFor(() => fs.readFileSync(spawned.sessionFile, "utf8").includes("MAIN_PING"), "main's message to reach the real teammate's session");
			const usage = (await harness.execute("get_context_window_usage", { targets: ["probe"] })).content[0].text;
			assert.match(usage, new RegExp(`Teammate probe \\(Pi session ID: ${spawned.teammateId}\\).* has .*\\d+%`), "Main must read the real teammate's context usage.");
		} finally {
			await harness.close();
		}
	}, 60000);

	test("a managing teammate still spawns its own team and exchanges messages with it", async () => {
		const harness = startHarness();
		try {
			await harness.execute("team_spawn", { teamName: "managed", startIdle: true, commonPrompt: "Follow main.", teammates: [{ name: "lead", model, thinking: "low", systemPrompt: "Act out each TOOL line.", canManageOwnTeams: true }] });
			const spawned = await harness.teammate("managed", "lead");
			await harness.execute("team_send_message", { targets: ["lead"], message: [
				toolLine("bash", { command: harness.nestedPiCommand("LEAD_NESTED_PROMPT") }),
				toolLine("team_spawn", { teamName: "sub", startIdle: true, commonPrompt: "Follow lead.", teammates: [{ name: "worker", model, thinking: "low", systemPrompt: "Act out each TOOL line." }] }),
				toolLine("team_send_message", { targets: ["worker"], message: toolLine("send_main_message", { message: "WORKER_TO_LEAD" }) }),
			].join("\n") });
			await waitFor(() => harness.requests.some((request) => lastUserText(request).includes("[sub/worker] WORKER_TO_LEAD")), "the managing teammate to receive its own teammate's message");
			assert.ok(harness.requests.some((request) => lastUserText(request) === "LEAD_NESTED_PROMPT"), "The fixture must actually run the nested Pi process.");
			const lead = await harness.teammate("managed", "lead");
			assert.deepEqual({ teammateId: lead.teammateId, sessionFile: lead.sessionFile, live: lead.live }, { teammateId: spawned.teammateId, sessionFile: spawned.sessionFile, live: true }, "The managing teammate must keep its identity in its parent team.");
		} finally {
			await harness.close();
		}
	}, 60000);

	test("a teammate registers again after Pi replaces its session in the same process", async () => {
		const executable = Bun.which("pi");
		assert.ok(executable, "The real-Pi check requires Pi on PATH.");
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-replacement-"));
		const registrations: JsonRecord[] = [];
		const callback = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			async fetch(request: Request): Promise<Response> {
				const body = await request.json() as { tool: string; args: JsonRecord };
				if (body.tool === "register") registrations.push(body.args);
				return Response.json({ accepted: true });
			},
		});
		fs.writeFileSync(path.join(directory, "models.json"), JSON.stringify({ providers: { "local-nested": {
			baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "local-fixture",
			models: [{ id: "probe", name: "Unused probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
		} } }));
		const child = spawn(executable, ["--mode", "rpc", "--no-extensions", "-e", extensionPath, "--no-skills", "--no-context-files", "--model", model], {
			cwd: directory,
			stdio: ["pipe", "ignore", "inherit"],
			env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1", PI_SIMPLE_TEAM_CHILD: "1", PI_SIMPLE_TEAM_CALLBACK_URL: `http://127.0.0.1:${callback.port}/callback`, PI_SIMPLE_TEAM_CALLBACK_TOKEN: "replacement-token", PI_SIMPLE_TEAM_TEAM: "replacement-team", PI_SIMPLE_TEAM_TEAM_NAME: "replacement", PI_SIMPLE_TEAM_MEMBER: "probe", PI_SIMPLE_TEAM_PARTICIPANTS: '["probe"]', PI_SIMPLE_TEAM_CAN_MANAGE_OWN_TEAMS: "0" },
		});
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		try {
			await waitFor(() => registrations.length > 0, "the first registration");
			child.stdin.write(JSON.stringify({ id: "replace", type: "new_session" }) + "\n");
			await waitFor(() => registrations.some((registration) => registration.sessionId !== registrations[0].sessionId), "Pi's replacement session to register its new identity for the same teammate");
		} finally {
			child.kill("SIGTERM");
			await exited;
			callback.stop(true);
			fs.rmSync(directory, { recursive: true, force: true });
		}
	}, 30000);
});

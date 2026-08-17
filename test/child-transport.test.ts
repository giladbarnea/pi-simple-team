import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import teamExtension from "../index.ts";
import { registerChildTools } from "../child-tools.ts";

type JsonRecord = Record<string, unknown>;
type ToolResult = { content: Array<{ type: string; text: string }>; details?: JsonRecord };
type RegisteredTool = { name: string; parameters: TSchema; execute: (id: string, params: JsonRecord, signal: AbortSignal, update: undefined, context: unknown) => Promise<ToolResult> };
type ExtensionEventHandler = (event: JsonRecord, context: unknown) => Promise<void> | void;

const fakeMainSessionFile = "/tmp/pi-simple-team-main-session.jsonl";
const fakeMainContext = {
	cwd: process.cwd(),
	scopedModels: [],
	modelRegistry: { getAvailable: () => [{ provider: "fake", id: "fake-model" }] },
	sessionManager: {
		getCwd: () => process.cwd(),
		getSessionFile: () => fakeMainSessionFile,
		getSessionId: () => "fake-main-session-id",
	},
};

class ExtensionHost {
	readonly tools = new Map<string, RegisteredTool>();
	readonly shutdownHandlers: ExtensionEventHandler[] = [];

	constructor() {
		const api = {
			on: (event: string, handler: ExtensionEventHandler) => {
				if (event === "session_shutdown") this.shutdownHandlers.push(handler);
				if (event === "session_start") handler({ reason: "startup" }, fakeMainContext);
			},
			registerCommand: () => undefined,
			registerMessageRenderer: () => undefined,
			registerTool: (tool: RegisteredTool) => this.tools.set(tool.name, tool),
		} as unknown as ExtensionAPI;
		teamExtension(api);
	}

	async execute(toolName: string, params: JsonRecord, context: unknown = fakeMainContext): Promise<ToolResult> {
		const tool = this.tools.get(toolName);
		assert.ok(tool, `Expected ${toolName} to be registered`);
		return tool.execute("test", params, new AbortController().signal, undefined, context);
	}

	async shutdown(): Promise<void> {
		for (const handler of this.shutdownHandlers) await handler({ reason: "quit" }, fakeMainContext);
	}
}

const fakePi = String.raw`#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--list-models")) {
  process.stdout.write("provider  model  context  max-out  thinking  images\nfake  fake-model  1K  1K  yes  no\n");
  process.exit(0);
}
const logPath = process.env.PI_SIMPLE_TEAM_TEST_HERDR_EVENTS;
function record(value) { fs.appendFileSync(logPath, JSON.stringify(value) + "\n"); }
const sessionArgumentIndex = args.indexOf("--session");
const sessionFile = sessionArgumentIndex === -1
  ? path.join(process.env.PI_SIMPLE_TEAM_TEST_HERDR_SESSIONS, process.env.PI_SIMPLE_TEAM_MEMBER + "-" + process.pid + ".jsonl")
  : args[sessionArgumentIndex + 1];
const sessionId = path.basename(sessionFile, ".jsonl");
record({ type: "pi_start", executable: process.argv[1], args, sessionId, sessionFile });
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (input.includes("\n")) {
    const newline = input.indexOf("\n");
    const command = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    record({ type: "stdin", command: command.type, member: process.env.PI_SIMPLE_TEAM_MEMBER });
    process.stdout.write(JSON.stringify({
      type: "response",
      id: command.id,
      command: command.type,
      success: true,
      data: command.type === "get_state" ? { isStreaming: false, sessionId, sessionFile } : undefined,
    }) + "\n");
  }
});
process.stdin.resume();
async function parent(tool, args) {
  record({ type: "parent", tool, args });
  const response = await fetch(process.env.PI_SIMPLE_TEAM_CALLBACK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: process.env.PI_SIMPLE_TEAM_CALLBACK_TOKEN, team: process.env.PI_SIMPLE_TEAM_TEAM, from: process.env.PI_SIMPLE_TEAM_MEMBER, tool, args }),
  });
  if (!response.ok) throw new Error(await response.text());
}
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  record({ type: "delivery", body });
  if (body.token !== process.env.PI_SIMPLE_TEAM_CALLBACK_TOKEN) {
    response.writeHead(403); response.end(); return;
  }
  if (body.tool === "report_context_window") {
    response.end(JSON.stringify({ contextUsage: { tokens: 87_000, contextWindow: 272_000, percent: 31.985 } }));
    return;
  }
  await parent("event", { event: { type: "agent_start" } });
  await parent("event", { event: { type: "tool_execution_start", toolName: "read", toolCallId: "fake-call", args: { path: "README.md" } } });
  await parent("event", { event: { type: "tool_execution_end", toolName: "read", toolCallId: "fake-call", isError: false, result: { output: "ok" } } });
  await parent("event", { event: { type: "agent_end", messages: [] } });
  response.end(JSON.stringify({ accepted: true }));
});
server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const url = process.env.PI_SIMPLE_TEAM_TEST_CHILD_BAD_REGISTER ? "http://localhost:1234/deliver" : "http://127.0.0.1:" + address.port + "/deliver";
  try {
    await parent("register", { url, sessionId, sessionFile });
    record({ type: "ready", url });
  } catch (error) {
    record({ type: "register_error", error: String(error) });
    process.exit(1);
  }
});
process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
`;

const pathPiScript = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.PI_SIMPLE_TEAM_TEST_HERDR_EVENTS, JSON.stringify({ type: "path_pi_start" }) + "\n");
process.exit(1);
`;

const fakeHerdr = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const logPath = process.env.PI_SIMPLE_TEAM_TEST_HERDR_LOG;
function record(value) { fs.appendFileSync(logPath, JSON.stringify(value) + "\n"); }
if (args[0] === "status") {
  process.stdout.write(JSON.stringify({ server: { running: true, compatible: true } }));
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "start") {
  const startCountPath = process.env.PI_SIMPLE_TEAM_TEST_HERDR_START_COUNT;
  const startCount = Number(fs.existsSync(startCountPath) ? fs.readFileSync(startCountPath, "utf8") : "0") + 1;
  fs.writeFileSync(startCountPath, String(startCount));
  record({ type: "start", args });
  if (Number(process.env.PI_SIMPLE_TEAM_TEST_HERDR_FAIL_START ?? "0") === startCount) {
    process.stderr.write("planned start failure"); process.exit(1);
  }
  const separator = args.indexOf("--");
  const command = args.slice(separator + 1);
  const environment = { ...process.env };
  for (let index = 0; index < separator; index += 1) {
    if (args[index] === "--env") {
      const split = args[index + 1].indexOf("=");
      environment[args[index + 1].slice(0, split)] = args[index + 1].slice(split + 1);
      index += 1;
    }
  }
  const paneId = "fake-pane-" + startCount;
  const child = spawn(command[0], command.slice(1), { env: environment, detached: true, stdio: "ignore" });
  child.unref();
  fs.appendFileSync(process.env.PI_SIMPLE_TEAM_TEST_HERDR_CHILDREN, JSON.stringify({ paneId, pid: child.pid }) + "\n");
  process.stdout.write(JSON.stringify({ id: "fake", result: { type: "agent_started", agent: { pane_id: paneId } } }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "close") {
  const paneId = args[2];
  record({ type: "close", paneId });
  const children = (fs.existsSync(process.env.PI_SIMPLE_TEAM_TEST_HERDR_CHILDREN) ? fs.readFileSync(process.env.PI_SIMPLE_TEAM_TEST_HERDR_CHILDREN, "utf8").trim().split("\n") : []);
  if (process.env.PI_SIMPLE_TEAM_TEST_HERDR_PANE_NOT_FOUND === paneId) {
    for (const line of children) {
      if (!line) continue;
      const child = JSON.parse(line);
      if (child.paneId === paneId) { try { process.kill(child.pid, "SIGTERM"); } catch {} }
    }
    process.stderr.write(JSON.stringify({ error: { code: "pane_not_found", message: "pane " + paneId + " not found" }, id: "cli:pane:close" }));
    process.exit(1);
  }
  for (const line of children) {
    if (!line) continue;
    const child = JSON.parse(line);
    if (child.paneId === paneId) { try { process.kill(child.pid, "SIGTERM"); } catch {} }
  }
  process.stdout.write(JSON.stringify({ id: "fake", result: { type: "ok" } }));
  process.exit(0);
}
process.stderr.write("unexpected fake Herdr command: " + args.join(" ")); process.exit(1);
`;

function installFakeCommands(): { directory: string; logPath: string; eventsPath: string; parentPiExecutable: string; restore: () => void } {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-herdr-test-"));
	const logPath = path.join(directory, "herdr.log");
	const eventsPath = path.join(directory, "events.log");
	const childrenPath = path.join(directory, "children.log");
	const startCountPath = path.join(directory, "start-count");
	const sessionsDirectory = path.join(directory, "sessions");
	const agentDirectory = path.join(directory, "agent");
	const parentPiExecutable = path.join(directory, "parent-pi");
	fs.mkdirSync(sessionsDirectory);
	fs.mkdirSync(agentDirectory);
	for (const [name, content] of [["parent-pi", fakePi], ["pi", pathPiScript], ["herdr", fakeHerdr]] as const) {
		const executable = path.join(directory, name);
		fs.writeFileSync(executable, content, { mode: 0o755 });
	}
	const previous = { executable: process.argv[1]!, path: process.env.PATH, agent: process.env.PI_CODING_AGENT_DIR, tab: process.env.HERDR_TAB_ID, pane: process.env.HERDR_PANE_ID, log: process.env.PI_SIMPLE_TEAM_TEST_HERDR_LOG, events: process.env.PI_SIMPLE_TEAM_TEST_HERDR_EVENTS, sessions: process.env.PI_SIMPLE_TEAM_TEST_HERDR_SESSIONS, children: process.env.PI_SIMPLE_TEAM_TEST_HERDR_CHILDREN, count: process.env.PI_SIMPLE_TEAM_TEST_HERDR_START_COUNT, fail: process.env.PI_SIMPLE_TEAM_TEST_HERDR_FAIL_START, bad: process.env.PI_SIMPLE_TEAM_TEST_CHILD_BAD_REGISTER, notFound: process.env.PI_SIMPLE_TEAM_TEST_HERDR_PANE_NOT_FOUND };
	process.argv[1] = parentPiExecutable;
	process.env.PATH = `${directory}${path.delimiter}${previous.path ?? ""}`;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.HERDR_TAB_ID = "fake-tab";
	process.env.HERDR_PANE_ID = "main-pane";
	process.env.PI_SIMPLE_TEAM_TEST_HERDR_LOG = logPath;
	process.env.PI_SIMPLE_TEAM_TEST_HERDR_EVENTS = eventsPath;
	process.env.PI_SIMPLE_TEAM_TEST_HERDR_SESSIONS = sessionsDirectory;
	process.env.PI_SIMPLE_TEAM_TEST_HERDR_CHILDREN = childrenPath;
	process.env.PI_SIMPLE_TEAM_TEST_HERDR_START_COUNT = startCountPath;
	delete process.env.PI_SIMPLE_TEAM_TEST_HERDR_FAIL_START;
	delete process.env.PI_SIMPLE_TEAM_TEST_CHILD_BAD_REGISTER;
	delete process.env.PI_SIMPLE_TEAM_TEST_HERDR_PANE_NOT_FOUND;
	return {
		directory,
		logPath,
		eventsPath,
		parentPiExecutable,
		restore: () => {
			process.argv[1] = previous.executable;
			process.env.PATH = previous.path;
			process.env.PI_CODING_AGENT_DIR = previous.agent;
			process.env.HERDR_TAB_ID = previous.tab;
			process.env.HERDR_PANE_ID = previous.pane;
			process.env.PI_SIMPLE_TEAM_TEST_HERDR_LOG = previous.log;
			process.env.PI_SIMPLE_TEAM_TEST_HERDR_EVENTS = previous.events;
			process.env.PI_SIMPLE_TEAM_TEST_HERDR_SESSIONS = previous.sessions;
			process.env.PI_SIMPLE_TEAM_TEST_HERDR_CHILDREN = previous.children;
			process.env.PI_SIMPLE_TEAM_TEST_HERDR_START_COUNT = previous.count;
			process.env.PI_SIMPLE_TEAM_TEST_HERDR_FAIL_START = previous.fail;
			process.env.PI_SIMPLE_TEAM_TEST_CHILD_BAD_REGISTER = previous.bad;
			process.env.PI_SIMPLE_TEAM_TEST_HERDR_PANE_NOT_FOUND = previous.notFound;
			fs.rmSync(directory, { recursive: true, force: true });
		},
	};
}

function lines(filePath: string): JsonRecord[] {
	if (!fs.existsSync(filePath)) return [];
	return fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as JsonRecord);
}

async function waitFor(predicate: () => boolean, timeoutMilliseconds = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMilliseconds;
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(predicate(), "Timed out waiting for fake Herdr activity");
}

type ChildHandler = (...args: unknown[]) => unknown;

type CallbackRequest = {
	token: string;
	team: string;
	from: string;
	tool: string;
	args: JsonRecord;
};

async function startChildCallbackReceiver(failingLifecycleEvents: number): Promise<{ url: string; requests: CallbackRequest[]; close: () => Promise<void> }> {
	const requests: CallbackRequest[] = [];
	let remainingFailures = failingLifecycleEvents;
	const server = http.createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CallbackRequest;
		requests.push(body);
		if (body.tool === "event" && remainingFailures > 0) {
			remainingFailures -= 1;
			response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "planned callback failure" }));
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ accepted: true }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return {
		url: `http://127.0.0.1:${address.port}/callback`,
		requests,
		close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	};
}

async function startChildRuntimeForTest(failingLifecycleEvents: number): Promise<{ handlers: Map<string, ChildHandler>; messages: JsonRecord[]; requests: CallbackRequest[]; close: () => Promise<void> }> {
	const receiver = await startChildCallbackReceiver(failingLifecycleEvents);
	const config = {
		callbackUrl: receiver.url,
		callbackToken: "child-token",
		teamName: "child-team",
		teammateName: "reviewer",
		participants: ["main", "reviewer"],
		canOverseeOwnTeams: false,
		interruptWaitTimeoutMilliseconds: 250,
	};
	const handlers = new Map<string, ChildHandler>();
	const messages: JsonRecord[] = [];
	const api = {
		on: (event: string, handler: ChildHandler) => handlers.set(event, handler),
		registerMessageRenderer: () => undefined,
		registerTool: () => undefined,
		sendMessage: (message: JsonRecord) => messages.push(message),
	};
	registerChildTools(api as unknown as ExtensionAPI, config);
	await handlers.get("session_start")?.({}, {
		shutdown: () => undefined,
		getContextUsage: () => ({ tokens: 87_000, contextWindow: 272_000, percent: 31.985 }),
		sessionManager: {
			getSessionId: () => "visible-child-test-session-id",
			getSessionFile: () => "/tmp/visible-child-test-session.jsonl",
		},
	});
	assert.ok(receiver.requests.some((request) => request.tool === "register"));
	let closed = false;
	return {
		handlers,
		messages,
		requests: receiver.requests,
		close: async () => {
			if (closed) return;
			closed = true;
			await handlers.get("session_shutdown")?.({ reason: "quit" });
			await receiver.close();
		},
	};
}

describe("unified child runtime", () => {
	test("a non-visible child starts the same delivery runtime and registers with the parent", async () => {
		const child = await startChildRuntimeForTest(0);
		try {
			const register = child.requests.find((request) => request.tool === "register");
			assert.ok(register, "Expected the non-visible child to register its delivery URL with the parent.");
			assert.equal(register.args.sessionId, "visible-child-test-session-id", `Expected registration to carry the session identity. Got: ${JSON.stringify(register.args)}`);
			assert.equal(register.args.sessionFile, "/tmp/visible-child-test-session.jsonl", `Expected registration to carry the session file. Got: ${JSON.stringify(register.args)}`);

			const delivery = await fetch(String(register.args.url), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: "child-token", tool: "deliver", args: { interrupt: false, formattedMessage: "hello", team: "child-team", from: "main", to: "reviewer", sentAt: "now", message: "hello" } }),
			});
			assert.equal(delivery.status, 200, "Expected the non-visible child to accept a parent delivery over HTTP.");
			assert.equal(child.messages.length, 1, `Expected the delivery to become one in-session message. Got: ${JSON.stringify(child.messages)}`);
		} finally {
			await child.close();
		}
	});

	test("RPC teammates use the parent Pi executable instead of PATH", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", {
				team: "rpc-parent-pi-team",
				teamPrompt: "test",
				teammates: [{ name: "scout", prompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			const piStart = lines(fake.eventsPath).find((entry) => entry.type === "pi_start");
			assert.equal(piStart?.executable, fake.parentPiExecutable, "Expected the RPC teammate to use the parent Pi executable.");
			assert.equal(lines(fake.eventsPath).some((entry) => entry.type === "path_pi_start"), false, "Expected the RPC teammate to ignore the Pi executable from PATH.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("team_spawn takes an RPC teammate's identity from registration, not a state query", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			const spawnResult = await host.execute("team_spawn", {
				team: "rpc-registration-team",
				teamPrompt: "test",
				teammates: [{ name: "scout", prompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			await waitFor(() => lines(fake.eventsPath).some((entry) => entry.type === "ready"));
			const piStart = lines(fake.eventsPath).find((entry) => entry.type === "pi_start");
			assert.deepEqual(
				spawnResult.details?.sessions,
				{ scout: { sessionId: piStart?.sessionId, sessionFile: piStart?.sessionFile } },
				`Expected the registration to supply the session identity. Got: ${JSON.stringify(spawnResult.details)}`,
			);
			assert.deepEqual(
				lines(fake.eventsPath).filter((entry) => entry.type === "stdin"),
				[],
				"Expected the parent to send no stdin commands during spawn.",
			);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("main reads an RPC teammate's context window through its delivery runtime", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", {
				team: "rpc-context-team",
				teamPrompt: "test",
				teammates: [{ name: "scout", prompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			const result = await host.execute(
				"report_context_window",
				{ targets: ["scout"] },
				{ getContextUsage: () => ({ tokens: 43_210, contextWindow: 200_000, percent: 21.605 }) },
			);
			assert.equal(
				result.content[0]?.text,
				"Teammate scout has used 87k tokens out of 272k available (32%).\nYou have used 43k tokens out of 200k available (22%).",
				"Expected the RPC teammate's context report to come from its delivery runtime.",
			);
			assert.deepEqual(
				lines(fake.eventsPath).filter((entry) => entry.type === "stdin"),
				[],
				"Expected the context query to avoid stdin RPC.",
			);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("teamsend reaches an RPC teammate through its delivery runtime and its events flow back", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", {
				team: "rpc-delivery-team",
				teamPrompt: "test",
				teammates: [{ name: "scout", prompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			await host.execute("teamsend", { team: "rpc-delivery-team", to: ["scout"], message: "check this", interrupt: false });
			await waitFor(() => lines(fake.eventsPath).some((entry) => entry.type === "delivery"));
			const delivery = lines(fake.eventsPath).find((entry) => entry.type === "delivery")!;
			const deliveryArgs = (delivery.body as JsonRecord).args as JsonRecord;
			assert.equal(deliveryArgs.message, "check this", `Expected the HTTP delivery to carry the message. Got: ${JSON.stringify(delivery)}`);
			await waitFor(() => lines(fake.eventsPath).filter((entry) => entry.type === "parent" && entry.tool === "event").length === 4);
			await new Promise((resolve) => setTimeout(resolve, 25));

			const log = await host.execute("teamlog", { team: "rpc-delivery-team" });
			assert.match(log.content[0].text, /deliver/);
			assert.match(log.content[0].text, /agent_start/);
			assert.match(log.content[0].text, /tool_start/);
			assert.match(log.content[0].text, /agent_end/);
			assert.deepEqual(
				lines(fake.eventsPath).filter((entry) => entry.type === "stdin"),
				[],
				"Expected message delivery to avoid stdin RPC.",
			);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("an interrupting send carries the interrupt flag to the RPC teammate's runtime", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", {
				team: "rpc-interrupt-team",
				teamPrompt: "test",
				teammates: [{ name: "scout", prompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			await host.execute("teamsend", { team: "rpc-interrupt-team", to: ["scout"], message: "drop everything", interrupt: true });
			await waitFor(() => lines(fake.eventsPath).some((entry) => entry.type === "delivery"));
			const delivery = lines(fake.eventsPath).find((entry) => entry.type === "delivery")!;
			const deliveryArgs = (delivery.body as JsonRecord).args as JsonRecord;
			assert.equal(deliveryArgs.interrupt, true, `Expected the delivery to carry interrupt=true. Got: ${JSON.stringify(delivery)}`);
			assert.deepEqual(
				lines(fake.eventsPath).filter((entry) => entry.type === "stdin"),
				[],
				"Expected the interrupt to ride the delivery instead of a stdin abort.",
			);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});
});

describe("visible Herdr teammates", () => {
	test("exposes its current context usage to the parent", async () => {
		const child = await startChildRuntimeForTest(0);
		try {
			const register = child.requests.find((request) => request.tool === "register");
			assert.ok(register, "Expected the visible teammate to register its callback URL.");
			const response = await fetch(String(register.args.url), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: "child-token", tool: "report_context_window", args: {} }),
			});

			assert.equal(response.status, 200, "Expected the visible teammate to accept a parent context-window query.");
			assert.deepEqual(
				await response.json(),
				{ contextUsage: { tokens: 87_000, contextWindow: 272_000, percent: 31.985 } },
				"Expected the visible teammate to return its current context usage.",
			);
		} finally {
			await child.close();
		}
	});

	test("bounds an interrupted delivery when agent_settled never arrives", async () => {
		const child = await startChildRuntimeForTest(0);
		try {
			await child.handlers.get("agent_start")?.({}, { abort: () => undefined });
			const register = child.requests.find((request) => request.tool === "register");
			assert.ok(register);
			const response = await fetch(String(register.args.url), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: "child-token", tool: "deliver", args: { interrupt: true, formattedMessage: "message", team: "child-team", from: "main", to: "reviewer", sentAt: "now", message: "message" } }),
			});
			assert.equal(response.status, 500);
			assert.match(await response.text(), /Timed out waiting for the child to settle after interrupt/);
		} finally {
			await child.close();
		}
	});

	test("resolves an interrupted delivery when session shutdown replaces agent_settled", async () => {
		const child = await startChildRuntimeForTest(0);
		try {
			await child.handlers.get("agent_start")?.({}, { abort: () => undefined });
			const register = child.requests.find((request) => request.tool === "register");
			assert.ok(register);
			const delivery = fetch(String(register.args.url), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: "child-token", tool: "deliver", args: { interrupt: true, formattedMessage: "message", team: "child-team", from: "main", to: "reviewer", sentAt: "now", message: "message" } }),
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			await child.close();
			assert.equal((await delivery).status, 200);
		} finally {
			await child.close();
		}
	});

	test("retries lifecycle callbacks without reordering events", async () => {
		const child = await startChildRuntimeForTest(2);
		try {
			await child.handlers.get("agent_start")?.({}, { abort: () => undefined });
			await child.handlers.get("agent_end")?.({ messages: [] });
			await waitFor(() => child.requests.filter((request) => request.tool === "event").length === 4);
			assert.deepEqual(
				child.requests.filter((request) => request.tool === "event").map((request) => ((request.args.event as JsonRecord).type)),
				["agent_start", "agent_start", "agent_start", "agent_end"],
			);
		} finally {
			await child.close();
		}
	});

	test("fails a later delivery after the final lifecycle callback failure", async () => {
		const child = await startChildRuntimeForTest(3);
		try {
			await child.handlers.get("agent_start")?.({}, { abort: () => undefined });
			await waitFor(() => child.requests.filter((request) => request.tool === "event").length === 3);
			const register = child.requests.find((request) => request.tool === "register");
			assert.ok(register);
			const response = await fetch(String(register.args.url), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: "child-token", tool: "deliver", args: { interrupt: false, formattedMessage: "message", team: "child-team", from: "main", to: "reviewer", sentAt: "now", message: "message" } }),
			});
			assert.equal(response.status, 500);
			assert.match(await response.text(), /Lifecycle callback failed: team runtime rejected event/);
		} finally {
			await child.close();
		}
	});

	test("defaults to RPC and does not call Herdr when omitted or false", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			const schema = host.tools.get("team_spawn")?.parameters;
			assert.ok(schema);
			assert.equal(Value.Check(schema, { team: "rpc-team", teamPrompt: "test", teammates: [] }), true);
			assert.equal(Value.Check(schema, { team: "rpc-team", teamPrompt: "test", teammates: [], showOnHerdrPanes: false }), true);
			await host.execute("team_spawn", { team: "rpc-team", teamPrompt: "test", teammates: [] });
			assert.deepEqual(lines(fake.logPath), []);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("rejects inherited context for an ephemeral main session", async () => {
		const host = new ExtensionHost();
		try {
			await assert.rejects(
				() => host.execute(
					"team_spawn",
					{
						team: "ephemeral-team",
						teamPrompt: "test",
						teammates: [{ name: "inheritor", prompt: "wait", model: "fake/fake-model", inheritContext: true }],
					},
					{ ...fakeMainContext, sessionManager: { getSessionFile: () => undefined } },
				),
				/inheritContext requires a persistent main session/,
			);
		} finally {
			await host.shutdown();
		}
	});

	test("Herdr teammates use the parent Pi executable instead of PATH", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", {
				team: "visible-parent-pi-team",
				teamPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [{ name: "scout", prompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			const start = lines(fake.logPath).find((entry) => entry.type === "start");
			const startArgs = start?.args as string[];
			assert.equal(startArgs[startArgs.indexOf("--") + 1], fake.parentPiExecutable, "Expected Herdr to receive the parent Pi executable.");
			assert.equal(lines(fake.eventsPath).some((entry) => entry.type === "path_pi_start"), false, "Expected the Herdr teammate to ignore the Pi executable from PATH.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("passes the main session fork only to inheriting visible teammates", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", {
				team: "inherited-visible-team",
				teamPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [
					{ name: "inheritor", prompt: "wait", model: "fake/fake-model", thinking: "low", inheritContext: true },
					{ name: "fresh", prompt: "wait", model: "fake/fake-model", thinking: "low" },
				],
			});
			const starts = lines(fake.logPath).filter((entry) => entry.type === "start");
			assert.equal(starts.length, 2);
			const commandFor = (index: number): string[] => {
				const args = starts[index]!.args as string[];
				return args.slice(args.indexOf("--") + 1);
			};
			assert.deepEqual(commandFor(0).slice(0, 5), [fake.parentPiExecutable, "--fork", fakeMainSessionFile, "--no-extensions", "-e"]);
			assert.equal(commandFor(1).includes("--fork"), false);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("requires the main session Herdr tab before visible spawn", async () => {
		const fake = installFakeCommands();
		delete process.env.HERDR_TAB_ID;
		const host = new ExtensionHost();
		try {
			await assert.rejects(() => host.execute("team_spawn", {
				team: "missing-tab-team",
				teamPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [],
			}), /HERDR_TAB_ID/);
			assert.deepEqual(lines(fake.logPath), []);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("main reports a visible teammate before itself", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", {
				team: "visible-context-team",
				teamPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [{ name: "product-head", prompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			const result = await host.execute(
				"report_context_window",
				{ targets: ["product-head"] },
				{ getContextUsage: () => ({ tokens: 43_210, contextWindow: 200_000, percent: 21.605 }) },
			);

			assert.equal(
				result.content[0]?.text,
				"Teammate product-head has used 87k tokens out of 272k available (32%).\nYou have used 43k tokens out of 200k available (22%).",
				"Expected the visible teammate report before main's report.",
			);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("persists visible teammates and resumes them through RPC by default", async () => {
		const fake = installFakeCommands();
		const originHost = new ExtensionHost();
		let resumingHost: ExtensionHost | undefined;
		try {
			const teamName = "durable-visible-team";
			const teamId = `fake-main-session-id-${teamName}`;
			const spawnResult = await originHost.execute("team_spawn", {
				team: teamName,
				teamPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [{ name: "reviewer", prompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			const visibleStart = lines(fake.eventsPath).find((entry) => entry.type === "pi_start");
			assert.deepEqual(
				spawnResult.details?.sessions,
				{ reviewer: { sessionId: visibleStart?.sessionId, sessionFile: visibleStart?.sessionFile } },
				`Expected visible spawn to return the Pi session identity. Got: ${JSON.stringify(spawnResult.details)}`,
			);
			await originHost.execute("team_shutdown", { team: teamId });

			resumingHost = new ExtensionHost();
			const resumeResult = await resumingHost.execute("team_resume", { team: teamId });
			assert.deepEqual(resumeResult.details?.resumed, ["reviewer"], `Expected the visible member to remain resumable. Got: ${JSON.stringify(resumeResult.details)}`);
			assert.equal(lines(fake.logPath).filter((entry) => entry.type === "start").length, 1, "Expected default resume not to open another Herdr pane.");
		} finally {
			await resumingHost?.shutdown();
			await originHost.shutdown();
			fake.restore();
		}
	});

	test("resumes a persisted session in visible panes only when explicitly requested", async () => {
		const fake = installFakeCommands();
		const originHost = new ExtensionHost();
		let resumingHost: ExtensionHost | undefined;
		try {
			const teamName = "visible-resume-team";
			const teamId = `fake-main-session-id-${teamName}`;
			const spawnResult = await originHost.execute("team_spawn", {
				team: teamName,
				teamPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [{ name: "reviewer", prompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			const sessions = spawnResult.details?.sessions as JsonRecord;
			const reviewerSession = sessions.reviewer as JsonRecord;
			fs.writeFileSync(String(reviewerSession.sessionFile), '{"type":"session"}\n');
			await originHost.execute("team_shutdown", { team: teamId });

			resumingHost = new ExtensionHost();
			await resumingHost.execute("team_resume", { team: teamId, showOnHerdrPanes: true });
			const starts = lines(fake.logPath).filter((entry) => entry.type === "start");
			assert.equal(starts.length, 2, `Expected explicit visible resume to open a new Herdr pane. Got: ${JSON.stringify(starts)}`);
			const resumeArgs = starts.at(-1)?.args as string[];
			const command = resumeArgs.slice(resumeArgs.indexOf("--") + 1);
			assert.equal(command[command.indexOf("--session") + 1], reviewerSession.sessionFile, `Expected visible resume to use the durable session file. Got: ${JSON.stringify(command)}`);
			assert.equal(command.includes("--model"), false, `Expected the persisted session to restore its own model. Got: ${JSON.stringify(command)}`);
		} finally {
			await resumingHost?.shutdown();
			await originHost.shutdown();
			fake.restore();
		}
	});

	test("starts a ready visible teammate, forwards delivery events, and closes the exact pane", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", {
				team: "visible-team",
				teamPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [{ name: "reviewer", prompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			const start = lines(fake.logPath).find((entry) => entry.type === "start");
			assert.ok(start);
			const startArgs = start.args as string[];
			assert.deepEqual(startArgs.slice(0, 8), ["agent", "start", "reviewer", "--tab", "fake-tab", "--split", "right", "--no-focus"]);
			assert.equal(startArgs.includes("--mode"), false);
			assert.equal(startArgs.includes("-e"), true);
			assert.equal(startArgs.includes("--model"), true);
			assert.equal(startArgs.includes("--thinking"), true);
			assert.equal(startArgs.includes("--system-prompt"), true);
			assert.equal(startArgs.some((argument) => argument.startsWith("PATH=")), false);
			assert.equal(startArgs.includes("HERDR_PANE_ID=main-pane"), false);

			await host.execute("teamsend", { team: "visible-team", to: ["reviewer"], message: "check this", interrupt: false });
			await waitFor(() => lines(fake.eventsPath).some((entry) => entry.type === "parent" && (entry.args as JsonRecord)?.event && ((entry.args as JsonRecord).event as JsonRecord).type === "agent_end"));
			await new Promise((resolve) => setTimeout(resolve, 25));
			const forwardedEvents = lines(fake.eventsPath)
				.filter((entry) => entry.type === "parent" && entry.tool === "event")
				.map((entry) => ((entry.args as JsonRecord).event as JsonRecord).type);
			assert.deepEqual(forwardedEvents, ["agent_start", "tool_execution_start", "tool_execution_end", "agent_end"]);
			const log = await host.execute("teamlog", { team: "visible-team" });
			assert.match(log.content[0].text, /deliver/);
			assert.match(log.content[0].text, /agent_start/);
			assert.match(log.content[0].text, /tool_start/);
			assert.match(log.content[0].text, /agent_end/);

			await host.execute("team_shutdown", { team: "visible-team" });
			assert.deepEqual(lines(fake.logPath).filter((entry) => entry.type === "close"), [{ type: "close", paneId: "fake-pane-1" }]);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("treats an externally closed pane as already closed during team shutdown", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", {
				team: "externally-closed-team",
				teamPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [{ name: "reviewer", prompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			process.env.PI_SIMPLE_TEAM_TEST_HERDR_PANE_NOT_FOUND = "fake-pane-1";

			await host.execute("team_shutdown", { team: "externally-closed-team" });
			assert.deepEqual(lines(fake.logPath).filter((entry) => entry.type === "close"), [{ type: "close", paneId: "fake-pane-1" }]);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("closes a pane when visible-child readiness fails", async () => {
		const fake = installFakeCommands();
		process.env.PI_SIMPLE_TEAM_TEST_CHILD_BAD_REGISTER = "1";
		const host = new ExtensionHost();
		try {
			await assert.rejects(() => host.execute("team_spawn", {
				team: "startup-failure-team",
				teamPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [{ name: "broken", prompt: "wait", model: "fake/fake-model", thinking: "low" }],
			}), /Invalid delivery URL/);
			assert.deepEqual(lines(fake.logPath).filter((entry) => entry.type === "close"), [{ type: "close", paneId: "fake-pane-1" }]);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("rolls back already-created panes after a later Herdr start fails", async () => {
		const fake = installFakeCommands();
		process.env.PI_SIMPLE_TEAM_TEST_HERDR_FAIL_START = "2";
		const host = new ExtensionHost();
		try {
			await assert.rejects(() => host.execute("team_spawn", {
				team: "rollback-team",
				teamPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [
					{ name: "first", prompt: "wait", model: "fake/fake-model", thinking: "low" },
					{ name: "second", prompt: "wait", model: "fake/fake-model", thinking: "low" },
				],
			}), /planned start failure/);
			assert.deepEqual(lines(fake.logPath).filter((entry) => entry.type === "close"), [{ type: "close", paneId: "fake-pane-1" }]);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});
});

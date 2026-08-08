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
type ShutdownHandler = () => Promise<void> | void;

class ExtensionHost {
	readonly tools = new Map<string, RegisteredTool>();
	readonly shutdownHandlers: ShutdownHandler[] = [];

	constructor() {
		const api = {
			on: (event: string, handler: ShutdownHandler) => {
				if (event === "session_shutdown") this.shutdownHandlers.push(handler);
			},
			registerMessageRenderer: () => undefined,
			registerTool: (tool: RegisteredTool) => this.tools.set(tool.name, tool),
		} as unknown as ExtensionAPI;
		teamExtension(api);
	}

	async execute(toolName: string, params: JsonRecord): Promise<ToolResult> {
		const tool = this.tools.get(toolName);
		assert.ok(tool, `Expected ${toolName} to be registered`);
		return tool.execute("test", params, new AbortController().signal, undefined, {});
	}

	async shutdown(): Promise<void> {
		for (const handler of this.shutdownHandlers) await handler();
	}
}

const fakePi = String.raw`#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--list-models")) {
  process.stdout.write("provider  model  context  max-out  thinking  images\nfake  fake-model  1K  1K  yes  no\n");
  process.exit(0);
}
if (process.env.PI_SIMPLE_TEAM_VISIBLE_CHILD !== "1") {
  setInterval(() => {}, 1000);
  process.stdin.resume();
  return;
}
const logPath = process.env.FAKE_HERDR_EVENTS;
function record(value) { fs.appendFileSync(logPath, JSON.stringify(value) + "\n"); }
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
  await parent("visible_event", { event: { type: "agent_start" } });
  await parent("visible_event", { event: { type: "tool_execution_start", toolName: "read", toolCallId: "fake-call", args: { path: "README.md" } } });
  await parent("visible_event", { event: { type: "tool_execution_end", toolName: "read", toolCallId: "fake-call", isError: false, result: { output: "ok" } } });
  await parent("visible_event", { event: { type: "agent_end", messages: [] } });
  response.end(JSON.stringify({ accepted: true }));
});
server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const url = process.env.FAKE_VISIBLE_BAD_REGISTER ? "http://localhost:1234/deliver" : "http://127.0.0.1:" + address.port + "/deliver";
  try {
    await parent("visible_register", { url });
    record({ type: "ready", url });
  } catch (error) {
    record({ type: "register_error", error: String(error) });
    process.exit(1);
  }
});
process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
`;

const fakeHerdr = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const logPath = process.env.FAKE_HERDR_LOG;
function record(value) { fs.appendFileSync(logPath, JSON.stringify(value) + "\n"); }
if (args[0] === "status") {
  process.stdout.write(JSON.stringify({ server: { running: true, compatible: true } }));
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "start") {
  const startCountPath = process.env.FAKE_HERDR_START_COUNT;
  const startCount = Number(fs.existsSync(startCountPath) ? fs.readFileSync(startCountPath, "utf8") : "0") + 1;
  fs.writeFileSync(startCountPath, String(startCount));
  record({ type: "start", args });
  if (Number(process.env.FAKE_HERDR_FAIL_START ?? "0") === startCount) {
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
  fs.appendFileSync(process.env.FAKE_HERDR_CHILDREN, JSON.stringify({ paneId, pid: child.pid }) + "\n");
  process.stdout.write(JSON.stringify({ id: "fake", result: { type: "agent_started", agent: { pane_id: paneId } } }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "close") {
  const paneId = args[2];
  record({ type: "close", paneId });
  const children = (fs.existsSync(process.env.FAKE_HERDR_CHILDREN) ? fs.readFileSync(process.env.FAKE_HERDR_CHILDREN, "utf8").trim().split("\n") : []);
  if (process.env.FAKE_HERDR_PANE_NOT_FOUND === paneId) {
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

function installFakeCommands(): { directory: string; logPath: string; eventsPath: string; restore: () => void } {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-herdr-test-"));
	const logPath = path.join(directory, "herdr.log");
	const eventsPath = path.join(directory, "events.log");
	const childrenPath = path.join(directory, "children.log");
	const startCountPath = path.join(directory, "start-count");
	for (const [name, content] of [["pi", fakePi], ["herdr", fakeHerdr]] as const) {
		const executable = path.join(directory, name);
		fs.writeFileSync(executable, content, { mode: 0o755 });
	}
	const previous = { path: process.env.PATH, tab: process.env.HERDR_TAB_ID, pane: process.env.HERDR_PANE_ID, log: process.env.FAKE_HERDR_LOG, events: process.env.FAKE_HERDR_EVENTS, children: process.env.FAKE_HERDR_CHILDREN, count: process.env.FAKE_HERDR_START_COUNT, fail: process.env.FAKE_HERDR_FAIL_START, bad: process.env.FAKE_VISIBLE_BAD_REGISTER, notFound: process.env.FAKE_HERDR_PANE_NOT_FOUND };
	process.env.PATH = `${directory}${path.delimiter}${previous.path ?? ""}`;
	process.env.HERDR_TAB_ID = "fake-tab";
	process.env.HERDR_PANE_ID = "main-pane";
	process.env.FAKE_HERDR_LOG = logPath;
	process.env.FAKE_HERDR_EVENTS = eventsPath;
	process.env.FAKE_HERDR_CHILDREN = childrenPath;
	process.env.FAKE_HERDR_START_COUNT = startCountPath;
	delete process.env.FAKE_HERDR_FAIL_START;
	delete process.env.FAKE_VISIBLE_BAD_REGISTER;
	delete process.env.FAKE_HERDR_PANE_NOT_FOUND;
	return {
		directory,
		logPath,
		eventsPath,
		restore: () => {
			process.env.PATH = previous.path;
			process.env.HERDR_TAB_ID = previous.tab;
			process.env.HERDR_PANE_ID = previous.pane;
			process.env.FAKE_HERDR_LOG = previous.log;
			process.env.FAKE_HERDR_EVENTS = previous.events;
			process.env.FAKE_HERDR_CHILDREN = previous.children;
			process.env.FAKE_HERDR_START_COUNT = previous.count;
			process.env.FAKE_HERDR_FAIL_START = previous.fail;
			process.env.FAKE_VISIBLE_BAD_REGISTER = previous.bad;
			process.env.FAKE_HERDR_PANE_NOT_FOUND = previous.notFound;
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

async function startChildCallbackReceiver(failingVisibleEvents: number): Promise<{ url: string; requests: CallbackRequest[]; close: () => Promise<void> }> {
	const requests: CallbackRequest[] = [];
	let remainingFailures = failingVisibleEvents;
	const server = http.createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CallbackRequest;
		requests.push(body);
		if (body.tool === "visible_event" && remainingFailures > 0) {
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

async function startVisibleChildForTest(failingVisibleEvents: number): Promise<{ handlers: Map<string, ChildHandler>; messages: JsonRecord[]; requests: CallbackRequest[]; close: () => Promise<void> }> {
	const receiver = await startChildCallbackReceiver(failingVisibleEvents);
	const config = {
		callbackUrl: receiver.url,
		callbackToken: "child-token",
		teamName: "child-team",
		teammateName: "reviewer",
		visible: true,
		participants: ["main", "reviewer"],
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
	await handlers.get("session_start")?.({}, { shutdown: () => undefined });
	assert.ok(receiver.requests.some((request) => request.tool === "visible_register"));
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

describe("visible Herdr teammates", () => {
	test("bounds an interrupted delivery when agent_settled never arrives", async () => {
		const child = await startVisibleChildForTest(0);
		try {
			await child.handlers.get("agent_start")?.({}, { abort: () => undefined });
			const register = child.requests.find((request) => request.tool === "visible_register");
			assert.ok(register);
			const response = await fetch(String(register.args.url), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: "child-token", tool: "deliver", args: { interrupt: true, formattedMessage: "message", team: "child-team", from: "main", to: "reviewer", sentAt: "now", message: "message" } }),
			});
			assert.equal(response.status, 500);
			assert.match(await response.text(), /Timed out waiting for visible child to settle after interrupt/);
		} finally {
			await child.close();
		}
	});

	test("resolves an interrupted delivery when session shutdown replaces agent_settled", async () => {
		const child = await startVisibleChildForTest(0);
		try {
			await child.handlers.get("agent_start")?.({}, { abort: () => undefined });
			const register = child.requests.find((request) => request.tool === "visible_register");
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
		const child = await startVisibleChildForTest(2);
		try {
			await child.handlers.get("agent_start")?.({}, { abort: () => undefined });
			await child.handlers.get("agent_end")?.({ messages: [] });
			await waitFor(() => child.requests.filter((request) => request.tool === "visible_event").length === 4);
			assert.deepEqual(
				child.requests.filter((request) => request.tool === "visible_event").map((request) => ((request.args.event as JsonRecord).type)),
				["agent_start", "agent_start", "agent_start", "agent_end"],
			);
		} finally {
			await child.close();
		}
	});

	test("fails a later delivery after the final lifecycle callback failure", async () => {
		const child = await startVisibleChildForTest(3);
		try {
			await child.handlers.get("agent_start")?.({}, { abort: () => undefined });
			await waitFor(() => child.requests.filter((request) => request.tool === "visible_event").length === 3);
			const register = child.requests.find((request) => request.tool === "visible_register");
			assert.ok(register);
			const response = await fetch(String(register.args.url), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: "child-token", tool: "deliver", args: { interrupt: false, formattedMessage: "message", team: "child-team", from: "main", to: "reviewer", sentAt: "now", message: "message" } }),
			});
			assert.equal(response.status, 500);
			assert.match(await response.text(), /Visible lifecycle callback failed: team runtime rejected visible_event/);
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

	test("starts a ready visible teammate, forwards delivery events, and closes the exact pane", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", {
				team: "visible-team",
				teamPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [{ name: "reviewer", prompt: "wait", model: "fake-model", thinking: "low" }],
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
			assert.ok(startArgs.includes("PI_SIMPLE_TEAM_VISIBLE_CHILD=1"));
			assert.equal(startArgs.some((argument) => argument.startsWith("PATH=")), false);
			assert.equal(startArgs.includes("HERDR_PANE_ID=main-pane"), false);

			await host.execute("teamsend", { team: "visible-team", to: ["reviewer"], message: "check this", interrupt: false });
			await waitFor(() => lines(fake.eventsPath).some((entry) => entry.type === "parent" && (entry.args as JsonRecord)?.event && ((entry.args as JsonRecord).event as JsonRecord).type === "agent_end"));
			await new Promise((resolve) => setTimeout(resolve, 25));
			const forwardedEvents = lines(fake.eventsPath)
				.filter((entry) => entry.type === "parent" && entry.tool === "visible_event")
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
				teammates: [{ name: "reviewer", prompt: "wait", model: "fake-model", thinking: "low" }],
			});
			process.env.FAKE_HERDR_PANE_NOT_FOUND = "fake-pane-1";

			await host.execute("team_shutdown", { team: "externally-closed-team" });
			assert.deepEqual(lines(fake.logPath).filter((entry) => entry.type === "close"), [{ type: "close", paneId: "fake-pane-1" }]);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("closes a pane when visible-child readiness fails", async () => {
		const fake = installFakeCommands();
		process.env.FAKE_VISIBLE_BAD_REGISTER = "1";
		const host = new ExtensionHost();
		try {
			await assert.rejects(() => host.execute("team_spawn", {
				team: "startup-failure-team",
				teamPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [{ name: "broken", prompt: "wait", model: "fake-model", thinking: "low" }],
			}), /Invalid visible teammate URL/);
			assert.deepEqual(lines(fake.logPath).filter((entry) => entry.type === "close"), [{ type: "close", paneId: "fake-pane-1" }]);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("rolls back already-created panes after a later Herdr start fails", async () => {
		const fake = installFakeCommands();
		process.env.FAKE_HERDR_FAIL_START = "2";
		const host = new ExtensionHost();
		try {
			await assert.rejects(() => host.execute("team_spawn", {
				team: "rollback-team",
				teamPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [
					{ name: "first", prompt: "wait", model: "fake-model", thinking: "low" },
					{ name: "second", prompt: "wait", model: "fake-model", thinking: "low" },
				],
			}), /planned start failure/);
			assert.deepEqual(lines(fake.logPath).filter((entry) => entry.type === "close"), [{ type: "close", paneId: "fake-pane-1" }]);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});
});

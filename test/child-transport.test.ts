import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "bun:test";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import teamExtension from "../index.ts";
import { childToolNames, registerChildTools } from "../child-tools.ts";
import { loadAsBunStandalonePi, loadWithProcess, useEnvironment, useFakePiPackage } from "./pi-launch.ts";

type JsonRecord = Record<string, unknown>;
type ToolResult = { content: Array<{ type: string; text: string }>; details?: JsonRecord };
type RegisteredTool = { name: string; parameters: TSchema; execute: (id: string, params: JsonRecord, signal: AbortSignal, update: undefined, context: unknown) => Promise<ToolResult> };
type ExtensionEventHandler = (event: JsonRecord, context: unknown) => Promise<void> | void;

const fakeMainSessionFile = "/tmp/pi-simple-team-main-session.jsonl";
// The runtime path that main loaded with, later deleted, as when a Homebrew upgrade removes the old Node keg.
const removedRuntime = "/tmp/pi-simple-team-removed-runtime/bin/node";
const fakeMainContext = {
	cwd: process.cwd(),
	scopedModels: [],
	modelRegistry: { getAvailable: () => [{ provider: "fake", id: "fake-model" }], find: () => undefined },
	sessionManager: {
		getCwd: () => process.cwd(),
		getSessionFile: () => fakeMainSessionFile,
		getSessionId: () => "fake-main-session-id",
	},
};

class ExtensionHost {
	readonly tools = new Map<string, RegisteredTool>();
	readonly shutdownHandlers: ExtensionEventHandler[] = [];
	readonly messages: JsonRecord[] = [];
	readonly commands = new Map<string, { handler: (args: string, context: ExtensionCommandContext) => Promise<void> }>();

	constructor() {
		const api = {
			on: (event: string, handler: ExtensionEventHandler) => {
				if (event === "session_shutdown") this.shutdownHandlers.push(handler);
				if (event === "session_start") handler({ reason: "startup" }, fakeMainContext);
			},
			registerCommand: (name: string, command: { handler: (args: string, context: ExtensionCommandContext) => Promise<void> }) => this.commands.set(name, command),
			registerMessageRenderer: () => undefined,
			registerTool: (tool: RegisteredTool) => this.tools.set(tool.name, tool),
			getActiveTools: () => [...this.tools.keys()],
			setActiveTools: () => undefined,
			sendMessage: (message: JsonRecord) => { this.messages.push(message); },
		} as unknown as ExtensionAPI;
		teamExtension(api);
	}

	async execute(toolName: string, params: JsonRecord, context: unknown = fakeMainContext, signal = new AbortController().signal): Promise<ToolResult> {
		const tool = this.tools.get(toolName);
		assert.ok(tool, `Expected ${toolName} to be registered`);
		return tool.execute("test", params, signal, undefined, context);
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
// A resumed session reports the facts it recorded at spawn.
const settingsPath = sessionFile + ".settings.json";
const runtimeFacts = sessionArgumentIndex === -1
  ? { model: args[args.indexOf("--model") + 1], thinking: args[args.indexOf("--thinking") + 1], contextPercent: null }
  : JSON.parse(fs.readFileSync(settingsPath, "utf8"));
fs.writeFileSync(settingsPath, JSON.stringify(runtimeFacts));
record({ type: "pi_start", executable: process.argv[1], args, sessionId, sessionFile, pid: process.pid, member: process.env.PI_SIMPLE_TEAM_MEMBER });
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
    body: JSON.stringify({ token: process.env.PI_SIMPLE_TEAM_CALLBACK_TOKEN, team: process.env.PI_SIMPLE_TEAM_TEAM, from: process.env.PI_SIMPLE_TEAM_MEMBER, process: process.env.PI_SIMPLE_TEAM_PROCESS, tool, args }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
// As the real child does: one connection per process, opened when main offers a lifeline port.
let lifeline;
let lifelinePort;
async function register(url) {
  const registration = await parent("register", { url, sessionId, sessionFile, ...runtimeFacts });
  if (registration.lifelinePort && !lifeline) {
    lifelinePort = registration.lifelinePort;
    lifeline = require("node:net").connect(registration.lifelinePort, "127.0.0.1", () => lifeline.write(JSON.stringify({ token: process.env.PI_SIMPLE_TEAM_CALLBACK_TOKEN, team: process.env.PI_SIMPLE_TEAM_TEAM, from: process.env.PI_SIMPLE_TEAM_MEMBER, process: process.env.PI_SIMPLE_TEAM_PROCESS }) + "\n"));
  }
  record({ type: "ready", url, pid: process.pid, member: process.env.PI_SIMPLE_TEAM_MEMBER, lifelineOffered: Boolean(registration.lifelinePort) });
}
// A lingering process ignores the SIGTERM of a pane close, as a hung Pi would.
let lingering = false;
// Sends a quit callback from a helper process after this process has died, as a callback still in flight when Pi died would arrive.
function dieMidQuit() {
  const body = JSON.stringify({ token: process.env.PI_SIMPLE_TEAM_CALLBACK_TOKEN, team: process.env.PI_SIMPLE_TEAM_TEAM, from: process.env.PI_SIMPLE_TEAM_MEMBER, process: process.env.PI_SIMPLE_TEAM_PROCESS, tool: "event", args: { event: { type: "session_shutdown", reason: "quit", signal: "SIGHUP" } } });
  const helper = "setTimeout(async () => { await fetch(" + JSON.stringify(process.env.PI_SIMPLE_TEAM_CALLBACK_URL) + ", { method: 'POST', headers: { 'content-type': 'application/json' }, body: " + JSON.stringify(body) + " }); require('node:fs').appendFileSync(" + JSON.stringify(process.env.PI_SIMPLE_TEAM_TEST_HERDR_EVENTS) + ", JSON.stringify({ type: 'late_quit_sent' }) + '\\n'); }, 300);";
  require("node:child_process").spawn(process.execPath, ["-e", helper], { stdio: "ignore", detached: true }).unref();
  process.kill(process.pid, "SIGKILL");
}
async function exitWhenGateOpens(code) {
  await fetch(process.env.PI_SIMPLE_TEAM_TEST_EXIT_GATE);
  process.exit(code);
}
async function quitThenExit(code) {
  await parent("event", { event: { type: "session_shutdown", reason: "quit" } });
  await fetch(process.env.PI_SIMPLE_TEAM_TEST_EXIT_GATE);
  process.exit(code);
}
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  record({ type: "delivery", body, pid: process.pid });
  if (body.token !== process.env.PI_SIMPLE_TEAM_CALLBACK_TOKEN) {
    response.writeHead(403); response.end(); return;
  }
  if (body.tool === "get_context_window_usage") {
    response.end(JSON.stringify({ contextUsage: { tokens: 87_000, contextWindow: 272_000, percent: 31.985 } }));
    return;
  }
  if (body.args.message === "reject-this-message" || process.env.PI_SIMPLE_TEAM_TEST_REJECT_MEMBER === body.args.to) {
    response.writeHead(503); response.end("planned delivery failure"); return;
  }
  if (body.args.message === "publish-failure-to-peer") await parent("team_send_message", { targets: ["recipient"], message: "reject-this-message" });
  if (body.args.message === "report-runtime-facts") {
    await parent("event", { event: { type: "runtime_facts", model: "fake/fake-model", thinking: "off", contextPercent: 57.4 } });
    response.end(JSON.stringify({ accepted: true }));
    return;
  }
  if (body.args.triggerTurn === false) {
    response.end(JSON.stringify({ accepted: true }));
    return;
  }
  // A process that main no longer counts as live, and that still talks to main after main restarted its teammate.
  const lingerAsStale = async () => {
    lingering = true;
    await parent("event", { event: { type: "session_shutdown", reason: "new" } });
    await fetch(process.env.PI_SIMPLE_TEAM_TEST_EXIT_GATE);
    const attempt = (tool, args) => parent(tool, args).then(() => "accepted", (error) => "rejected: " + error.message);
    // A second lifeline hello with this process's id: main must close it at once.
    const lifelineRefused = await new Promise((resolve) => {
      const socket = require("node:net").connect(lifelinePort, "127.0.0.1", () => socket.write(JSON.stringify({ token: process.env.PI_SIMPLE_TEAM_CALLBACK_TOKEN, team: process.env.PI_SIMPLE_TEAM_TEAM, from: process.env.PI_SIMPLE_TEAM_MEMBER, process: process.env.PI_SIMPLE_TEAM_PROCESS }) + "\n"));
      socket.on("close", () => resolve("refused"));
      socket.on("error", () => undefined);
      setTimeout(() => { socket.destroy(); resolve("kept open"); }, 1000);
    });
    const outcomes = {
      lifeline: lifelineRefused,
      quit: await attempt("event", { event: { type: "session_shutdown", reason: "quit" } }),
      register: await attempt("register", { url: "http://127.0.0.1:" + server.address().port + "/deliver", sessionId, sessionFile, ...runtimeFacts }),
    };
    record({ type: "stale_result", outcomes });
    process.exit(0);
  };
  const shutDown = async (event) => { await parent("event", { event: { type: "session_shutdown", ...event } }); };
  const exits = {
    "exit-when-gate-opens": () => exitWhenGateOpens(143), "quit-slowly": () => quitThenExit(0), "exit-now": () => process.exit(7), "linger-as-stale": lingerAsStale,
    "quit-on-sighup": async () => { await shutDown({ reason: "quit", signal: "SIGHUP" }); process.exit(0); },
    "quit-by-itself": async () => { await shutDown({ reason: "quit" }); process.exit(0); },
    "die-mid-quit": dieMidQuit,
    "replace-session": async () => { await shutDown({ reason: "new" }); await register("http://127.0.0.1:" + server.address().port + "/deliver"); },
  };
  if (exits[body.args.message]) {
    response.end(JSON.stringify({ accepted: true }), () => setTimeout(exits[body.args.message], 20));
    return;
  }
  const settlements = {
    "fail-this-run": { aborted: false, outcome: "error", errorMessage: "400: quota fixture" },
    "cancel-this-run": { aborted: true, outcome: "error", errorMessage: "This operation was aborted" },
    "complete-this-run": { aborted: false, outcome: "completed" },
  };
  if (settlements[body.args.message]) {
    await parent("event", { event: { type: "agent_start" } });
    await parent("event", { event: { type: "agent_settled", ...settlements[body.args.message] } });
    response.end(JSON.stringify({ accepted: true }));
    return;
  }
  if (body.args.message === "hold-until-released") await fetch(process.env.PI_SIMPLE_TEAM_TEST_DELIVERY_GATE);
  fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId }) + "\n");
  await parent("event", { event: { type: "agent_start" } });
  await parent("event", { event: { type: "tool_execution_start", toolName: "read", toolCallId: "fake-call", args: { path: "README.md" } } });
  await parent("event", { event: { type: "tool_execution_end", toolName: "read", toolCallId: "fake-call", isError: false, result: { output: "ok" } } });
  await parent("event", { event: { type: "agent_end", messages: [] } });
  response.end(JSON.stringify({ accepted: true }));
});
server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const badRegister = process.env.PI_SIMPLE_TEAM_TEST_CHILD_BAD_REGISTER || process.env.PI_SIMPLE_TEAM_TEST_BAD_REGISTER_MEMBER === process.env.PI_SIMPLE_TEAM_MEMBER;
  const url = badRegister ? "http://localhost:1234/deliver" : "http://127.0.0.1:" + address.port + "/deliver";
  try {
    if (process.env.PI_SIMPLE_TEAM_TEST_DIE_BEFORE_REGISTER_MEMBER === process.env.PI_SIMPLE_TEAM_MEMBER) process.exit(3);
    if (process.env.PI_SIMPLE_TEAM_TEST_REGISTRATION_GATE) await fetch(process.env.PI_SIMPLE_TEAM_TEST_REGISTRATION_GATE + "?name=" + process.env.PI_SIMPLE_TEAM_MEMBER);
    await register(url);
    if (process.env.PI_SIMPLE_TEAM_TEST_EXIT_WHEN_GATE_OPENS_MEMBER === process.env.PI_SIMPLE_TEAM_MEMBER) void exitWhenGateOpens(143);
  } catch (error) {
    record({ type: "register_error", error: String(error) });
    process.exit(1);
  }
});
process.on("SIGTERM", async () => {
  record({ type: "sigterm", member: process.env.PI_SIMPLE_TEAM_MEMBER });
  if (lingering) return;
  if (process.env.PI_SIMPLE_TEAM_TEST_QUIT_ON_SIGTERM_MEMBER === process.env.PI_SIMPLE_TEAM_MEMBER) { await parent("event", { event: { type: "session_shutdown", reason: "quit", signal: "SIGTERM" } }); process.exit(0); }
  if (process.env.PI_SIMPLE_TEAM_TEST_SLOW_STOP_MEMBER === process.env.PI_SIMPLE_TEAM_MEMBER) { setTimeout(() => process.exit(0), 5000); return; }
  server.close(() => process.exit(0));
});
`;

const pathPiScript = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.PI_SIMPLE_TEAM_TEST_HERDR_EVENTS, JSON.stringify({ type: "path_pi_start" }) + "\n");
process.exit(1);
`;

const fakeHerdr = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const logPath = process.env.PI_SIMPLE_TEAM_TEST_HERDR_LOG;
function record(value) { fs.appendFileSync(logPath, JSON.stringify(value) + "\n"); }
if (args[0] === "status") {
  process.stdout.write(JSON.stringify({ server: { running: true, compatible: true } }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "split") {
  const countPath = process.env.PI_SIMPLE_TEAM_TEST_HERDR_START_COUNT;
  const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, "utf8") : "0") + 1;
  fs.writeFileSync(countPath, String(count));
  if (Number(process.env.PI_SIMPLE_TEAM_TEST_HERDR_FAIL_START ?? "0") === count) {
    process.stderr.write("planned start failure"); process.exit(1);
  }
  const paneId = "fake-pane-" + count;
  const environment = { ...process.env, HERDR_PANE_ID: paneId };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--env") continue;
    const split = args[index + 1].indexOf("=");
    environment[args[index + 1].slice(0, split)] = args[index + 1].slice(split + 1);
    index += 1;
  }
  fs.writeFileSync(path.join(path.dirname(logPath), paneId + ".json"), JSON.stringify(environment));
  record({ type: "split", paneId, args });
  process.stdout.write(JSON.stringify({ result: { pane: { pane_id: paneId }, type: "pane_split" } }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "rename") {
  record({ type: "rename", paneId: args[2], name: args[3] });
  process.stdout.write(JSON.stringify({ result: { type: "ok" } }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "run") {
  const paneId = args[2];
  const environment = JSON.parse(fs.readFileSync(path.join(path.dirname(logPath), paneId + ".json"), "utf8"));
  const child = spawn("/bin/sh", ["-c", args[3]], { env: environment, detached: true, stdio: "ignore" });
  child.unref();
  fs.appendFileSync(process.env.PI_SIMPLE_TEAM_TEST_HERDR_CHILDREN, JSON.stringify({ paneId, pid: child.pid }) + "\n");
  record({ type: "start", paneId, command: args[3], args });
  process.stdout.write(JSON.stringify({ result: { type: "ok" } }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "close") {
  const paneId = args[2];
  record({ type: "close", paneId });
  const children = (fs.existsSync(process.env.PI_SIMPLE_TEAM_TEST_HERDR_CHILDREN) ? fs.readFileSync(process.env.PI_SIMPLE_TEAM_TEST_HERDR_CHILDREN, "utf8").trim().split("\n") : []);
  for (const line of children) {
    if (!line) continue;
    const child = JSON.parse(line);
    if (child.paneId === paneId) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
  }
  if (process.env.PI_SIMPLE_TEAM_TEST_HERDR_PANE_NOT_FOUND === paneId) {
    process.stderr.write(JSON.stringify({ error: { code: "pane_not_found", message: "pane " + paneId + " not found" }, id: "cli:pane:close" }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ id: "fake", result: { type: "ok" } }));
  process.exit(0);
}
process.stderr.write("unexpected fake Herdr command: " + args.join(" ")); process.exit(2);
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
	const previousExecutable = process.argv[1]!;
	// Main runs inside an SDK host script. The parent Pi is the fake Pi package's CLI.
	const sdkHost = path.join(directory, "sdk-host.mjs");
	fs.writeFileSync(sdkHost, "// An SDK host embeds Pi. It is not Pi.\n");
	process.argv[1] = sdkHost;
	const restorePiPackage = useFakePiPackage(directory, "parent-pi");
	const restoreEnvironment = useEnvironment({
		PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
		PI_CODING_AGENT_DIR: agentDirectory,
		HERDR_TAB_ID: "fake-tab",
		HERDR_PANE_ID: "main-pane",
		PI_SIMPLE_TEAM_TEST_HERDR_LOG: logPath,
		PI_SIMPLE_TEAM_TEST_HERDR_EVENTS: eventsPath,
		PI_SIMPLE_TEAM_TEST_HERDR_SESSIONS: sessionsDirectory,
		PI_SIMPLE_TEAM_TEST_HERDR_CHILDREN: childrenPath,
		PI_SIMPLE_TEAM_TEST_HERDR_START_COUNT: startCountPath,
		PI_SIMPLE_TEAM_TEST_HERDR_FAIL_START: undefined,
		PI_SIMPLE_TEAM_TEST_CHILD_BAD_REGISTER: undefined,
		PI_SIMPLE_TEAM_TEST_HERDR_PANE_NOT_FOUND: undefined,
	});
	return {
		directory,
		logPath,
		eventsPath,
		parentPiExecutable,
		restore: () => {
			const survivors = waitForFakePiProcessesToEnd(eventsPath);
			process.argv[1] = previousExecutable;
			restorePiPackage();
			restoreEnvironment();
			fs.rmSync(directory, { recursive: true, force: true });
			assert.deepEqual(survivors, [], "Every fake Pi process this test started must have ended by the time main shut down. Survivors were killed.");
		},
	};
}

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Gives the fake Pi processes of one test two seconds to end, then kills and returns the ones that are still running. */
function waitForFakePiProcessesToEnd(eventsPath: string): JsonRecord[] {
	const started = lines(eventsPath).filter((entry) => entry.type === "pi_start").map((entry) => ({ member: entry.member, pid: Number(entry.pid) }));
	for (let waited = 0; waited < 2_000 && started.some((child) => processIsRunning(child.pid)); waited += 50) Bun.sleepSync(50);
	const survivors = started.filter((child) => processIsRunning(child.pid));
	for (const survivor of survivors) process.kill(survivor.pid, "SIGKILL");
	return survivors;
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

async function startChildCallbackReceiver(failingLifecycleEvents: number, lifelinePort?: number): Promise<{ url: string; requests: CallbackRequest[]; close: () => Promise<void> }> {
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
		response.end(JSON.stringify({ accepted: true, ...(body.tool === "register" && lifelinePort ? { lifelinePort } : {}) }));
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

async function startChildRuntimeForTest(failingLifecycleEvents: number, lifelinePort?: number): Promise<{ handlers: Map<string, ChildHandler>; messages: JsonRecord[]; requests: CallbackRequest[]; close: () => Promise<void> }> {
	const receiver = await startChildCallbackReceiver(failingLifecycleEvents, lifelinePort);
	const config = {
		callbackUrl: receiver.url,
		callbackToken: "child-token",
		teamName: "child-team",
		teammateName: "reviewer", processId: "test-process",
		participants: ["main", "reviewer"],
		canManageOwnTeams: false,
		interruptWaitTimeoutMilliseconds: 250,
	};
	const handlers = new Map<string, ChildHandler>();
	const messages: JsonRecord[] = [];
	const api = {
		on: (event: string, handler: ChildHandler) => handlers.set(event, handler),
		registerMessageRenderer: () => undefined,
		registerTool: () => undefined,
		getActiveTools: () => [...childToolNames],
		setActiveTools: () => undefined,
		sendMessage: (message: JsonRecord) => messages.push(message),
	};
	registerChildTools(api as unknown as ExtensionAPI, config);
	await handlers.get("session_start")?.({}, {
		shutdown: () => undefined,
		model: { provider: "fake", id: "fake-model" },
		thinkingLevel: "high",
		getContextUsage: () => ({ tokens: 87_000, contextWindow: 272_000, percent: 31.985 }),
		sessionManager: {
			getBranch: () => [],
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
	test("a teammate activates every team tool that its restored tool loadout lacks before it registers", async () => {
		const receiver = await startChildCallbackReceiver(0);
		const handlers = new Map<string, ChildHandler>();
		const registeredTools: string[] = [];
		// Pi 1.3 gives a forked teammate main's recorded loadout, which never declared send_main_message.
		let activeTools = ["read", "bash", "team_status", "team_send_message"];
		let registeredBeforeActivation: boolean | undefined;
		const api = {
			on: (event: string, handler: ChildHandler) => handlers.set(event, handler),
			registerMessageRenderer: () => undefined,
			registerTool: (tool: { name: string }) => registeredTools.push(tool.name),
			getActiveTools: () => [...activeTools],
			setActiveTools: (toolNames: string[]) => {
				registeredBeforeActivation = receiver.requests.some((request) => request.tool === "register");
				activeTools = toolNames;
			},
			sendMessage: () => undefined,
		};
		registerChildTools(api as unknown as ExtensionAPI, {
			callbackUrl: receiver.url,
			callbackToken: "child-token",
			teamName: "child-team",
			teammateName: "reviewer", processId: "test-process",
			participants: ["main", "reviewer"],
			canManageOwnTeams: false,
		});
		try {
			assert.deepEqual(registeredTools, [...childToolNames], "childToolNames must list exactly the tools a teammate registers.");
			await handlers.get("session_start")?.({}, {
				shutdown: () => undefined,
				model: { provider: "fake", id: "fake-model" },
				thinkingLevel: "high",
				getContextUsage: () => ({ tokens: 1_000, contextWindow: 272_000, percent: 0.4 }),
				sessionManager: {
					getBranch: () => [],
					getSessionId: () => "forked-child-session-id",
					getSessionFile: () => "/tmp/forked-child-session.jsonl",
				},
			});
			assert.deepEqual(
				activeTools,
				["read", "bash", "team_status", "team_send_message", "get_context_window_usage", "send_main_message"],
				"A teammate must keep its restored tools and gain every missing team tool.",
			);
			assert.equal(registeredBeforeActivation, false, "Team tools must be active before registration lets main start the teammate's work.");
			assert.ok(receiver.requests.some((request) => request.tool === "register"), "The teammate must still register with main.");
		} finally {
			await handlers.get("session_shutdown")?.({ reason: "quit" });
			await receiver.close();
		}
	});

	test("forwards the cancellation flag and the last turn's outcome from final settlements", async () => {
		const child = await startChildRuntimeForTest(0);
		const context = { model: { provider: "fake", id: "fake-model" }, thinkingLevel: "high", getContextUsage: () => ({ tokens: 1, contextWindow: 272_000, percent: 1 }) };
		try {
			await child.handlers.get("agent_settled")?.({ aborted: true });
			await child.handlers.get("turn_end")?.({ outcome: "error", message: { role: "assistant", stopReason: "error", errorMessage: "400: quota fixture" } }, context);
			await child.handlers.get("agent_settled")?.({ aborted: false });
			await child.handlers.get("agent_start")?.({}, context);
			await child.handlers.get("agent_settled")?.({ aborted: false });
			await waitFor(() => child.requests.filter((request) => request.tool === "event").length === 5);
			assert.deepEqual(child.requests.filter((request) => request.tool === "event" && request.args.event.type === "agent_settled").map((request) => request.args.event), [
				{ type: "agent_settled", aborted: true, outcome: "completed" },
				{ type: "agent_settled", aborted: false, outcome: "error", errorMessage: "400: quota fixture" },
				{ type: "agent_settled", aborted: false, outcome: "completed" },
			], "The shared RPC/Herdr callback must not discard either cancellation value, and a run's failure must not outlive it.");
		} finally {
			await child.close();
		}
	});

	test("idle resume reports work queued before the child starts its turn", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		let held = false;
		let release = (): void => undefined;
		const gatePromise = new Promise<void>((resolve) => { release = resolve; });
		const gate = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(): Promise<Response> { held = true; await gatePromise; return new Response("continue"); } });
		process.env.PI_SIMPLE_TEAM_TEST_DELIVERY_GATE = `http://127.0.0.1:${gate.port}`;
		try {
			await host.execute("team_spawn", { teamName: "queued-work", commonPrompt: "Wait.", startIdle: true, teammates: [{ name: "probe", systemPrompt: "Wait.", model: "fake/fake-model" }] });
			await host.execute("team_send_message", { targets: ["probe"], message: "hold-until-released" });
			await waitFor(() => held);
			const resumed = await host.execute("team_resume", { team: "queued-work", startIdle: true });
			assert.equal(resumed.details?.started, true, "Queued work must not be reported as an idle team just because the model turn has not started.");
			assert.equal((resumed.details?.alreadyActiveTeammates as JsonRecord[])?.[0]?.name, "probe", "The result must identify the already-queued teammate.");
		} finally {
			release();
			await host.shutdown();
			gate.stop(true);
			delete process.env.PI_SIMPLE_TEAM_TEST_DELIVERY_GATE;
			fake.restore();
		}
	});

	test("automatic kickoff gives a forked teammate its own identity and assignment", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		const assignment = "Write the assigned marker yourself, then tell main.";
		try {
			await host.execute("team_spawn", { teamName: "fork-assignment", commonPrompt: "Main coordinates the work.", teammates: [{ name: "copier", systemPrompt: assignment, model: "fake/fake-model", forkContext: true }] });
			const delivery = lines(fake.eventsPath).find((entry) => entry.type === "delivery");
			const message = String(((delivery?.body as JsonRecord)?.args as JsonRecord)?.message);
			assert.ok(message.includes("copier") && message.includes(assignment), `The latest instruction must identify the teammate and its own assignment. Got: ${message}`);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("cancelling startup prevents automatic work and removes the prepared team", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		let held = false;
		let release: () => void = () => undefined;
		const readinessGate = new Promise<void>((resolve) => { release = resolve; });
		const gate = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(): Promise<Response> {
			held = true;
			await readinessGate;
			return new Response("ready");
		} });
		process.env.PI_SIMPLE_TEAM_TEST_REGISTRATION_GATE = `http://127.0.0.1:${gate.port}`;
		const controller = new AbortController();
		const spawning = host.execute("team_spawn", { teamName: "cancelled-start", commonPrompt: "Work.", teammates: [{ name: "probe", systemPrompt: "Work.", model: "fake/fake-model" }] }, fakeMainContext, controller.signal);
		try {
			await waitFor(() => held);
			controller.abort();
			release();
			await assert.rejects(() => spawning, /abort/i, "Cancelling startup must reject instead of starting work.");
			assert.equal(lines(fake.eventsPath).filter((entry) => entry.type === "delivery").length, 0, "No kickoff may follow cancellation during startup.");
			const listing = await host.execute("team_list", {});
			assert.deepEqual(listing.details?.teams, [], "A cancelled unstarted team must not remain active.");
		} finally {
			release();
			await spawning.catch(() => undefined);
			await host.shutdown();
			delete process.env.PI_SIMPLE_TEAM_TEST_REGISTRATION_GATE;
			gate.stop(true);
			fake.restore();
		}
	});

	test("concurrent team creation gives both teams a registered delivery runtime", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			const outcomes = await Promise.allSettled(["first-room", "second-room"].map((teamName) => host.execute("team_spawn", {
				teamName, commonPrompt: "Wait.", startIdle: true,
				teammates: [{ name: teamName, systemPrompt: "Wait.", model: "fake/fake-model" }],
			})));
			const failures = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [String(outcome.reason)] : []);
			const registrationErrors = lines(fake.eventsPath).filter((entry) => entry.type === "register_error");
			assert.deepEqual(failures, [], `Concurrent spawns must both receive a usable parent delivery address. Registration errors: ${JSON.stringify(registrationErrors)}`);
			const listing = await host.execute("team_list", {});
			assert.equal((listing.details?.teams as JsonRecord[])?.length, 2, "Both teams must remain independently discoverable.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("an empty team does not tell main to expect teammate progress", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			const result = await host.execute("team_spawn", { teamName: "empty-room", commonPrompt: "No members yet.", teammates: [] });
			assert.equal(result.details?.started, false, "An empty team cannot start teammate work.");
			assert.doesNotMatch(String(result.details?.instruction), /will message|15 minutes/, "An empty team must not tell main to wait for nonexistent work.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("the team log retains complete resumption instructions even when the team starts idle", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		const resumptionPrompt = "Detailed instructions. ".repeat(20) + "RESUMPTION_TAIL";
		try {
			await host.execute("team_spawn", { teamName: "resumption-log", commonPrompt: "Wait.", startIdle: true, teammates: [{ name: "probe", systemPrompt: "Wait.", model: "fake/fake-model" }] });
			await host.execute("team_shutdown", { team: "resumption-log" });
			await host.execute("team_resume", { team: "resumption-log", startIdle: true, resumptionPrompt });
			const log = await host.execute("team_log", { targets: ["resumption-log"], search: "RESUMPTION_TAIL" });
			const entries = log.details?.entries as Array<{ kind: string; details?: JsonRecord }>;
			assert.ok(entries?.some((entry) => entry.kind === "send" && String(entry.details?.message).endsWith(resumptionPrompt)), "Resumption must preserve the full published message in the same log as ordinary sends.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("ambiguous team selection returns names mapped to every available team ID", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			for (const sessionId of ["first-owner", "second-owner"]) {
				await host.execute("team_spawn", { teamName: "review", commonPrompt: "Wait.", teammates: [] }, { ...fakeMainContext, sessionManager: { ...fakeMainContext.sessionManager, getSessionId: () => sessionId } });
			}
			for (const parameters of [{ team: "review" }, { phrase: "Working." }]) {
				await assert.rejects(() => host.execute("team_status", parameters), (error: unknown) => {
					assert.ok(error instanceof Error, "An ambiguous selection must return an actionable tool error.");
					assert.ok(error.message.includes('"review":["first-owner-review","second-owner-review"]'), `The error must map the name to both IDs. Got: ${error.message}`);
					assert.match(error.message, /team parameter|team explicitly/, "The error must identify where to pass the selected ID.");
					return true;
				});
			}
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("message publication and shutdown return explicit identities without redundant fields", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			const spawned = await host.execute("team_spawn", { teamName: "message-result", commonPrompt: "Wait.", startIdle: true, teammates: [{ name: "probe", systemPrompt: "Wait.", model: "fake/fake-model" }] });
			const result = await host.execute("team_send_message", { targets: ["probe"], message: "Work." });
			const content = JSON.parse(result.content[0].text) as JsonRecord;
			assert.equal(content.published, true, "The result must truthfully acknowledge publication.");
			const publishedTeam = (content.teams as JsonRecord[])?.[0];
			assert.equal(publishedTeam?.teamId, spawned.details?.teamId, "Publication identifies the intended team.");
			assert.ok((publishedTeam?.status as JsonRecord)?.probe, "Publication returns the whole team's statuses.");
			assert.ok(!("interrupt" in content) && !("accepted" in content), "Publication must not echo interruption settings or use the old acknowledgment.");
			assert.match(String(content.instruction), /Do not wait for replies/, "Post-send guidance belongs in the success result.");
			await waitFor(() => lines(fake.eventsPath).some((entry) => entry.type === "delivery"));
			const stopped = await host.execute("team_shutdown", { team: "message-result" });
			assert.equal(stopped.details?.teamId, spawned.details?.teamId, "Shutdown must preserve the returned team identity.");
			assert.deepEqual(stopped.details?.teammates, (spawned.details?.teammates as JsonRecord[]).map(({ name, teammateId }) => ({ name, teammateId })), "Shutdown must return teammate names and Pi session IDs for later recovery.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("list returns a complete teammate record without parallel name or session identity fields", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		const specification = { name: "probe", systemPrompt: "Remember these instructions.", model: "fake/fake-model", thinking: "high", forkContext: false, canManageOwnTeams: true, showOnHerdrPane: false };
		try {
			const spawned = await host.execute("team_spawn", { teamName: "listed-record", commonPrompt: "Shared instructions.", startIdle: true, teammates: [specification] });
			const listed = await host.execute("team_list", {});
			const team = (listed.details?.teams as JsonRecord[])?.[0];
			assert.equal(team?.teamId, spawned.details?.teamId, "List and spawn must expose the same explicitly named team ID.");
			assert.equal(team?.teamName, "listed-record", "List must identify the team name explicitly.");
			const teammate = (team?.teammates as JsonRecord[])?.[0];
			assert.ok(teammate && typeof teammate === "object", "List must return teammate records, not a duplicate name array.");
			for (const [field, value] of Object.entries(specification)) assert.equal(teammate[field], value, `List must retain teammate field ${field}.`);
			assert.equal(teammate.teammateId, (spawned.details?.teammates as JsonRecord[])[0]?.teammateId, "The listed teammate ID must be its Pi session ID.");
			assert.equal(typeof teammate.sessionFile, "string", "The full listing retains the session path for recovery.");
			assert.ok(!("members" in team) && !("sessionId" in teammate), "The listing must not repeat teammate or session identities.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("resume and add return complete rosters and whole-team statuses consistently", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			const spawned = await host.execute("team_spawn", { teamName: "lifecycle-results", commonPrompt: "Work.", teammates: [{ name: "original", systemPrompt: "Work.", model: "fake/fake-model" }] });
			const added = await host.execute("team_add_teammates", { teammates: [{ name: "added", systemPrompt: "Work.", model: "fake/fake-model" }] });
			assert.equal(added.details?.started, true, "Add must explicitly report that the new teammate started.");
			assert.equal(added.details?.teamId, spawned.details?.teamId, "Lifecycle results must use the same team identity.");
			assert.deepEqual((added.details?.teammates as JsonRecord[])?.map((member) => member.name), ["original", "added"], "Add must return the complete roster.");
			assert.deepEqual(Object.keys(added.details?.status as JsonRecord).sort(), ["added", "main", "original"], "Add must return the complete team's statuses.");
			await host.execute("team_shutdown", { team: "lifecycle-results" });
			const resumed = await host.execute("team_resume", { team: "lifecycle-results", teammates: ["original"], startIdle: true });
			assert.equal(resumed.details?.started, false, "Idle resume must not claim work started.");
			assert.equal(resumed.details?.teamId, spawned.details?.teamId, "Resume must retain the team's identity.");
			const members = resumed.details?.teammates as JsonRecord[];
			assert.equal(members?.[0]?.contextRestored, true, "Resume must disclose whether saved context was restored.");
			assert.equal(members?.[0]?.teammateId, (spawned.details?.teammates as JsonRecord[])?.[0]?.teammateId, "Resume must retain the Pi session identity.");
			assert.deepEqual(Object.keys(resumed.details?.status as JsonRecord).sort(), ["added", "main", "original"], "Resume must return the complete team's statuses.");
			assert.ok(!("sessions" in resumed.details!) && !("resumed" in resumed.details!) && !("restartedEmpty" in resumed.details!), "Resume must not duplicate affected identities across parallel fields.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("spawn accepts the reviewed input names and returns one durable teammate identity", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		const parameters = { teamName: "public-spawn", commonPrompt: "Shared instructions.", startIdle: true, teammates: [{ name: "probe", systemPrompt: "Individual instructions.", model: "fake/fake-model", forkContext: false, canManageOwnTeams: false }] };
		try {
			const schema = host.tools.get("team_spawn")?.parameters;
			assert.ok(schema, "Spawn must be registered.");
			assert.equal(Value.Check(schema, parameters), true, "Spawn must accept the reviewed public input names.");
			const result = await host.execute("team_spawn", parameters);
			const content = JSON.parse(result.content[0].text) as JsonRecord;
			const started = lines(fake.eventsPath).find((entry) => entry.type === "pi_start");
			assert.equal(content.teamName, "public-spawn", "The result must identify the team name explicitly.");
			assert.equal(content.teamId, "fake-main-session-id-public-spawn", "The result must identify the durable team ID explicitly.");
			assert.equal(content.started, false, "The result must not claim work started for an idle spawn.");
			assert.deepEqual((content.teammates as JsonRecord[])?.map(({ name, teammateId }) => ({ name, teammateId })), [{ name: "probe", teammateId: started?.sessionId }], "The Pi session ID must be returned once, as teammateId.");
			assert.ok(!("sessions" in content) && !("status" in content), "Spawn must not repeat identity data or return routine initial statuses.");
			assert.match(String(content.instruction), /team_send_message.*idle/s, "An idle result must tell the caller how to start work later.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("a partial kickoff failure identifies started and failed teammates without losing the team", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		process.env.PI_SIMPLE_TEAM_TEST_REJECT_MEMBER = "broken";
		try {
			await assert.rejects(() => host.execute("team_spawn", { teamName: "partial-start", commonPrompt: "Work.", teammates: [
				{ name: "working", systemPrompt: "Work.", model: "fake/fake-model" },
				{ name: "broken", systemPrompt: "Work.", model: "fake/fake-model" },
			] }), /started.*working[\s\S]*failed.*broken/i, "The error must identify partial effects rather than imply that nothing started.");
			const status = await host.execute("team_status", { team: "partial-start" });
			assert.ok((status.details?.status as JsonRecord)?.working, "The partially started team must remain inspectable.");
		} finally {
			delete process.env.PI_SIMPLE_TEAM_TEST_REJECT_MEMBER;
			await host.shutdown();
			fake.restore();
		}
	});

	test("a teammate receives its own peer-delivery failure instead of notifying main", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", { teamName: "peer-error", commonPrompt: "Wait.", startIdle: true, teammates: [
				{ name: "sender", systemPrompt: "Wait.", model: "fake/fake-model" },
				{ name: "recipient", systemPrompt: "Wait.", model: "fake/fake-model" },
			] });
			await host.execute("team_send_message", { targets: ["sender"], message: "publish-failure-to-peer" });
			await waitFor(() => lines(fake.eventsPath).some((entry) => entry.type === "delivery" && String(((entry.body as JsonRecord).args as JsonRecord).message).startsWith("Message delivery failed")));
			const notifications = lines(fake.eventsPath).filter((entry) => entry.type === "delivery").map((entry) => (entry.body as JsonRecord).args as JsonRecord).filter((args) => String(args.message).startsWith("Message delivery failed"));
			assert.deepEqual(notifications.map((args) => args.to), ["sender"], "Only the original teammate sender should receive its delivery failure.");
			assert.equal(host.messages.length, 0, "A peer-delivery failure must not be misrouted to main.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("a delivery failure after publication is pushed to the sending main session", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", { teamName: "failed-delivery", commonPrompt: "Wait.", startIdle: true, teammates: [{ name: "recipient", systemPrompt: "Wait.", model: "fake/fake-model" }] });
			await host.execute("team_send_message", { targets: ["recipient"], message: "reject-this-message" });
			await waitFor(() => host.messages.length > 0);
			const notification = String(host.messages[0]?.content);
			assert.ok(notification.includes("recipient") && notification.includes("failed-delivery") && notification.includes("reject-this-message") && notification.includes("planned delivery failure"), `The sender needs the team, recipient, original message, and cause. Got: ${notification}`);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("a failed run sets the teammate's error status with the provider's message until a later run completes", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		const probeStatus = async (): Promise<JsonRecord> => ((await host.execute("team_status", { team: "failed-run" })).details?.status as Record<string, JsonRecord>).probe;
		const logRows = async (): Promise<JsonRecord[]> => (await host.execute("team_log", { targets: ["failed-run"], limit: 100 })).details?.entries as JsonRecord[];
		const settlements = (): number => lines(fake.eventsPath).filter((entry) => entry.type === "parent" && entry.tool === "event" && ((entry.args as JsonRecord).event as JsonRecord).type === "agent_settled").length;
		try {
			await host.execute("team_spawn", { teamName: "failed-run", commonPrompt: "Wait.", startIdle: true, teammates: [{ name: "probe", systemPrompt: "Wait.", model: "fake/fake-model" }] });
			await host.execute("team_send_message", { targets: ["probe"], message: "fail-this-run" });
			await waitFor(() => settlements() === 1);
			const failed = await probeStatus();
			assert.deepEqual({ word: failed.word, phrase: failed.phrase }, { word: "error", phrase: "400: quota fixture" }, "A failed run must show as an error status carrying the provider's message.");
			const errorRows = (await logRows()).filter((entry) => entry.kind === "error");
			assert.deepEqual(errorRows.map((entry) => entry.summary), ["probe run failed: 400: quota fixture"], "The log must record the failed run once with the provider's message.");
			assert.deepEqual(host.messages.map((message) => message.content), [`Teammate "probe" on team "failed-run" (team ID: fake-main-session-id-failed-run) ended its latest run on an error.\nCause: 400: quota fixture\nEarlier steps of that run may have completed. Check the teammate's status and team_log before sending it more work.`], "A failed run must wake main once with the provider's message.");
			await host.execute("team_send_message", { targets: ["probe"], message: "cancel-this-run" });
			await waitFor(() => settlements() === 2);
			assert.deepEqual(await probeStatus(), failed, "A cancelled run must neither clear the failure nor replace its message.");
			assert.equal((await logRows()).filter((entry) => entry.kind === "error").length, 1, "A cancelled run must not add an error row.");
			await host.execute("team_send_message", { targets: ["probe"], message: "complete-this-run" });
			await waitFor(() => settlements() === 3);
			const recovered = await probeStatus();
			assert.deepEqual({ word: recovered.word, phrase: recovered.phrase }, { word: "idle", phrase: "Spawned" }, "A completed run must restore the status the failure replaced.");
			assert.equal((await logRows()).filter((entry) => entry.kind === "error").length, 1, "A completed run must not add error rows.");
			assert.equal(host.messages.length, 1, "Neither a cancelled nor a completed run may notify main.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("selective interruption applies only to listed recipients and rejects outsiders", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", { teamName: "selective-interrupt", commonPrompt: "Wait.", startIdle: true, teammates: [
				{ name: "first", systemPrompt: "Wait.", model: "fake/fake-model" },
				{ name: "second", systemPrompt: "Wait.", model: "fake/fake-model" },
			] });
			await host.execute("team_send_message", { targets: ["first", "second"], interrupt: ["second"], message: "Prioritize this." });
			await waitFor(() => lines(fake.eventsPath).filter((entry) => entry.type === "delivery" && ((entry.body as JsonRecord).args as JsonRecord).message === "Prioritize this.").length === 2);
			const interrupts = Object.fromEntries(lines(fake.eventsPath).filter((entry) => entry.type === "delivery" && ((entry.body as JsonRecord).args as JsonRecord).message === "Prioritize this.").map((entry) => {
				const args = (entry.body as JsonRecord).args as JsonRecord;
				return [args.to, args.interrupt];
			}));
			assert.deepEqual(interrupts, { first: false, second: true }, "Selective interruption must not abort the unselected recipient.");
			await assert.rejects(() => host.execute("team_send_message", { targets: ["first"], interrupt: ["second"], message: "Invalid." }), /interrupt.*to|recipient/i, "Interrupt targets outside to must be rejected before publication.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("add starts only new teammates and can leave a later addition idle", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", { teamName: "add-default", commonPrompt: "Work.", teammates: [{ name: "existing", systemPrompt: "Work.", model: "fake/fake-model" }] });
			const before = lines(fake.eventsPath).filter((entry) => entry.type === "delivery").length;
			await host.execute("team_add_teammates", { team: "add-default", teammates: [{ name: "new", systemPrompt: "Work.", model: "fake/fake-model" }] });
			const newDeliveries = lines(fake.eventsPath).filter((entry) => entry.type === "delivery").slice(before);
			assert.deepEqual(newDeliveries.map((entry) => ((entry.body as JsonRecord).args as JsonRecord).to), ["new"], "Add must start only the new teammate without a send call.");
			await host.execute("team_add_teammates", { startIdle: true, teammates: [{ name: "idle", systemPrompt: "Wait.", model: "fake/fake-model" }] });
			const idleDelivery = lines(fake.eventsPath).filter((entry) => entry.type === "delivery").at(-1)!;
			assert.equal(((idleDelivery.body as JsonRecord).args as JsonRecord).triggerTurn, false, "An idle addition stages its briefing without starting work.");
			assert.equal(lines(fake.eventsPath).filter((entry) => entry.type === "parent" && ((entry.args as JsonRecord)?.event as JsonRecord)?.type === "agent_start").length, 2, "The idle addition must not start another model run.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("resume starts stopped teammates by default without restarting already-live members", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", { teamName: "resume-default", commonPrompt: "Continue work.", teammates: [
				{ name: "first", systemPrompt: "Work.", model: "fake/fake-model" },
				{ name: "second", systemPrompt: "Work.", model: "fake/fake-model" },
			] });
			await host.execute("team_shutdown", { team: "resume-default" });
			const before = lines(fake.eventsPath).filter((entry) => entry.type === "delivery").length;
			await host.execute("team_resume", { team: "resume-default", teammates: ["first"] });
			const firstResume = lines(fake.eventsPath).filter((entry) => entry.type === "delivery").slice(before);
			assert.deepEqual(firstResume.map((entry) => ((entry.body as JsonRecord).args as JsonRecord).to), ["first"], "Selected resume must start the selected teammate without a send call.");
			await host.execute("team_resume", { team: "resume-default" });
			const later = lines(fake.eventsPath).filter((entry) => entry.type === "delivery").slice(before + 1);
			assert.deepEqual(later.map((entry) => ((entry.body as JsonRecord).args as JsonRecord).to), ["second"], "Resuming the remaining team must not start another turn for the already-live member.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("resume can record a resumption prompt while keeping the selected teammate idle", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", { teamName: "resume-instructions", commonPrompt: "Original common prompt.", teammates: [{ name: "probe", systemPrompt: "Original individual prompt.", model: "fake/fake-model" }] });
			await host.execute("team_shutdown", { team: "resume-instructions" });
			const before = lines(fake.eventsPath).filter((entry) => entry.type === "parent" && (entry.args as JsonRecord)?.event && ((entry.args as JsonRecord).event as JsonRecord).type === "agent_start").length;
			await host.execute("team_resume", { team: "resume-instructions", startIdle: true, resumptionPrompt: "New instructions for the next turn." });
			const deliveries = lines(fake.eventsPath).filter((entry) => entry.type === "delivery");
			const resumption = deliveries.map((entry) => (entry.body as JsonRecord).args as JsonRecord).find((args) => String(args.message).endsWith("New instructions for the next turn."));
			assert.ok(resumption, "Resume must record the supplied instructions even when startIdle is true.");
			assert.equal(resumption.triggerTurn, false, "The recorded resumption prompt must not request a turn.");
			const after = lines(fake.eventsPath).filter((entry) => entry.type === "parent" && (entry.args as JsonRecord)?.event && ((entry.args as JsonRecord).event as JsonRecord).type === "agent_start").length;
			assert.equal(after, before, "Idle resumption must not start a model turn.");
			const starts = lines(fake.eventsPath).filter((entry) => entry.type === "pi_start");
			const argumentsList = starts.at(-1)?.args as string[];
			assert.equal(argumentsList.includes("--system-prompt"), false, "Resume must not install a team-specific system override.");
			const initialBriefing = String(((deliveries[0].body as JsonRecord).args as JsonRecord).message);
			assert.ok(initialBriefing.includes("Original common prompt.") && initialBriefing.includes("Original individual prompt."), "The original definitions belong in the initial custom briefing.");
			assert.ok(!String(resumption.message).includes("Original individual prompt."), "A restored session must not repeat the saved assignment in its resume preamble.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("startIdle leaves a ready team idle until an explicit message", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", { teamName: "idle-team", commonPrompt: "Wait.", startIdle: true, teammates: [{ name: "probe", systemPrompt: "Wait.", model: "fake/fake-model" }] });
			const staged = lines(fake.eventsPath).find((entry) => entry.type === "delivery")!;
			assert.equal(((staged.body as JsonRecord).args as JsonRecord).triggerTurn, false, "startIdle stages the tagged briefing without starting work.");
			assert.equal(lines(fake.eventsPath).filter((entry) => entry.type === "parent" && ((entry.args as JsonRecord)?.event as JsonRecord)?.type === "agent_start").length, 0, "Staging must not start a model run.");
			await host.execute("team_send_message", { targets: ["probe"], message: "Start now." });
			await waitFor(() => lines(fake.eventsPath).some((entry) => entry.type === "parent" && ((entry.args as JsonRecord)?.event as JsonRecord)?.type === "agent_start"));
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("starts every teammate only after the complete team is ready", async () => {
		const fake = installFakeCommands();
		let lastTeammateArrived = false;
		let releaseRegistration: () => void = () => undefined;
		const registrationHeld = new Promise<void>((resolve) => { releaseRegistration = resolve; });
		const gate = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request: Request): Promise<Response> {
			if (new URL(request.url).searchParams.get("name") !== "second") return new Response("ready");
			lastTeammateArrived = true;
			await registrationHeld;
			return new Response("ready");
		} });
		process.env.PI_SIMPLE_TEAM_TEST_REGISTRATION_GATE = `http://127.0.0.1:${gate.port}`;
		const host = new ExtensionHost();
		const spawning = host.execute("team_spawn", {
			teamName: "kickoff-team", commonPrompt: "Work together.",
			teammates: [
				{ name: "first", systemPrompt: "Start your task.", model: "fake/fake-model" },
				{ name: "second", systemPrompt: "Start your task.", model: "fake/fake-model" },
			],
		});
		try {
			await waitFor(() => lastTeammateArrived);
			assert.equal(lines(fake.eventsPath).filter((entry) => entry.type === "delivery").length, 0, "No teammate may receive kickoff while another teammate is not registered.");
			releaseRegistration();
			await spawning;
			await waitFor(() => lines(fake.eventsPath).filter((entry) => entry.type === "delivery").length === 2);
			const recipients = lines(fake.eventsPath).filter((entry) => entry.type === "delivery").map((entry) => ((entry.body as JsonRecord).args as JsonRecord).to);
			assert.deepEqual(recipients.sort(), ["first", "second"], "One spawn must start every teammate without another send call.");
		} finally {
			releaseRegistration();
			await spawning.catch(() => undefined);
			await host.shutdown();
			delete process.env.PI_SIMPLE_TEAM_TEST_REGISTRATION_GATE;
			gate.stop(true);
			fake.restore();
		}
	});

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

	test("RPC teammates start the parent Pi package's CLI, not the host script, PATH, or the parent's removed runtime", async () => {
		const fake = installFakeCommands();
		const host = loadWithProcess(removedRuntime, process.argv[1]!, () => new ExtensionHost());
		try {
			await host.execute("team_spawn", {
				teamName: "rpc-parent-pi-team",
				startIdle: true, commonPrompt: "test",
				teammates: [{ name: "scout", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			const piStart = lines(fake.eventsPath).find((entry) => entry.type === "pi_start");
			assert.equal(piStart?.executable, fake.parentPiExecutable, "Expected the RPC teammate to start the parent Pi package's CLI.");
			assert.equal(lines(fake.eventsPath).some((entry) => entry.type === "path_pi_start"), false, "Expected the RPC teammate to ignore the Pi executable from PATH.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("a Bun standalone Pi starts RPC teammates with its own executable, not its embedded entry", async () => {
		const fake = installFakeCommands();
		const host = loadAsBunStandalonePi(fake.parentPiExecutable, () => new ExtensionHost());
		try {
			await host.execute("team_spawn", {
				teamName: "standalone-parent-pi-team",
				startIdle: true, commonPrompt: "test",
				teammates: [{ name: "scout", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			const piStart = lines(fake.eventsPath).find((entry) => entry.type === "pi_start");
			assert.equal(piStart?.executable, fake.parentPiExecutable, "Expected the RPC teammate to use the standalone Pi executable.");
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
				teamName: "rpc-registration-team",
				startIdle: true, commonPrompt: "test",
				teammates: [{ name: "scout", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			await waitFor(() => lines(fake.eventsPath).some((entry) => entry.type === "ready"));
			const piStart = lines(fake.eventsPath).find((entry) => entry.type === "pi_start");
			assert.deepEqual(
				(spawnResult.details?.teammates as JsonRecord[])?.map(({ name, teammateId }) => ({ name, teammateId })),
				[{ name: "scout", teammateId: piStart?.sessionId }],
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
				teamName: "rpc-context-team",
				startIdle: true, commonPrompt: "test",
				teammates: [{ name: "scout", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			const result = await host.execute(
				"get_context_window_usage",
				{ targets: ["scout"] },
				{ getContextUsage: () => ({ tokens: 43_210, contextWindow: 200_000, percent: 21.605 }) },
			);
			assert.match(
				result.content[0]?.text,
				/Teammate scout \(Pi session ID: scout-\d+\) on team rpc-context-team \(team ID: fake-main-session-id-rpc-context-team\) has used 87k tokens out of 272k available \(32%\)\.\nYou have used 43k tokens out of 200k available \(22%\)\./,
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

	test("main keeps each teammate's latest reported runtime facts for every view", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", {
				teamName: "rpc-context-stream",
				startIdle: true, commonPrompt: "test",
				teammates: [{ name: "scout", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			await host.execute("team_send_message", { targets: ["scout"], message: "report-runtime-facts" });
			await waitFor(() => lines(fake.eventsPath).some((entry) => entry.type === "parent" && entry.tool === "event"));
			await new Promise((resolve) => setTimeout(resolve, 25));
			const listed = await host.execute("team_list", {});
			const team = (listed.details?.teams as JsonRecord[]).find((candidate) => candidate.teamName === "rpc-context-stream")!;
			const listedTeammate = (team.teammates as JsonRecord[])[0];
			assert.deepEqual(
				{ thinking: listedTeammate?.thinking, contextPercent: listedTeammate?.contextPercent },
				{ thinking: "off", contextPercent: 57.4 },
				"The teammate record must show the thinking level the teammate runs at, not the requested one.",
			);
			const status = await host.execute("team_status", { team: "rpc-context-stream" });
			const statusTeammate = (status.details?.teammates as JsonRecord).scout as JsonRecord;
			assert.deepEqual(
				{ thinking: statusTeammate.thinking, contextPercent: statusTeammate.contextPercent },
				{ thinking: "off", contextPercent: 57.4 },
				"Team Status renders from the same teammate facts.",
			);
			assert.doesNotMatch(status.content[0]!.text, /contextPercent/, "The view-only facts must stay out of the model-facing status.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("team_send_message reaches an RPC teammate through its delivery runtime and its events flow back", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", {
				teamName: "rpc-delivery-team",
				startIdle: true, commonPrompt: "test",
				teammates: [{ name: "scout", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			await host.execute("team_send_message", { targets: ["scout"], message: "check this", interrupt: false });
			await waitFor(() => lines(fake.eventsPath).some((entry) => entry.type === "delivery" && ((entry.body as JsonRecord).args as JsonRecord).message === "check this"));
			const delivery = lines(fake.eventsPath).find((entry) => entry.type === "delivery" && ((entry.body as JsonRecord).args as JsonRecord).message === "check this")!;
			const deliveryArgs = (delivery.body as JsonRecord).args as JsonRecord;
			assert.equal(deliveryArgs.message, "check this", `Expected the HTTP delivery to carry the message. Got: ${JSON.stringify(delivery)}`);
			await waitFor(() => lines(fake.eventsPath).filter((entry) => entry.type === "parent" && entry.tool === "event").length === 4);
			await new Promise((resolve) => setTimeout(resolve, 25));

			const log = await host.execute("team_log", { targets: ["rpc-delivery-team" ]});
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
				teamName: "rpc-interrupt-team",
				startIdle: true, commonPrompt: "test",
				teammates: [{ name: "scout", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			await host.execute("team_send_message", { targets: ["scout"], message: "drop everything", interrupt: true });
			await waitFor(() => lines(fake.eventsPath).some((entry) => entry.type === "delivery" && ((entry.body as JsonRecord).args as JsonRecord).message === "drop everything"));
			const delivery = lines(fake.eventsPath).find((entry) => entry.type === "delivery" && ((entry.body as JsonRecord).args as JsonRecord).message === "drop everything")!;
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

const exitNoticeGraceMilliseconds = 2_000;

/** A gate the fake child waits on before it exits, so a test can fix when that exit happens. */
function startExitGate(): { url: string; release: () => void; close: () => void } {
	let release: () => void = () => undefined;
	const opened = new Promise<void>((resolve) => { release = resolve; });
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(): Promise<Response> { await opened; return new Response("exit"); } });
	return { url: `http://127.0.0.1:${server.port}`, release, close: () => server.stop(true) };
}


const exitNotices = (host: ExtensionHost): string[] => host.messages.map((message) => String(message.content)).filter((content) => content.includes(") exited.\nCause:"));
const reportedQuit = (eventsPath: string): boolean => lines(eventsPath).some((entry) => entry.type === "parent" && entry.tool === "event" && ((entry.args as JsonRecord).event as JsonRecord).type === "session_shutdown");
const receivedMessage = (eventsPath: string, message: string): boolean => lines(eventsPath).some((entry) => entry.type === "delivery" && ((entry.body as JsonRecord).args as JsonRecord).message === message);
const receivedSigterm = (eventsPath: string, member: string): boolean => lines(eventsPath).some((entry) => entry.type === "sigterm" && entry.member === member);

describe("unexpected background-teammate exits notify main", () => {
	test("a registered teammate's own exit notifies once after the grace, and a resume that dies before registering does not", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		const restoreSwitches = useEnvironment({});
		try {
			await host.execute("team_spawn", { teamName: "exits", commonPrompt: "Wait.", startIdle: true, teammates: [{ name: "x", systemPrompt: "Wait.", model: "fake/fake-model" }, { name: "y", systemPrompt: "Wait.", model: "fake/fake-model" }] });
			await host.execute("team_send_message", { targets: ["y"], message: "exit-now" });
			await Bun.sleep(exitNoticeGraceMilliseconds + 500);
			assert.deepEqual(exitNotices(host), [`Teammate "y" on team "exits" (team ID: fake-main-session-id-exits) exited.\nCause: exited (code=7, signal=null)\nCode 143 or 129 means its Pi shut down after SIGTERM or SIGHUP. Check team_log for its last stderr lines. Use team_resume to restart it.`], "A registered teammate that exits on its own must wake main once.");
			process.env.PI_SIMPLE_TEAM_TEST_DIE_BEFORE_REGISTER_MEMBER = "y";
			await assert.rejects(host.execute("team_resume", { team: "exits", teammates: ["y"], startIdle: true }), /exited \(code=3/, "The fixture's resumed teammate must die before it registers.");
			await Bun.sleep(exitNoticeGraceMilliseconds + 500);
			assert.equal(exitNotices(host).length, 1, "A resumed teammate that dies before registering is a tool error, not an exit notice, even with its session ID known.");
		} finally {
			delete process.env.PI_SIMPLE_TEAM_TEST_DIE_BEFORE_REGISTER_MEMBER;
			restoreSwitches();
			await host.shutdown();
			fake.restore();
		}
	}, 20_000);

	test("an add rollback that stops an already registered teammate does not notify", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		const restoreSwitches = useEnvironment({ PI_SIMPLE_TEAM_TEST_BAD_REGISTER_MEMBER: "e" });
		try {
			await host.execute("team_spawn", { teamName: "add-rollback", commonPrompt: "Wait.", startIdle: true, teammates: [{ name: "x", systemPrompt: "Wait.", model: "fake/fake-model" }] });
			await assert.rejects(host.execute("team_add_teammates", { team: "add-rollback", startIdle: true, teammates: [{ name: "d", systemPrompt: "Wait.", model: "fake/fake-model" }, { name: "e", systemPrompt: "Wait.", model: "fake/fake-model" }] }));
			assert.ok(receivedSigterm(fake.eventsPath, "d"), "The rollback must stop the registered teammate d.");
			await Bun.sleep(exitNoticeGraceMilliseconds + 500);
			assert.deepEqual(exitNotices(host), [], "A stop the runtime asked for is not unexpected.");
		} finally {
			restoreSwitches();
			await host.shutdown();
			fake.restore();
		}
	}, 20_000);

	test("team_shutdown does not notify for a teammate that exits by itself while a slower sibling stops", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		const gate = startExitGate();
		const restoreSwitches = useEnvironment({ PI_SIMPLE_TEAM_TEST_SLOW_STOP_MEMBER: "b", PI_SIMPLE_TEAM_TEST_EXIT_GATE: gate.url });
		try {
			await host.execute("team_spawn", { teamName: "slow-stop", commonPrompt: "Wait.", startIdle: true, teammates: [{ name: "b", systemPrompt: "Wait.", model: "fake/fake-model", canManageOwnTeams: true }, { name: "a", systemPrompt: "Wait.", model: "fake/fake-model" }] });
			await host.execute("team_send_message", { targets: ["a"], message: "exit-when-gate-opens" });
			await waitFor(() => receivedMessage(fake.eventsPath, "exit-when-gate-opens"));
			const stopping = host.execute("team_shutdown", { team: "slow-stop" });
			await waitFor(() => receivedSigterm(fake.eventsPath, "b"));
			gate.release();
			await Bun.sleep(exitNoticeGraceMilliseconds + 500);
			assert.ok(!receivedSigterm(fake.eventsPath, "a"), "The fixture's a must exit before main's stop reaches it.");
			assert.deepEqual(exitNotices(host), [], "An exit while its team is stopping is not unexpected.");
			await stopping;
		} finally {
			restoreSwitches();
			gate.close();
			await host.shutdown();
			fake.restore();
		}
	}, 20_000);

	test("a spawn rollback does not notify for a registered teammate that exits before the rollback reaches it", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		const gate = startExitGate();
		const restoreSwitches = useEnvironment({ PI_SIMPLE_TEAM_TEST_EXIT_WHEN_GATE_OPENS_MEMBER: "a", PI_SIMPLE_TEAM_TEST_SLOW_STOP_MEMBER: "b", PI_SIMPLE_TEAM_TEST_BAD_REGISTER_MEMBER: "c", PI_SIMPLE_TEAM_TEST_EXIT_GATE: gate.url });
		try {
			const spawning = host.execute("team_spawn", { teamName: "spawn-rollback", commonPrompt: "Wait.", startIdle: true, teammates: [{ name: "b", systemPrompt: "Wait.", model: "fake/fake-model", canManageOwnTeams: true }, { name: "a", systemPrompt: "Wait.", model: "fake/fake-model" }, { name: "c", systemPrompt: "Wait.", model: "fake/fake-model" }] }).then(() => undefined, (error: unknown) => error);
			await waitFor(() => receivedSigterm(fake.eventsPath, "b"), 5_000);
			assert.ok(!receivedSigterm(fake.eventsPath, "a"), "The fixture's a must exit before the rollback reaches it.");
			gate.release();
			await Bun.sleep(exitNoticeGraceMilliseconds + 500);
			assert.deepEqual(exitNotices(host), [], "An exit during a spawn rollback is not unexpected.");
			assert.ok(await spawning instanceof Error, "The fixture's spawn must fail on c's registration.");
		} finally {
			restoreSwitches();
			gate.close();
			await host.shutdown();
			fake.restore();
		}
	}, 20_000);

	test("main's own shutdown does not notify for a later team's teammate that exits while an earlier team stops slowly", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		const gate = startExitGate();
		const restoreSwitches = useEnvironment({ PI_SIMPLE_TEAM_TEST_SLOW_STOP_MEMBER: "b", PI_SIMPLE_TEAM_TEST_EXIT_GATE: gate.url });
		try {
			await host.execute("team_spawn", { teamName: "first", commonPrompt: "Wait.", startIdle: true, teammates: [{ name: "b", systemPrompt: "Wait.", model: "fake/fake-model", canManageOwnTeams: true }] });
			await host.execute("team_spawn", { teamName: "second", commonPrompt: "Wait.", startIdle: true, teammates: [{ name: "a", systemPrompt: "Wait.", model: "fake/fake-model" }] });
			await host.execute("team_send_message", { targets: ["a"], message: "exit-when-gate-opens" });
			await waitFor(() => receivedMessage(fake.eventsPath, "exit-when-gate-opens"));
			const shuttingDown = host.shutdown();
			await waitFor(() => receivedSigterm(fake.eventsPath, "b"));
			gate.release();
			await Bun.sleep(exitNoticeGraceMilliseconds + 500);
			assert.deepEqual(exitNotices(host), [], "An exit while main shuts down is not unexpected.");
			await shuttingDown;
		} finally {
			restoreSwitches();
			gate.close();
			fake.restore();
		}
	}, 20_000);

	test("a restart ends the previous process first, so the resumed teammate stays live, reachable and stoppable", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		const gate = startExitGate();
		const restoreSwitches = useEnvironment({ PI_SIMPLE_TEAM_TEST_EXIT_GATE: gate.url });
		const processesOf = (member: string): number[] => lines(fake.eventsPath).filter((entry) => entry.type === "pi_start" && entry.member === member).map((entry) => Number(entry.pid));
		try {
			await host.execute("team_spawn", { teamName: "quit-resume", commonPrompt: "Wait.", startIdle: true, teammates: [{ name: "x", systemPrompt: "Wait.", model: "fake/fake-model" }, { name: "y", systemPrompt: "Wait.", model: "fake/fake-model" }] });
			// y reports its quit and then lingers: it exits only when the gate opens.
			await host.execute("team_send_message", { targets: ["y"], message: "quit-slowly" });
			await waitFor(() => reportedQuit(fake.eventsPath));
			await Bun.sleep(100);
			await host.execute("team_resume", { team: "quit-resume", teammates: ["y"], startIdle: true });
			const [previous, resumed] = processesOf("y");
			assert.equal(processIsRunning(previous!), false, "One session must not have two runtimes: the previous process must have ended before the resume returned.");
			gate.release();
			await Bun.sleep(exitNoticeGraceMilliseconds + 500);
			assert.deepEqual(exitNotices(host), [], "The previous process was stopped by main, so its exit is not unexpected.");
			const status = ((await host.execute("team_status", { team: "quit-resume" })).details?.status as Record<string, JsonRecord>).y;
			const listed = (((await host.execute("team_list", {})).details?.teams as JsonRecord[]).find((team) => team.teamName === "quit-resume")?.teammates as JsonRecord[]).find((member) => member.name === "y");
			assert.deepEqual({ word: status.word, phrase: status.phrase, live: listed?.live }, { word: "idle", phrase: "Resumed", live: true }, "The previous process's end must not mark the resumed teammate as stopped.");
			await host.execute("team_send_message", { targets: ["y"], message: "report-runtime-facts" });
			await waitFor(() => lines(fake.eventsPath).some((entry) => entry.type === "delivery" && entry.pid === resumed && ((entry.body as JsonRecord).args as JsonRecord).message === "report-runtime-facts"));
			assert.deepEqual(host.messages.filter((message) => String(message.content).includes("delivery failed")), [], "Main must deliver to the resumed teammate.");
			await host.execute("team_shutdown", { team: "quit-resume" });
			assert.equal(processIsRunning(resumed!), false, "team_shutdown must stop the resumed process.");
		} finally {
			restoreSwitches();
			gate.close();
			await host.shutdown();
			fake.restore();
		}
	}, 20_000);

	test("a replaced process that still talks to main is refused and changes nothing for its successor", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		const gate = startExitGate();
		const restoreSwitches = useEnvironment({ PI_SIMPLE_TEAM_TEST_EXIT_GATE: gate.url });
		const shutdownReported = (): boolean => lines(fake.eventsPath).some((entry) => entry.type === "parent" && entry.tool === "event" && ((entry.args as JsonRecord).event as JsonRecord).reason === "new");
		try {
			// A restart closes the previous pane, but a pane process can outlive that close, as a hung Pi would. Main has no process handle to kill it.
			await host.execute("team_spawn", { teamName: "stale", commonPrompt: "Wait.", startIdle: true, teammates: [{ name: "v", systemPrompt: "Wait.", model: "fake/fake-model", showOnHerdrPane: true }] });
			await host.execute("team_send_message", { targets: ["v"], message: "linger-as-stale" });
			await waitFor(shutdownReported);
			await Bun.sleep(100);
			await host.execute("team_resume", { team: "stale", teammates: ["v"], startIdle: true });
			const [previousPane, successorPane] = lines(fake.logPath).filter((entry) => entry.type === "start").map((entry) => entry.paneId);
			assert.deepEqual(lines(fake.logPath).filter((entry) => entry.type === "close").map((entry) => entry.paneId), [previousPane], "The restart must close the previous pane, and only that one.");
			assert.notEqual(successorPane, previousPane, "The successor runs in a new pane.");
			const successor = Number(lines(fake.eventsPath).findLast((entry) => entry.type === "pi_start")?.pid);
			gate.release();
			await waitFor(() => lines(fake.eventsPath).some((entry) => entry.type === "stale_result"));
			await Bun.sleep(exitNoticeGraceMilliseconds + 500);
			assert.deepEqual(endNotices(host), [], "The replaced process's end, seen through its lifeline, must change nothing for its successor.");
			const outcomes = lines(fake.eventsPath).find((entry) => entry.type === "stale_result")?.outcomes as Record<string, string>;
			assert.equal(outcomes.lifeline, "refused", "Main must refuse a lifeline from the replaced process.");
			assert.match(outcomes.quit, /^rejected: .*restarted/, `Main must refuse a late event from the replaced process. Got: ${outcomes.quit}`);
			assert.match(outcomes.register, /^rejected: .*restarted/, `Main must refuse a late registration from the replaced process. Got: ${outcomes.register}`);
			const status = ((await host.execute("team_status", { team: "stale" })).details?.status as Record<string, JsonRecord>).v;
			const listed = (((await host.execute("team_list", {})).details?.teams as JsonRecord[]).find((team) => team.teamName === "stale")?.teammates as JsonRecord[])[0];
			assert.deepEqual({ word: status.word, phrase: status.phrase, live: listed.live }, { word: "idle", phrase: "Resumed", live: true }, "A late quit from the replaced process must not stop its successor.");
			await host.execute("team_send_message", { targets: ["v"], message: "report-runtime-facts" });
			await waitFor(() => lines(fake.eventsPath).some((entry) => entry.type === "delivery" && entry.pid === successor && ((entry.body as JsonRecord).args as JsonRecord).message === "report-runtime-facts"));
		} finally {
			restoreSwitches();
			gate.close();
			await host.shutdown();
			fake.restore();
		}
	}, 20_000);
});

const endNotices = (host: ExtensionHost): string[] => host.messages.map((message) => String(message.content)).filter((content) => /\) (exited|shut down[^.\n]*)\.\nCause:/.test(content));
const readyRecord = (eventsPath: string, member: string): JsonRecord | undefined => lines(eventsPath).findLast((entry) => entry.type === "ready" && entry.member === member);

describe("Herdr pane teammate ends notify main like background teammate ends", () => {
	const herdrTeammate = (name: string): JsonRecord => ({ name, systemPrompt: "Wait.", model: "fake/fake-model", showOnHerdrPane: true });
	const memberStatus = async (host: ExtensionHost, team: string, member: string): Promise<JsonRecord> => ((await host.execute("team_status", { team })).details?.status as Record<string, JsonRecord>)[member];

	test("a killed pane teammate gives one failure notice, and only pane teammates are offered a lifeline", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", { teamName: "pane-kill", commonPrompt: "Wait.", startIdle: true, teammates: [herdrTeammate("visible"), { name: "background", systemPrompt: "Wait.", model: "fake/fake-model" }] });
			assert.deepEqual([readyRecord(fake.eventsPath, "visible")?.lifelineOffered, readyRecord(fake.eventsPath, "background")?.lifelineOffered], [true, false], "Main has a process handle for a background teammate, so only the pane teammate needs a lifeline.");
			process.kill(Number(readyRecord(fake.eventsPath, "visible")?.pid), "SIGKILL");
			await Bun.sleep(exitNoticeGraceMilliseconds + 500);
			assert.deepEqual(endNotices(host), [`Teammate "visible" on team "pane-kill" (team ID: fake-main-session-id-pane-kill) exited.\nCause: its Pi process ended without shutting down (a crash, a kill, or its pane closed while it worked)\nCheck its pane if it is still open. Use team_resume to restart it.`], "A pane teammate whose process dies must wake main once, like a background teammate's unexpected exit.");
			const ended = await memberStatus(host, "pane-kill", "visible");
			assert.deepEqual({ word: ended.word, phrase: ended.phrase }, { word: "stopped", phrase: "Ended without shutting down" }, "A dead pane teammate must not stay idle and live.");
			const resumed = await host.execute("team_resume", { team: "pane-kill", teammates: ["visible"], startIdle: true });
			assert.equal((resumed.details?.teammates as JsonRecord[]).find((member) => member.name === "visible")?.live, true, "team_resume must be able to restart a pane teammate that died.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	}, 20_000);

	test("a pane teammate that shuts down after a signal gives one neutral notice, and one that quits itself gives none", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", { teamName: "pane-quit", commonPrompt: "Wait.", startIdle: true, teammates: [herdrTeammate("closed"), herdrTeammate("quitter")] });
			await host.execute("team_send_message", { targets: ["closed"], message: "quit-on-sighup" });
			await host.execute("team_send_message", { targets: ["quitter"], message: "quit-by-itself" });
			await Bun.sleep(exitNoticeGraceMilliseconds + 500);
			assert.deepEqual(endNotices(host), [`Teammate "closed" on team "pane-quit" (team ID: fake-main-session-id-pane-quit) shut down after SIGHUP.\nCause: its Pi received SIGHUP and shut down in order. Its pane may have been closed on purpose.\nUse team_resume to restart it if you still need it.`], "A signal shutdown must read as a neutral end, once. A self-quit must send nothing.");
			const closed = await memberStatus(host, "pane-quit", "closed");
			assert.deepEqual({ word: closed.word, phrase: closed.phrase }, { word: "stopped", phrase: "Shut down after SIGHUP" }, "The status must name the signal without calling it an error.");
			assert.equal((await memberStatus(host, "pane-quit", "quitter")).phrase, "Session shut down", "A self-quit keeps its existing status.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	}, 20_000);

	test("a pane that main closes sends nothing, in a rollback and in team_shutdown", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		// When main closes its pane, d shuts down in order and reports the signal, as an idle Pi does. f just dies, as a working Pi usually does.
		const restoreSwitches = useEnvironment({ PI_SIMPLE_TEAM_TEST_BAD_REGISTER_MEMBER: "e", PI_SIMPLE_TEAM_TEST_QUIT_ON_SIGTERM_MEMBER: "d" });
		try {
			await host.execute("team_spawn", { teamName: "pane-close", commonPrompt: "Wait.", startIdle: true, teammates: [herdrTeammate("x")] });
			await assert.rejects(host.execute("team_add_teammates", { team: "pane-close", startIdle: true, teammates: [herdrTeammate("d"), herdrTeammate("f"), herdrTeammate("e")] }));
			assert.deepEqual([readyRecord(fake.eventsPath, "d")?.lifelineOffered, readyRecord(fake.eventsPath, "f")?.lifelineOffered], [true, true], "The fixture's d and f must have registered before the rollback closed their panes.");
			await waitFor(() => lines(fake.eventsPath).some((entry) => entry.type === "parent" && entry.tool === "event" && ((entry.args as JsonRecord).event as JsonRecord).signal === "SIGTERM"));
			await Bun.sleep(exitNoticeGraceMilliseconds + 500);
			assert.deepEqual(endNotices(host), [], "A pane the runtime closed in a rollback is not an unexpected end.");
			await host.execute("team_shutdown", { team: "pane-close" });
			await Bun.sleep(exitNoticeGraceMilliseconds + 500);
			assert.deepEqual(endNotices(host), [], "A pane closed by team_shutdown is not an unexpected end.");
		} finally {
			restoreSwitches();
			await host.shutdown();
			fake.restore();
		}
	}, 20_000);

	test("a pane teammate's process holds one lifeline across reloads, and reports the signal that shuts it down", async () => {
		const hellos: string[] = [];
		const lifelineServer = net.createServer((socket) => socket.on("data", (data) => hellos.push(String(data))));
		await new Promise<void>((resolve) => lifelineServer.listen(0, "127.0.0.1", resolve));
		const port = (lifelineServer.address() as net.AddressInfo).port;
		const listenersBefore = { SIGHUP: process.listeners("SIGHUP"), SIGTERM: process.listeners("SIGTERM") };
		const lifelineKey = Symbol.for("pi-simple-team.lifeline");
		const processState = globalThis as { [key: symbol]: { socket: net.Socket } | undefined };
		const firstLoad = await startChildRuntimeForTest(0, port);
		const reload = await startChildRuntimeForTest(0, port);
		try {
			await waitFor(() => hellos.length > 0);
			await Bun.sleep(200);
			assert.deepEqual(hellos.map((hello) => JSON.parse(hello) as JsonRecord), [{ token: "child-token", team: "child-team", from: "reviewer", process: "test-process" }], "One process holds one lifeline, however often Pi loads the extension.");
			process.emit("SIGHUP");
			await reload.close();
			assert.deepEqual(reload.requests.findLast((request) => request.tool === "event")?.args.event, { type: "session_shutdown", reason: "quit", signal: "SIGHUP" }, "The shutdown callback must carry the signal that caused it.");
		} finally {
			for (const signal of ["SIGHUP", "SIGTERM"] as const) for (const listener of process.listeners(signal)) if (!listenersBefore[signal].includes(listener)) process.off(signal, listener);
			processState[lifelineKey]?.socket.destroy();
			delete processState[lifelineKey];
			await firstLoad.close();
			await reload.close();
			await new Promise<void>((resolve) => lifelineServer.close(() => resolve()));
		}
	});

	test("a pane teammate whose quit callback is still in flight when it dies gives one notice", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", { teamName: "pane-race", commonPrompt: "Wait.", startIdle: true, teammates: [herdrTeammate("visible")] });
			await host.execute("team_send_message", { targets: ["visible"], message: "die-mid-quit" });
			await waitFor(() => lines(fake.eventsPath).some((entry) => entry.type === "late_quit_sent"));
			await Bun.sleep(exitNoticeGraceMilliseconds + 500);
			assert.equal(endNotices(host).length, 1, `Main records a process's end once, whichever signal arrives first. Got: ${JSON.stringify(endNotices(host))}`);
			assert.equal((await memberStatus(host, "pane-race", "visible")).phrase, "Ended without shutting down", "A callback from a process whose end is recorded changes nothing.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	}, 20_000);

	test("a session replacement in the pane sends nothing, and a later death still notifies", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", { teamName: "pane-new", commonPrompt: "Wait.", startIdle: true, teammates: [herdrTeammate("visible")] });
			await host.execute("team_send_message", { targets: ["visible"], message: "replace-session" });
			await waitFor(() => lines(fake.eventsPath).filter((entry) => entry.type === "ready").length === 2);
			await Bun.sleep(exitNoticeGraceMilliseconds + 500);
			assert.deepEqual(endNotices(host), [], "A teammate that starts a new session in its pane is still running.");
			assert.equal((await memberStatus(host, "pane-new", "visible")).word, "idle", "The re-registered teammate is live again.");
			process.kill(Number(readyRecord(fake.eventsPath, "visible")?.pid), "SIGKILL");
			await Bun.sleep(exitNoticeGraceMilliseconds + 500);
			assert.equal(endNotices(host).length, 1, "The lifeline must outlive a session replacement.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	}, 20_000);
});

describe("visible Herdr teammates", () => {
	test("the live team dashboard reports mixed transports from actual members", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		let output = "";
		const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text };
		try {
			await host.execute("team_spawn", { teamName: "mixed-dashboard", commonPrompt: "Wait.", startIdle: true, teammates: [
				{ name: "visible", systemPrompt: "Wait.", model: "fake/fake-model", showOnHerdrPane: true },
				{ name: "background", systemPrompt: "Wait.", model: "fake/fake-model" },
			] });
			const command = host.commands.get("team");
			assert.ok(command, "The extension must expose /team.");
			await command.handler("", { mode: "tui", ui: { custom: async (factory: (tui: TUI, providedTheme: typeof theme, keybindings: unknown, done: () => void) => Component) => {
				const component = factory({ terminal: { rows: 40 }, requestRender: () => undefined } as unknown as TUI, theme, {}, () => undefined);
				output = component.render(200).join("\n");
				component.handleInput?.("\u001b");
			} } } as unknown as ExtensionCommandContext);
			assert.match(output, /RPC \+ Herdr/, "The dashboard must not label a mixed team as only RPC.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("a failed run of a Herdr pane teammate notifies main through the same parent path", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", { teamName: "visible-failure", commonPrompt: "Wait.", startIdle: true, teammates: [{ name: "visible", systemPrompt: "Wait.", model: "fake/fake-model", showOnHerdrPane: true }] });
			await host.execute("team_send_message", { targets: ["visible"], message: "fail-this-run" });
			await waitFor(() => host.messages.length > 0);
			assert.match(String(host.messages[0]?.content), /^Teammate "visible" on team "visible-failure" .* ended its latest run on an error\.\nCause: 400: quota fixture\n/, "A Herdr teammate's failed run must reach main like a background teammate's.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("individual panes support mixed teams and explicit team settings override them", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		const commonPrompt = "Quoted 'text', $NOT_A_VARIABLE, and `not-a-command`.\nSecond line.";
		const extensionPath = path.join(path.dirname(fake.logPath), "replay 'hook'.ts");
		fs.writeFileSync(extensionPath, "export default function () {}\n");
		try {
			await host.execute("team_spawn", { teamName: "mixed-team", commonPrompt, startIdle: true, teammates: [
				{ name: "visible", systemPrompt: "Wait.", model: "fake/fake-model", showOnHerdrPane: true, extensionPaths: [extensionPath] },
				{ name: "background", systemPrompt: "Wait.", model: "fake/fake-model" },
			] });
			assert.equal(lines(fake.logPath).filter((entry) => entry.type === "start").length, 1, "Only the individually selected teammate should open a pane.");
			const visibleArguments = lines(fake.eventsPath).find((entry) => entry.type === "pi_start")?.args as string[];
			assert.equal(visibleArguments.includes("--system-prompt"), false, "Herdr must not install a team-specific system override.");
			const visibleBriefing = lines(fake.eventsPath).find((entry) => entry.type === "delivery" && ((entry.body as JsonRecord).args as JsonRecord).to === "visible")!;
			assert.ok(String(((visibleBriefing.body as JsonRecord).args as JsonRecord).message).includes(commonPrompt), "The custom briefing must preserve shell-sensitive prompt text exactly.");
			assert.equal(visibleArguments[visibleArguments.indexOf(extensionPath) - 1], "-e", "Herdr must preserve and load the explicit extension path without shell corruption.");
			await host.execute("team_spawn", { teamName: "override-team", commonPrompt: "Wait.", startIdle: true, showOnHerdrPanes: false, teammates: [{ name: "overridden", systemPrompt: "Wait.", model: "fake/fake-model", showOnHerdrPane: true }] });
			assert.equal(lines(fake.logPath).filter((entry) => entry.type === "start").length, 1, "Explicit false must override an individual pane request.");
			await host.execute("team_add_teammates", { team: "mixed-team", startIdle: true, teammates: [{ name: "added-visible", systemPrompt: "Wait.", model: "fake/fake-model", showOnHerdrPane: true }] });
			assert.equal(lines(fake.logPath).filter((entry) => entry.type === "start").length, 2, "Added teammates must support their individual pane setting.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("reports its runtime facts with registration and after every change", async () => {
		const child = await startChildRuntimeForTest(0);
		const runningWith = (model: string, thinkingLevel: string, percent: number | null) => ({
			model: { provider: "fake", id: model },
			thinkingLevel,
			getContextUsage: () => ({ tokens: percent === null ? null : 1, contextWindow: 272_000, percent }),
		});
		try {
			const register = child.requests.find((request) => request.tool === "register");
			assert.deepEqual(
				{ model: register?.args.model, thinking: register?.args.thinking, contextPercent: register?.args.contextPercent },
				{ model: "fake/fake-model", thinking: "high", contextPercent: 31.985 },
				"Registration must carry the model, thinking level, and context usage the child starts with.",
			);
			const changes: Array<[string, ReturnType<typeof runningWith>]> = [
				["turn_end", runningWith("fake-model", "high", 40.2)],
				["session_compact", runningWith("fake-model", "high", null)],
				["model_select", runningWith("other-model", "high", 41)],
				["thinking_level_select", runningWith("other-model", "low", 41)],
				["session_tree", runningWith("other-model", "low", 12)],
			];
			for (const [eventName, context] of changes) {
				const handler = child.handlers.get(eventName);
				assert.ok(handler, `Expected the child to report its runtime facts on ${eventName}.`);
				await handler(eventName === "turn_end" ? { outcome: "completed", message: { role: "assistant", stopReason: "stop" } } : {}, context);
			}
			await waitFor(() => child.requests.filter((request) => request.tool === "event").length === changes.length);
			assert.deepEqual(
				child.requests.filter((request) => request.tool === "event").map((request) => request.args.event),
				[
					{ type: "runtime_facts", model: "fake/fake-model", thinking: "high", contextPercent: 40.2 },
					{ type: "runtime_facts", model: "fake/fake-model", thinking: "high", contextPercent: null },
					{ type: "runtime_facts", model: "fake/other-model", thinking: "high", contextPercent: 41 },
					{ type: "runtime_facts", model: "fake/other-model", thinking: "low", contextPercent: 41 },
					{ type: "runtime_facts", model: "fake/other-model", thinking: "low", contextPercent: 12 },
				],
				"A compaction makes the usage unknown until the next response, so it must clear the reported value.",
			);
		} finally {
			await child.close();
		}
	});

	test("exposes its current context usage to the parent", async () => {
		const child = await startChildRuntimeForTest(0);
		try {
			const register = child.requests.find((request) => request.tool === "register");
			assert.ok(register, "Expected the visible teammate to register its callback URL.");
			const response = await fetch(String(register.args.url), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: "child-token", tool: "get_context_window_usage", args: {} }),
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
		const interruption = Promise.withResolvers<void>();
		try {
			await child.handlers.get("agent_start")?.({}, { abort: () => interruption.resolve() });
			const register = child.requests.find((request) => request.tool === "register");
			assert.ok(register);
			const delivery = fetch(String(register.args.url), {
				method: "POST",
				headers: { "content-type": "application/json", connection: "close" },
				body: JSON.stringify({ token: "child-token", tool: "deliver", args: { interrupt: true, formattedMessage: "message", team: "child-team", from: "main", to: "reviewer", sentAt: "now", message: "message" } }),
			});
			await interruption.promise;
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
			assert.equal(Value.Check(schema, { teamName: "rpc-team", startIdle: true, commonPrompt: "test", teammates: [] }), true);
			assert.equal(Value.Check(schema, { teamName: "rpc-team", startIdle: true, commonPrompt: "test", teammates: [], showOnHerdrPanes: false }), true);
			await host.execute("team_spawn", { teamName: "rpc-team", startIdle: true, commonPrompt: "test", teammates: [] });
			assert.deepEqual(lines(fake.logPath), []);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("rejects a context fork for an ephemeral main session", async () => {
		const host = new ExtensionHost();
		try {
			await assert.rejects(
				() => host.execute(
					"team_spawn",
					{
						teamName: "ephemeral-team",
						startIdle: true, commonPrompt: "test",
						teammates: [{ name: "forker", systemPrompt: "wait", model: "fake/fake-model", forkContext: true }],
					},
					{ ...fakeMainContext, sessionManager: { getSessionFile: () => undefined } },
				),
				/forkContext requires a saved main session/,
			);
		} finally {
			await host.shutdown();
		}
	});

	test("Herdr teammates start the parent Pi package's CLI, not the host script, PATH, or the parent's removed runtime", async () => {
		const fake = installFakeCommands();
		const host = loadWithProcess(removedRuntime, process.argv[1]!, () => new ExtensionHost());
		try {
			await host.execute("team_spawn", {
				teamName: "visible-parent-pi-team",
				startIdle: true, commonPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [{ name: "scout", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			const start = lines(fake.eventsPath).find((entry) => entry.type === "pi_start");
			assert.equal(start?.executable, fake.parentPiExecutable, "Expected Herdr to start the parent Pi package's CLI.");
			assert.equal(lines(fake.eventsPath).some((entry) => entry.type === "path_pi_start"), false, "Expected the Herdr teammate to ignore the Pi executable from PATH.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("passes the main session fork only to forked visible teammates", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", {
				teamName: "forked-visible-team",
				startIdle: true, commonPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [
					{ name: "forker", systemPrompt: "wait", model: "fake/fake-model", thinking: "low", forkContext: true },
					{ name: "fresh", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" },
				],
			});
			const starts = lines(fake.eventsPath).filter((entry) => entry.type === "pi_start");
			assert.equal(starts.length, 2);
			const commandFor = (index: number): string[] => starts[index]!.args as string[];
			assert.deepEqual(commandFor(0).slice(0, 3), ["--fork", fakeMainSessionFile, "-e"]);
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
				teamName: "missing-tab-team",
				startIdle: true, commonPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [],
			}), /HERDR_TAB_ID/);
			assert.deepEqual(lines(fake.logPath), []);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("a live Herdr-pane teammate takes the same update arguments: its pane closes and a new pane resumes its session with the new settings", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", {
				teamName: "visible-update-team",
				startIdle: true, commonPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [{ name: "pane-mate", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			const sessionFile = await savedSessionOf(host, "pane-mate");
			const extensionPath = path.join(fake.directory, "pane-extension.ts");
			fs.writeFileSync(extensionPath, "export default function () {}\n");
			const result = await host.execute("team_update_teammates", { teammates: [{ teammate: "pane-mate", thinking: "high", extensionPaths: [extensionPath] }] });
			const updated = (result.details?.teammates as JsonRecord[])[0]!;
			// The fake pane Pi reports the facts it recorded at spawn; real Pi restores the recorded thinking level, which test/teammate-update.test.ts proves.
			assert.deepEqual([updated.held, updated.live, updated.showOnHerdrPane], [false, true, true]);
			assert.deepEqual(lines(fake.logPath).filter((entry) => entry.type === "close"), [{ type: "close", paneId: "fake-pane-1" }], "The restart must close the teammate's old pane.");
			const command = lines(fake.eventsPath).filter((entry) => entry.type === "pi_start").at(-1)?.args as string[];
			assert.equal(command[command.indexOf("--session") + 1], sessionFile, `The new pane must resume the same session. Got: ${JSON.stringify(command)}`);
			assert.equal(command[command.indexOf("--thinking") + 1], "high");
			assert.equal(command[command.indexOf(extensionPath) - 1], "-e");
			assert.deepEqual(thinkingChanges(sessionFile), ["high"], "The session must record the new thinking level.");
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});

	test("a stopped teammate resumes into a Herdr pane with new settings", async () => {
		const fake = installFakeCommands();
		const originHost = new ExtensionHost();
		let resumingHost: ExtensionHost | undefined;
		try {
			const teamId = "fake-main-session-id-visible-resume-update";
			await originHost.execute("team_spawn", {
				teamName: "visible-resume-update", startIdle: true, commonPrompt: "test",
				teammates: [{ name: "reviewer", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			const sessionFile = await savedSessionOf(originHost, "reviewer");
			await originHost.execute("team_shutdown", { team: teamId });
			resumingHost = new ExtensionHost();
			await resumingHost.execute("team_resume", { team: teamId, showOnHerdrPanes: true, startIdle: true, teammateUpdates: [{ teammate: "reviewer", thinking: "high" }] });
			const command = lines(fake.eventsPath).filter((entry) => entry.type === "pi_start").at(-1)?.args as string[];
			assert.equal(lines(fake.logPath).filter((entry) => entry.type === "split").length, 1, "The resume must open a Herdr pane.");
			assert.equal(command[command.indexOf("--session") + 1], sessionFile);
			assert.equal(command[command.indexOf("--thinking") + 1], "high");
			assert.deepEqual(thinkingChanges(sessionFile), ["high"]);
		} finally {
			await resumingHost?.shutdown();
			await originHost.shutdown();
			fake.restore();
		}
	});

	test("main reports a visible teammate before itself", async () => {
		const fake = installFakeCommands();
		const host = new ExtensionHost();
		try {
			await host.execute("team_spawn", {
				teamName: "visible-context-team",
				startIdle: true, commonPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [{ name: "product-head", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			const result = await host.execute(
				"get_context_window_usage",
				{ targets: ["product-head"] },
				{ getContextUsage: () => ({ tokens: 43_210, contextWindow: 200_000, percent: 21.605 }) },
			);

			assert.match(
				result.content[0]?.text,
				/Teammate product-head \(Pi session ID: product-head-\d+\) on team visible-context-team \(team ID: fake-main-session-id-visible-context-team\) has used 87k tokens out of 272k available \(32%\)\.\nYou have used 43k tokens out of 200k available \(22%\)\./,
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
				teamName: teamName,
				startIdle: true, commonPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [{ name: "reviewer", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			const visibleStart = lines(fake.eventsPath).find((entry) => entry.type === "pi_start");
			assert.deepEqual(
				(spawnResult.details?.teammates as JsonRecord[])?.map(({ name, teammateId }) => ({ name, teammateId })),
				[{ name: "reviewer", teammateId: visibleStart?.sessionId }],
				`Expected visible spawn to return the Pi session identity. Got: ${JSON.stringify(spawnResult.details)}`,
			);
			await originHost.execute("team_shutdown", { team: teamId });

			resumingHost = new ExtensionHost();
			const resumeResult = await resumingHost.execute("team_resume", { team: teamId });
			assert.deepEqual((resumeResult.details?.teammates as JsonRecord[])?.map((member) => member.name), ["reviewer"], `Expected the visible member to remain resumable. Got: ${JSON.stringify(resumeResult.details)}`);
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
				teamName: teamName,
				startIdle: true, commonPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [{ name: "reviewer", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			const listing = await originHost.execute("team_list", {});
			const listedTeam = (listing.details?.teams as JsonRecord[])?.find((team) => team.teamId === teamId);
			const reviewerSession = (listedTeam?.teammates as JsonRecord[])?.find((member) => member.name === "reviewer");
			assert.ok(reviewerSession, "The full team listing must expose the resumable session path.");
			fs.writeFileSync(String(reviewerSession.sessionFile), '{"type":"session"}\n');
			await originHost.execute("team_shutdown", { team: teamId });

			resumingHost = new ExtensionHost();
			await resumingHost.execute("team_resume", { team: teamId, showOnHerdrPanes: true });
			const starts = lines(fake.logPath).filter((entry) => entry.type === "start");
			assert.equal(starts.length, 2, `Expected explicit visible resume to open a new Herdr pane. Got: ${JSON.stringify(starts)}`);
			const command = lines(fake.eventsPath).filter((entry) => entry.type === "pi_start").at(-1)?.args as string[];
			assert.equal(command[command.indexOf("--session") + 1], reviewerSession.sessionFile, `Expected visible resume to use the durable session file. Got: ${JSON.stringify(command)}`);
			assert.equal(command.includes("--model"), false, `Expected the persisted session to restore its own model. Got: ${JSON.stringify(command)}`);
			assert.equal(command[command.indexOf("--thinking") + 1], "low", `Expected visible resume to pass the saved thinking level, which a forked session does not record. Got: ${JSON.stringify(command)}`);
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
				teamName: "visible-team",
				startIdle: true, commonPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [{ name: "reviewer", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" }],
			});
			const split = lines(fake.logPath).find((entry) => entry.type === "split");
			assert.ok(split, "Herdr must create a dedicated pane.");
			assert.deepEqual((split.args as string[]).slice(0, 8), ["pane", "split", "--pane", "main-pane", "--direction", "right", "--no-focus", "--cwd"]);
			const startArgs = lines(fake.eventsPath).find((entry) => entry.type === "pi_start")?.args as string[];
			assert.equal(startArgs.includes("--mode"), false);
			assert.equal(startArgs.includes("-e"), true);
			assert.equal(startArgs.includes("--model"), true);
			assert.equal(startArgs.includes("--thinking"), true);
			assert.equal(startArgs.includes("--system-prompt"), false);
			assert.equal(startArgs.some((argument) => argument.startsWith("PATH=")), false);
			assert.equal(startArgs.includes("HERDR_PANE_ID=main-pane"), false);

			await host.execute("team_send_message", { targets: ["reviewer"], message: "check this", interrupt: false });
			await waitFor(() => lines(fake.eventsPath).some((entry) => entry.type === "parent" && (entry.args as JsonRecord)?.event && ((entry.args as JsonRecord).event as JsonRecord).type === "agent_end"));
			await new Promise((resolve) => setTimeout(resolve, 25));
			const forwardedEvents = lines(fake.eventsPath)
				.filter((entry) => entry.type === "parent" && entry.tool === "event")
				.map((entry) => ((entry.args as JsonRecord).event as JsonRecord).type);
			assert.deepEqual(forwardedEvents, ["agent_start", "tool_execution_start", "tool_execution_end", "agent_end"]);
			const log = await host.execute("team_log", { targets: ["visible-team" ]});
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
				teamName: "externally-closed-team",
				startIdle: true, commonPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [{ name: "reviewer", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" }],
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
				teamName: "startup-failure-team",
				startIdle: true, commonPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [{ name: "broken", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" }],
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
				teamName: "rollback-team",
				startIdle: true, commonPrompt: "test",
				showOnHerdrPanes: true,
				teammates: [
					{ name: "first", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" },
					{ name: "second", systemPrompt: "wait", model: "fake/fake-model", thinking: "low" },
				],
			}), /planned start failure/);
			assert.deepEqual(lines(fake.logPath).filter((entry) => entry.type === "close"), [{ type: "close", paneId: "fake-pane-1" }]);
		} finally {
			await host.shutdown();
			fake.restore();
		}
	});
});

/** Gives a fake teammate a saved session with one exchange, as a real Pi writes after its first answer, and returns the file. */
async function savedSessionOf(host: ExtensionHost, teammateName: string): Promise<string> {
	const listing = await host.execute("team_list", {});
	const member = ((listing.details?.teams as JsonRecord[])[0]!.teammates as JsonRecord[]).find((teammate) => teammate.name === teammateName)!;
	const sessionFile = String(member.sessionFile);
	fs.rmSync(sessionFile, { force: true });
	const session = SessionManager.open(sessionFile, path.dirname(sessionFile), path.dirname(sessionFile));
	session.appendMessage({ role: "user", content: "Start.", timestamp: Date.now() });
	session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Done." }], api: "openai-completions", provider: "fake", model: "fake-model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
	assert.ok(fs.existsSync(sessionFile), "The fixture session must be saved.");
	return sessionFile;
}

function thinkingChanges(sessionFile: string): string[] {
	return fs.readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; thinkingLevel?: string }).filter((entry) => entry.type === "thinking_level_change").map((entry) => entry.thinkingLevel!);
}

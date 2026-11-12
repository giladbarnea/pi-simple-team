import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import teamExtension from "../index.ts";
import { loadAsBunStandalonePi, useEnvironment } from "./pi-launch.ts";
import type { TeamLogEntry } from "../teamlog.ts";

type JsonRecord = Record<string, unknown>;
type ToolResult = { content: Array<{ type: string; text: string }>; details: JsonRecord };
type RegisteredTool = { name: string; execute: (id: string, params: JsonRecord, signal: AbortSignal, update: undefined, context: unknown) => Promise<ToolResult> };

const exitNoticeGraceMilliseconds = 2_000;

/**
 * Stands in for Herdr without a Herdr server or a real terminal. `pane run` starts the command under `script`, which gives it a private
 * pseudo-terminal, as a pane does. `tail -f /dev/null` holds that terminal open. Killing the group closes the terminal, so Pi receives
 * SIGHUP, as when a pane closes. The `script` arguments are the macOS ones.
 */
const pseudoTerminalHerdr = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const state = process.env.PI_TEST_PANE_STATE;
if (args[0] === "status") { process.stdout.write(JSON.stringify({ server: { running: true, compatible: true } })); process.exit(0); }
if (args[0] === "pane" && args[1] === "split") {
  const paneId = "pane-" + Date.now() + "-" + process.pid;
  const environment = { ...process.env, HERDR_PANE_ID: paneId, TERM: "xterm-256color" };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--env") continue;
    const split = args[index + 1].indexOf("=");
    environment[args[index + 1].slice(0, split)] = args[index + 1].slice(split + 1);
  }
  fs.writeFileSync(path.join(state, paneId + ".json"), JSON.stringify({ environment, cwd: args[args.indexOf("--cwd") + 1] }));
  process.stdout.write(JSON.stringify({ result: { pane: { pane_id: paneId }, type: "pane_split" } }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "rename") { process.stdout.write(JSON.stringify({ result: { type: "ok" } })); process.exit(0); }
if (args[0] === "pane" && args[1] === "run") {
  const { environment, cwd } = JSON.parse(fs.readFileSync(path.join(state, args[2] + ".json"), "utf8"));
  const command = "stty cols 120 rows 40; " + args[3];
  const terminal = spawn("/bin/sh", ["-c", "tail -f /dev/null | script -q /dev/null /bin/sh -c '" + command.replaceAll("'", "'\\''") + "'"], { env: environment, cwd, detached: true, stdio: "ignore" });
  terminal.unref();
  fs.writeFileSync(path.join(state, "pane-group"), String(terminal.pid));
  process.stdout.write(JSON.stringify({ result: { type: "ok" } }));
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "close") {
  try { process.kill(-Number(fs.readFileSync(path.join(state, "pane-group"), "utf8")), "SIGTERM"); } catch {}
  process.stdout.write(JSON.stringify({ result: { type: "ok" } }));
  process.exit(0);
}
process.stderr.write("unexpected herdr command: " + args.join(" ")); process.exit(2);
`;

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (await check()) return;
		await Bun.sleep(50);
	}
	assert.fail(`Timed out waiting for ${label}`);
}

/** A main session with one real interactive Pi teammate in a pseudo-terminal pane, started through the Herdr launch path. */
async function startPaneTeam(response: "immediate" | "slow") {
	const executable = Bun.which("pi");
	assert.ok(executable, "The real-Pi check requires Pi on PATH.");
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-pane-"));
	const agentDirectory = path.join(directory, "agent");
	const state = path.join(directory, "panes");
	const commands = path.join(directory, "bin");
	for (const created of [agentDirectory, state, commands]) fs.mkdirSync(created);
	fs.writeFileSync(path.join(commands, "herdr"), pseudoTerminalHerdr, { mode: 0o755 });
	const chunk = (delta: JsonRecord, finishReason: string | null): string => `data: ${JSON.stringify({ id: "pane-probe", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
	const provider = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request: Request): Promise<Response> {
			await request.json();
			const encoder = new TextEncoder();
			const words = response === "slow" ? 80 : 1;
			return new Response(new ReadableStream({ async start(controller) {
				controller.enqueue(encoder.encode(chunk({ role: "assistant", content: "" }, null)));
				for (let index = 0; index < words; index += 1) {
					if (response === "slow") await Bun.sleep(100);
					try { controller.enqueue(encoder.encode(chunk({ content: `word${index} ` }, null))); } catch { return; }
				}
				controller.enqueue(encoder.encode(`${chunk({}, "stop")}data: [DONE]\n\n`));
				controller.close();
			} }), { headers: { "content-type": "text/event-stream" } });
		},
	});
	fs.writeFileSync(path.join(agentDirectory, "models.json"), JSON.stringify({ providers: { "local-pane": {
		baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", apiKey: "local-fixture",
		models: [{ id: "probe", name: "Pane probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
	} } }));
	// An interactive Pi asks whether to trust the project folder before it loads extensions.
	fs.writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, defaultProjectTrust: "always", quietStartup: true }));
	const pidFile = path.join(state, "pi.pid");
	const quitMarker = path.join(state, "quit-after-next-run");
	const fixtureExtension = path.join(directory, "pid-and-quit.ts");
	fs.writeFileSync(fixtureExtension, `import * as fs from "node:fs";\nexport default function (pi) {\n\tpi.on("session_start", () => { fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); });\n\tpi.on("agent_settled", (_event, context) => { if (fs.existsSync(${JSON.stringify(quitMarker)})) context.shutdown(); });\n}\n`);
	const launcher = path.join(directory, "pi-launcher");
	fs.writeFileSync(launcher, `#!/bin/sh\nexec '${executable}' --no-skills --no-context-files --no-prompt-templates --no-themes "$@"\n`, { mode: 0o755 });
	const restoreEnvironment = useEnvironment({
		PATH: `${commands}${path.delimiter}${process.env.PATH ?? ""}`, PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1",
		HERDR_TAB_ID: "test-tab", HERDR_PANE_ID: "main-pane", PI_TEST_PANE_STATE: state,
	});
	const tools = new Map<string, RegisteredTool>();
	const shutdownHandlers: Array<() => Promise<void>> = [];
	const notices: string[] = [];
	const context = {
		cwd: directory, scopedModels: [], modelRegistry: { getAvailable: () => [{ provider: "local-pane", id: "probe" }], find: () => undefined },
		sessionManager: { getCwd: () => directory, getSessionId: () => "pane-main", getSessionFile: () => path.join(directory, "main.jsonl") },
	};
	const api = {
		on: (event: string, handler: (event: JsonRecord, context: unknown) => Promise<void>) => {
			if (event === "session_start") void handler({ reason: "startup" }, context);
			if (event === "session_shutdown") shutdownHandlers.push(() => handler({ reason: "quit" }, context));
		},
		registerCommand: () => undefined, registerMessageRenderer: () => undefined,
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		sendMessage: (message: JsonRecord) => { notices.push(String(message.content)); },
	} as unknown as ExtensionAPI;
	const execute = async (name: string, parameters: JsonRecord): Promise<ToolResult> => tools.get(name)!.execute("pane-probe", parameters, new AbortController().signal, undefined, context);
	const logEntries = async (): Promise<TeamLogEntry[]> => (await execute("team_log", { targets: ["panes"], limit: 100 })).details.entries as TeamLogEntry[];
	const close = async (): Promise<void> => {
		for (const shutdown of shutdownHandlers) await shutdown();
		provider.stop(true);
		restoreEnvironment();
		fs.rmSync(directory, { recursive: true, force: true });
	};
	try {
		loadAsBunStandalonePi(launcher, () => teamExtension(api));
		await execute("team_spawn", { teamName: "panes", commonPrompt: "Reply once.", teammates: [{ name: "probe", model: "local-pane/probe", thinking: "low", systemPrompt: "Reply once.", showOnHerdrPane: true, extensionPaths: [fixtureExtension] }] });
		return {
			close, notices,
			settled: (): Promise<void> => waitFor(async () => (await logEntries()).some((entry) => entry.kind === "agent_settled"), "the first run to settle"),
			working: (): Promise<void> => waitFor(async () => (await logEntries()).some((entry) => entry.kind === "agent_start"), "the first run to start").then(() => Bun.sleep(1_500)),
			status: async (): Promise<JsonRecord> => ((await execute("team_status", { team: "panes" })).details.status as Record<string, JsonRecord>).probe,
			childPid: (): number => Number(fs.readFileSync(pidFile, "utf8")),
			closePaneAsAUser: (): boolean => process.kill(-Number(fs.readFileSync(path.join(state, "pane-group"), "utf8")), "SIGTERM"),
			quitAfterNextRun: (): void => fs.writeFileSync(quitMarker, ""),
			send: (): Promise<ToolResult> => execute("team_send_message", { targets: ["probe"], message: "Reply again." }),
			shutdownTeam: (): Promise<ToolResult> => execute("team_shutdown", { team: "panes" }),
			ended: (): Promise<void> => waitFor(async () => {
				try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), 0); return false; } catch { return true; }
			}, "the teammate process to end").then(() => Bun.sleep(exitNoticeGraceMilliseconds + 500)),
		};
	} catch (error) {
		await close();
		throw error;
	}
}

const signalReasons = { SIGHUP: "Its pane may have been closed on purpose.", SIGTERM: "Something outside the team may have stopped it on purpose." };
const neutralNotice = (signal: keyof typeof signalReasons): string => `Teammate "probe" on team "panes" (team ID: pane-main-panes) shut down after ${signal}.\nCause: its Pi received ${signal} and shut down in order. ${signalReasons[signal]}\nUse team_resume to restart it if you still need it.`;
const failureNotice = `Teammate "probe" on team "panes" (team ID: pane-main-panes) exited.\nCause: its Pi process ended without shutting down (a crash, a kill, or its pane closed while it worked)\nCheck its pane if it is still open. Use team_resume to restart it.`;

describe.skipIf(process.env.PI_SIMPLE_TEAM_TEST_REAL_PI !== "1" || process.platform !== "darwin")("Herdr pane teammate ends with a real interactive Pi", () => {
	test("closing an idle teammate's pane gives main one neutral notice that names SIGHUP", async () => {
		const team = await startPaneTeam("immediate");
		try {
			await team.settled();
			team.closePaneAsAUser();
			await team.ended();
			assert.deepEqual(team.notices, [neutralNotice("SIGHUP")], "A closed pane must reach main once, and must not read as an error or a crash.");
			const status = await team.status();
			assert.deepEqual({ word: status.word, phrase: status.phrase }, { word: "stopped", phrase: "Shut down after SIGHUP" }, "The status names the signal.");
		} finally {
			await team.close();
		}
	}, 40_000);

	test.each(["SIGTERM", "SIGHUP"] as const)("an outside %s to a pane teammate gives the same neutral notice", async (signal) => {
		const team = await startPaneTeam("immediate");
		try {
			await team.settled();
			process.kill(team.childPid(), signal);
			await team.ended();
			assert.deepEqual(team.notices, [neutralNotice(signal)], "A signal shutdown reads the same whoever sent the signal.");
		} finally {
			await team.close();
		}
	}, 40_000);

	test("a killed pane teammate gives main one failure notice and stops being live", async () => {
		const team = await startPaneTeam("immediate");
		try {
			await team.settled();
			process.kill(team.childPid(), "SIGKILL");
			await team.ended();
			assert.deepEqual(team.notices, [failureNotice], "A process death that Herdr cannot report must reach main through the lifeline.");
			const status = await team.status();
			assert.deepEqual({ word: status.word, phrase: status.phrase }, { word: "stopped", phrase: "Ended without shutting down" }, "A dead teammate must not stay idle.");
		} finally {
			await team.close();
		}
	}, 40_000);

	test("a pane that main closes with team_shutdown sends nothing", async () => {
		const team = await startPaneTeam("immediate");
		try {
			await team.settled();
			await team.shutdownTeam();
			await team.ended();
			assert.deepEqual(team.notices, [], "Main asked for this end.");
		} finally {
			await team.close();
		}
	}, 40_000);

	test("a pane teammate that quits itself sends nothing", async () => {
		const team = await startPaneTeam("immediate");
		try {
			await team.settled();
			team.quitAfterNextRun();
			await team.send();
			await team.ended();
			assert.deepEqual(team.notices, [], "A self-quit is excluded, as for a background teammate.");
			assert.equal((await team.status()).phrase, "Session shut down", "A self-quit keeps its status.");
		} finally {
			await team.close();
		}
	}, 40_000);

	test("closing the pane of a working teammate gives main exactly one notice", async () => {
		const team = await startPaneTeam("slow");
		try {
			await team.working();
			team.closePaneAsAUser();
			await team.ended();
			// Pi usually exits at once when its terminal vanishes under a working session, and sometimes still shuts down in order.
			assert.equal(team.notices.length, 1, `Expected one notice. Got: ${JSON.stringify(team.notices)}`);
			assert.ok([neutralNotice("SIGHUP"), failureNotice].includes(team.notices[0]), `Expected the neutral or the failure notice. Got: ${team.notices[0]}`);
		} finally {
			await team.close();
		}
	}, 40_000);
});

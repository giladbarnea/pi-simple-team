import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import teamExtension from "../index.ts";
import { teamLogLines } from "../render.ts";
import type { TeamLogEntry } from "../teamlog.ts";

type JsonRecord = Record<string, unknown>;
type ToolResult = { content: Array<{ type: string; text: string }>; details: JsonRecord };
type RegisteredTool = { name: string; execute: (id: string, params: JsonRecord, signal: AbortSignal, update: undefined, context: unknown) => Promise<ToolResult> };
type Scenario = "retry" | "cancel" | "complete" | "error" | "interrupt" | "queued";

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		if (await check()) return;
		await Bun.sleep(10);
	}
	assert.fail(`Timed out waiting for ${label}`);
}

async function startTeam(scenario: Scenario) {
	assert.deepEqual(Object.keys(process.env).filter((name) => name.startsWith("PI_SIMPLE_TEAM_") && name !== "PI_SIMPLE_TEAM_TEST_REAL_PI"), [], "Run settlement tests without live team routing or credentials.");
	const executable = Bun.which("pi");
	assert.ok(executable, "The real-Pi check requires Pi 1.1.0 or newer on PATH.");
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-settlement-"));
	const agentDirectory = path.join(directory, "agent");
	fs.mkdirSync(agentDirectory);
	let requestCount = 0;
	let releaseRetry: () => void = () => undefined;
	const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
	const provider = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(): Promise<Response> {
			requestCount += 1;
			if (scenario === "error") return Response.json({ error: { message: "Invalid API key fixture" } }, { status: 401 });
			if (scenario === "retry" && requestCount === 1) return Response.json({ error: { message: "overloaded fixture" } }, { status: 503 });
			if (scenario === "retry" || ((scenario === "interrupt" || scenario === "queued") && requestCount === 1)) await retryGate;
			const chunk = (delta: JsonRecord, finishReason: string | null): string => `data: ${JSON.stringify({ id: "settlement-probe", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
			return new Response(chunk({ role: "assistant", content: "Successful response." }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		},
	});
	fs.writeFileSync(path.join(agentDirectory, "models.json"), JSON.stringify({ providers: { "local-settlement": {
		baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", apiKey: "local-fixture",
		models: [{ id: "probe", name: "Settlement probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
	} } }));
	fs.writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: scenario === "retry", maxRetries: 1, baseDelayMs: 10, provider: { maxRetries: 0 } } }));
	const cancellationExtension = path.join(directory, "cancel-after-response.ts");
	fs.writeFileSync(cancellationExtension, 'export default function (pi) { pi.on("agent_before_settle", (_event, context) => { context.abort(); }); }\n');
	const launcher = path.join(directory, "pi-launcher");
	const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
	fs.writeFileSync(launcher, `#!/bin/sh\nexec ${quote(executable)} --no-skills --no-context-files --no-prompt-templates --no-themes "$@"\n`, { mode: 0o755 });
	const previousExecutable = process.argv[1];
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	const previousOffline = process.env.PI_OFFLINE;
	process.argv[1] = launcher;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.PI_OFFLINE = "1";
	const tools = new Map<string, RegisteredTool>();
	const shutdownHandlers: Array<() => Promise<void>> = [];
	const context = {
		cwd: directory, scopedModels: [], modelRegistry: { getAvailable: () => [{ provider: "local-settlement", id: "probe" }] },
		sessionManager: { getCwd: () => directory, getSessionId: () => `settlement-${scenario}`, getSessionFile: () => path.join(directory, "main.jsonl") },
	};
	const api = {
		on: (event: string, handler: (event: JsonRecord, context: unknown) => Promise<void>) => {
			if (event === "session_start") void handler({ reason: "startup" }, context);
			if (event === "session_shutdown") shutdownHandlers.push(() => handler({ reason: "quit" }, context));
		},
		registerCommand: () => undefined, registerMessageRenderer: () => undefined,
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
	} as unknown as ExtensionAPI;
	const execute = async (name: string, parameters: JsonRecord): Promise<ToolResult> => {
		const tool = tools.get(name);
		assert.ok(tool, `Missing tool ${name}`);
		return tool.execute("settlement-probe", parameters, new AbortController().signal, undefined, context);
	};
	const close = async (): Promise<void> => {
		releaseRetry();
		for (const shutdown of shutdownHandlers) await shutdown();
		provider.stop(true);
		process.argv[1] = previousExecutable;
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
		fs.rmSync(directory, { recursive: true, force: true });
	};
	try {
		teamExtension(api);
		const spawned = await execute("team_spawn", { teamName: "settlement", startIdle: true, commonPrompt: "Respond once.", teammates: [{ name: "probe", model: "local-settlement/probe", thinking: "low", systemPrompt: "Wait for a message.", extensionPaths: scenario === "cancel" ? [cancellationExtension] : [] }] });
		await execute("team_send_message", { targets: ["probe"], message: "Do the small task." });
		return {
			close, releaseRetry, requests: () => requestCount,
			sessionFile: String((spawned.details.teammates as JsonRecord[])[0].sessionFile),
			log: async (): Promise<ToolResult> => execute("team_log", { targets: ["settlement"], limit: 100 }),
			send: async (interrupt: boolean): Promise<ToolResult> => execute("team_send_message", { targets: ["probe"], message: "Continue with this message.", interrupt }),
			active: async (): Promise<boolean> => {
				const listing = await execute("team_list", {});
				return Boolean(((listing.details.teams as JsonRecord[])[0].teammates as JsonRecord[])[0].active);
			},
		};
	} catch (error) {
		await close();
		throw error;
	}
}

const plainTheme = { fg: (_token: string, text: string): string => text, bold: (text: string): string => text };

function renderedLog(result: ToolResult): string {
	const entries = result.details.entries as TeamLogEntry[];
	return teamLogLines(plainTheme, { team: "settlement", entries, totalMatched: entries.length, returned: entries.length }).join("\n");
}

describe.skipIf(process.env.PI_SIMPLE_TEAM_TEST_REAL_PI !== "1")("teammate settlement reporting", () => {
	test.each(["complete", "error"] as const)("a %s run ends without falsely claiming cancellation or success", async (scenario) => {
		const child = await startTeam(scenario);
		try {
			await waitFor(async () => child.requests() === 1 && !(await child.active()), `${scenario} settlement`);
			const transcript = fs.readFileSync(child.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { message?: { role: string; stopReason?: string } });
			assert.equal(transcript.filter((entry) => entry.message?.role === "assistant").at(-1)?.message?.stopReason, scenario === "error" ? "error" : "stop", "The controls must exercise an actual provider failure and a normal response.");
			const result = await child.log();
			assert.deepEqual((result.details.entries as TeamLogEntry[]).filter((entry) => entry.kind === "agent_settled").map((entry) => entry.details), [{ aborted: false }], "A non-cancelled run emits exactly one false-aborted settlement, even on failure.");
			assert.match(result.content[0].text, /probe run ended/, "Final non-cancelled settlement must be visible to main.");
			assert.doesNotMatch(result.content[0].text + renderedLog(result), /cancelled|finished|completed|succeeded/, "A false cancellation flag does not prove success.");
		} finally {
			await child.close();
		}
	}, 30000);

	test.each(["interrupt", "queued"] as const)("a %s delivery preserves activity and waits for the correct settlement boundary", async (scenario) => {
		const child = await startTeam(scenario);
		try {
			await waitFor(async () => child.requests() === 1 && await child.active(), "the held active response");
			await child.send(scenario === "interrupt");
			if (scenario === "queued") {
				await waitFor(async () => ((await child.log()).details.entries as TeamLogEntry[]).filter((entry) => entry.kind === "ack").length === 2, "the ordinary message to enter the busy child's queue");
				assert.equal(await child.active(), true, "Accepting queued work must not clear current activity.");
				child.releaseRetry();
			}
			await waitFor(async () => child.requests() === 2 && !(await child.active()), "the delivered work to settle");
			const settlements = ((await child.log()).details.entries as TeamLogEntry[]).filter((entry) => entry.kind === "agent_settled");
			assert.deepEqual(settlements.map((entry) => entry.details), scenario === "interrupt" ? [{ aborted: true }, { aborted: false }] : [{ aborted: false }], "Interrupt must settle the cancelled run before the new work. Ordinary queued work belongs to one settlement.");
		} finally {
			await child.close();
		}
	}, 30000);

	test("cancellation after a successful response reaches the parent log and dashboard as cancellation", async () => {
		const child = await startTeam("cancel");
		try {
			await waitFor(async () => child.requests() === 1 && !(await child.active()), "cancelled settlement after the successful response");
			const transcript = fs.readFileSync(child.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { message?: { role: string; stopReason?: string } });
			assert.equal(transcript.filter((entry) => entry.message?.role === "assistant").at(-1)?.message?.stopReason, "stop", "This cancellation must occur after a successful assistant response, not an aborted message.");
			const result = await child.log();
			assert.match(result.content[0].text, /probe run cancelled/, "The parent log must distinguish a cancelled run from a finished attempt.");
			const settlement = (result.details.entries as TeamLogEntry[]).find((entry) => entry.kind === "agent_settled");
			assert.deepEqual(settlement?.details, { aborted: true }, "Child settlement must preserve Pi's cancellation flag through the callback.");
			assert.match(renderedLog(result), /cancelled/, "The shared dashboard renderer must show cancellation, not just a closed attempt.");
		} finally {
			await child.close();
		}
	}, 30000);

	test("a retried attempt does not announce final completion while its retry is still running", async () => {
		const child = await startTeam("retry");
		try {
			await waitFor(async () => child.requests() === 2 && ((await child.log()).details.entries as TeamLogEntry[]).some((entry) => entry.kind === "agent_end"), "the failed attempt and blocked retry");
			assert.equal(await child.active(), true, "A retry must remain active after the failed attempt ends.");
			const duringRetry = await child.log();
			assert.doesNotMatch(duringRetry.content[0].text, /probe finished/, "An agent_end before automatic retry is not the teammate's final completion.");
			assert.match(renderedLog(duringRetry), /attempt/, "The dashboard must identify the ended work as an attempt, not a whole turn or run.");
			assert.equal((duringRetry.details.entries as TeamLogEntry[]).filter((entry) => entry.kind === "agent_settled").length, 0, "A held retry has no final settlement yet.");
			child.releaseRetry();
			await waitFor(async () => !(await child.active()), "final settlement after retry");
			const entries = (await child.log()).details.entries as TeamLogEntry[];
			assert.equal(entries.filter((entry) => entry.kind === "agent_end").length, 2, "Both low-level attempts must remain observable.");
			assert.deepEqual(entries.filter((entry) => entry.kind === "agent_settled").map((entry) => entry.details), [{ aborted: false }], "Recovered retries end with one non-cancelled settlement.");
		} finally {
			await child.close();
		}
	}, 30000);
});

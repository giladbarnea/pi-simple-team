import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import teamExtension from "../index.ts";
import { loadAsBunStandalonePi, useEnvironment } from "./pi-launch.ts";

type JsonRecord = Record<string, unknown>;
type ToolResult = { content: Array<{ type: string; text: string }>; details: JsonRecord };
type RegisteredTool = { name: string; execute: (id: string, params: JsonRecord, signal: AbortSignal, update: undefined, context: unknown) => Promise<ToolResult> };
type ModelMessage = { role: string; content: unknown };
type ModelRequest = { messages: ModelMessage[] };
type RuntimeRecord = { member: string; version: string };
type TeammateDefinition = { name: string; systemPrompt: string; canManageOwnTeams?: boolean };

/** @example messageText({ role: "user", content: [{ type: "text", text: "hi" }] }) // "hi" */
function messageText(message: ModelMessage | undefined): string {
	if (!message || message.content === null || message.content === undefined) return "";
	if (typeof message.content === "string") return message.content;
	return (message.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");
}

/** The local model acts out each `TOOL <name> <json arguments>` line of its latest user message, one call per step, then answers. */
function scriptedReply(request: ModelRequest): { delta: JsonRecord; finishReason: string } {
	const lastUser = request.messages.findLastIndex((message) => message.role === "user");
	const steps = [...messageText(request.messages[lastUser]).matchAll(/^TOOL (\S+) (.+)$/gm)];
	const step = request.messages.slice(lastUser + 1).filter((message) => message.role === "tool").length;
	const directive = steps[step];
	if (!directive) return { delta: { content: "Done." }, finishReason: "stop" };
	return { delta: { tool_calls: [{ index: 0, id: `call-${step}`, type: "function", function: { name: directive[1], arguments: directive[2] } }] }, finishReason: "tool_calls" };
}

/** The teammate a model request belongs to, from its own team briefing. */
function requester(request: ModelRequest): string | undefined {
	return request.messages.map(messageText).join("\n").match(/You are (\S+), a teammate on team/)?.[1];
}

function toolLine(name: string, parameters: JsonRecord): string {
	return `TOOL ${name} ${JSON.stringify(parameters)}`;
}

/** Real Pi teammates with a scripted local model. Main is this process; each teammate records the Pi version it runs. */
function startHarness() {
	assert.deepEqual(Object.keys(process.env).filter((name) => name.startsWith("PI_SIMPLE_TEAM_") && name !== "PI_SIMPLE_TEAM_TEST_REAL_PI"), [], "Run self-delivery tests without live team routing or credentials.");
	const executable = Bun.which("pi");
	assert.ok(executable, "The real-Pi check requires Pi on PATH.");
	const expectedVersion = spawnSync(executable, ["--version"], { encoding: "utf8" }).stdout.trim();
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-self-delivery-"));
	const agentDirectory = path.join(directory, "agent");
	fs.mkdirSync(agentDirectory);
	const requests: ModelRequest[] = [];
	const provider = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request: Request): Promise<Response> {
			const body = await request.json() as ModelRequest;
			requests.push(body);
			const { delta, finishReason } = scriptedReply(body);
			const chunk = (payload: JsonRecord, reason: string | null): string => `data: ${JSON.stringify({ id: "self-delivery", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta: payload, finish_reason: reason }] })}\n\n`;
			return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, finishReason) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		},
	});
	fs.writeFileSync(path.join(agentDirectory, "models.json"), JSON.stringify({ providers: { "local-self": {
		baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", apiKey: "local-fixture",
		models: [{ id: "probe", name: "Self-delivery probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
	} } }));
	fs.writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
	const runtimeFile = path.join(directory, "runtimes.jsonl");
	const versionProbe = path.join(directory, "version-probe.ts");
	fs.writeFileSync(versionProbe, `import * as fs from "node:fs";\nimport { VERSION } from "@earendil-works/pi-coding-agent";\nexport default function (pi) { pi.on("session_start", () => { fs.appendFileSync(${JSON.stringify(runtimeFile)}, JSON.stringify({ member: process.env.PI_SIMPLE_TEAM_MEMBER, version: VERSION }) + "\\n"); }); }\n`);
	const launcher = path.join(directory, "pi-launcher");
	fs.writeFileSync(launcher, `#!/bin/sh\nexec '${executable.replaceAll("'", "'\\''")}' --no-skills --no-context-files --no-prompt-templates --no-themes "$@"\n`, { mode: 0o755 });
	const restoreAgentEnvironment = useEnvironment({ PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1" });
	const tools = new Map<string, RegisteredTool>();
	const shutdownHandlers: Array<() => Promise<void>> = [];
	const mainMessages: string[] = [];
	const context = {
		cwd: directory, scopedModels: [], getContextUsage: () => ({ tokens: 0, contextWindow: 32000, percent: 0 }),
		modelRegistry: { getAvailable: () => [{ provider: "local-self", id: "probe" }], find: () => undefined },
		sessionManager: { getCwd: () => directory, getSessionId: () => "self-delivery-main", getSessionFile: () => path.join(directory, "main.jsonl") },
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
		return tool.execute("self-delivery", parameters, new AbortController().signal, undefined, context);
	};
	loadAsBunStandalonePi(launcher, () => teamExtension(api));
	return {
		mainMessages,
		versionProbe,
		spawn: (teamName: string, teammates: TeammateDefinition[]): Promise<ToolResult> => execute("team_spawn", {
			teamName, commonPrompt: "Self-delivery probe.",
			teammates: teammates.map((teammate) => ({ model: "local-self/probe", thinking: "low", extensionPaths: [versionProbe], ...teammate })),
		}),
		/** The user-role inputs of the named teammate's latest model request: its whole conversation so far. */
		inputsOf: (name: string): string[] => (requests.findLast((request) => requester(request) === name)?.messages ?? []).filter((message) => message.role === "user").map(messageText),
		/** The tool results of the named teammate's latest model request, in call order. */
		toolResultsOf: (name: string): string[] => (requests.findLast((request) => requester(request) === name)?.messages ?? []).filter((message) => message.role === "tool").map(messageText),
		quiet: async (): Promise<void> => {
			for (let attempt = 0; attempt < 300; attempt += 1) {
				const listing = await execute("team_list", {});
				const teammates = (listing.details.teams as Array<{ teammates: Array<{ active: boolean }> }>).flatMap((team) => team.teammates);
				if (teammates.length > 0 && teammates.every((teammate) => !teammate.active)) return;
				await Bun.sleep(50);
			}
			assert.fail("Timed out waiting for every teammate to settle");
		},
		assertPinnedRuntimes: (members: string[]): void => {
			const records = fs.readFileSync(runtimeFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as RuntimeRecord);
			assert.deepEqual(records.map((record) => record.member).sort(), [...members].sort(), `Every teammate process must report its runtime once. Records: ${JSON.stringify(records)}`);
			assert.deepEqual(records.filter((record) => record.version !== expectedVersion), [], `Every teammate process must run the Pi on PATH, ${expectedVersion}.`);
		},
		close: async (): Promise<void> => {
			for (const shutdown of shutdownHandlers) await shutdown();
			provider.stop(true);
			restoreAgentEnvironment();
			fs.rmSync(directory, { recursive: true, force: true });
		},
	};
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		if (check()) return;
		await Bun.sleep(50);
	}
	assert.fail(`Timed out waiting for ${label}`);
}

/** @example countPrefixed(["[from a on team t]\nhi", "other"], "[from a on team t]\nhi") // 1 */
function countPrefixed(inputs: string[], prefix: string): number {
	return inputs.filter((input) => input.startsWith(prefix)).length;
}

describe.skipIf(process.env.PI_SIMPLE_TEAM_TEST_REAL_PI !== "1")("a team message never comes back to its sender", () => {
	test("a team-wide message reaches every other teammate once and not the sender, from an ordinary and a managing teammate", async () => {
		const harness = startHarness();
		try {
			await harness.spawn("crew", [
				{ name: "alpha", systemPrompt: toolLine("team_send_message", { targets: ["crew"], message: "FROM_ALPHA" }) },
				{ name: "beta", systemPrompt: "Wait." },
				{ name: "lead", canManageOwnTeams: true, systemPrompt: toolLine("team_send_message", { targets: ["crew"], message: "FROM_LEAD" }) },
			]);
			const fromAlpha = "[from alpha on team crew]\nFROM_ALPHA";
			const fromLead = "[from lead on team crew]\nFROM_LEAD";
			await waitFor(() => harness.inputsOf("beta").some((input) => input.startsWith(fromAlpha)) && harness.inputsOf("beta").some((input) => input.startsWith(fromLead)), "beta to receive both team messages");
			await harness.quiet();
			const inputs = { alpha: harness.inputsOf("alpha"), beta: harness.inputsOf("beta"), lead: harness.inputsOf("lead") };
			assert.deepEqual(
				{ betaFromAlpha: countPrefixed(inputs.beta, fromAlpha), leadFromAlpha: countPrefixed(inputs.lead, fromAlpha), betaFromLead: countPrefixed(inputs.beta, fromLead), alphaFromLead: countPrefixed(inputs.alpha, fromLead) },
				{ betaFromAlpha: 1, leadFromAlpha: 1, betaFromLead: 1, alphaFromLead: 1 },
				"Every other teammate's model must receive each team message exactly once.",
			);
			assert.deepEqual(
				{ alphaFromItself: countPrefixed(inputs.alpha, fromAlpha), leadFromItself: countPrefixed(inputs.lead, fromLead) },
				{ alphaFromItself: 0, leadFromItself: 0 },
				"A sender's model must never receive its own team message, through the ordinary or the managing-teammate path.",
			);
			harness.assertPinnedRuntimes(["alpha", "beta", "lead"]);
		} finally {
			await harness.close();
		}
	}, 60_000);

	test("a send that selects only the sender is refused without waking it, and its report to main still arrives", async () => {
		const harness = startHarness();
		try {
			await harness.spawn("solo", [{ name: "only", systemPrompt: [toolLine("team_send_message", { targets: ["solo"], message: "SOLO_TEAM" }), toolLine("send_main_message", { message: "SOLO_TO_MAIN" })].join("\n") }]);
			await harness.spawn("solo-lead", [{ name: "boss", canManageOwnTeams: true, systemPrompt: [toolLine("team_send_message", { targets: ["boss"], message: "BOSS_SELF" }), toolLine("send_main_message", { message: "BOSS_TO_MAIN" })].join("\n") }]);
			await waitFor(() => harness.mainMessages.some((message) => message.includes("SOLO_TO_MAIN")) && harness.mainMessages.some((message) => message.includes("BOSS_TO_MAIN")), "both reports to reach main");
			await harness.quiet();
			for (const [sender, team, marker] of [["only", "solo", "SOLO_TEAM"], ["boss", "solo-lead", "BOSS_SELF"]] as const) {
				const sendResult = harness.toolResultsOf(sender)[0];
				assert.ok(sendResult, `${sender}'s model must receive its team_send_message result first. Tool results: ${JSON.stringify(harness.toolResultsOf(sender))}`);
				assert.doesNotMatch(sendResult, /"published": true/, `${sender}'s model must not be told a send to only itself was published. Got: ${sendResult}`);
				assert.match(sendResult, /send_main_message/, `${sender}'s model must be pointed to send_main_message. Got: ${sendResult}`);
				assert.equal(countPrefixed(harness.inputsOf(sender), `[from ${sender} on team ${team}]\n${marker}`), 0, `${sender}'s model must never receive its own message.`);
			}
			assert.deepEqual(harness.mainMessages.filter((message) => message.includes("_TO_MAIN")).sort(), ["[solo-lead/boss] BOSS_TO_MAIN", "[solo/only] SOLO_TO_MAIN"], "Reports to main must arrive once each, unchanged.");
			harness.assertPinnedRuntimes(["only", "boss"]);
		} finally {
			await harness.close();
		}
	}, 60_000);

	test("a managing teammate alone in its parent team still reaches its own team when it targets both", async () => {
		const harness = startHarness();
		try {
			const worker = { name: "worker", model: "local-self/probe", thinking: "low", extensionPaths: [harness.versionProbe], systemPrompt: "Wait." };
			await harness.spawn("upper", [{ name: "boss", canManageOwnTeams: true, systemPrompt: [
				toolLine("team_spawn", { teamName: "lower", commonPrompt: "Self-delivery probe.", startIdle: true, teammates: [worker] }),
				toolLine("team_send_message", { targets: ["upper", "lower"], message: "BOSS_TO_BOTH" }),
			].join("\n") }]);
			const fromBoss = "[from main on team lower]\nBOSS_TO_BOTH";
			await waitFor(() => harness.toolResultsOf("boss").length >= 2, "boss to receive its team_send_message result");
			await harness.quiet();
			await waitFor(() => harness.inputsOf("worker").some((input) => input.startsWith(fromBoss)), "the worker to receive the message");
			assert.match(harness.toolResultsOf("boss")[1], /"published": true/, "A send that reaches another teammate is published.");
			assert.equal(countPrefixed(harness.inputsOf("worker"), fromBoss), 1, "The other recipient's model must receive the message exactly once.");
			assert.equal(countPrefixed(harness.inputsOf("boss"), "[from boss on team upper]\nBOSS_TO_BOTH"), 0, "The sender's model must never receive its own message.");
			harness.assertPinnedRuntimes(["boss", "worker"]);
		} finally {
			await harness.close();
		}
	}, 60_000);
});

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { childToolNames } from "../child-tools.ts";
import teamExtension from "../index.ts";
import { loadAsBunStandalonePi } from "./pi-launch.ts";

type JsonRecord = Record<string, unknown>;
type ToolResult = { content: Array<{ type: string; text: string }>; details: JsonRecord };
type RegisteredTool = { name: string; execute: (id: string, params: JsonRecord, signal: AbortSignal, update: undefined, context: unknown) => Promise<ToolResult> };
type ModelRequest = { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function?: { name?: string } }> };

const repositoryDirectory = path.resolve(import.meta.dir, "..");
const teamRuntimePath = path.join(repositoryDirectory, "index.ts");
const humanToolsLine = "Do not use tools meant for interaction with a human.";

/** Tool names one load of the extension registers, with these process environment values. */
function registeredToolNames(environment: Record<string, string>): string[] {
	const names: string[] = [];
	const api = {
		on: () => undefined, registerCommand: () => undefined, registerMessageRenderer: () => undefined,
		registerTool: (tool: { name: string }) => names.push(tool.name),
	} as unknown as ExtensionAPI;
	const childEnvironment = { PI_SIMPLE_TEAM_CALLBACK_URL: "http://127.0.0.1:9/callback", PI_SIMPLE_TEAM_CALLBACK_TOKEN: "guard-token", PI_SIMPLE_TEAM_TEAM: "guard-team", PI_SIMPLE_TEAM_TEAM_NAME: "guard", PI_SIMPLE_TEAM_MEMBER: "probe", PI_SIMPLE_TEAM_PROCESS: "test-process", PI_SIMPLE_TEAM_PARTICIPANTS: '["probe"]', PI_SIMPLE_TEAM_CAN_MANAGE_OWN_TEAMS: "0" };
	const applied = { ...childEnvironment, ...environment };
	Object.assign(process.env, applied);
	try {
		teamExtension(api);
	} finally {
		for (const name of Object.keys(applied)) delete process.env[name];
	}
	return names;
}

describe("one team runtime per teammate process", () => {
	test("a discovered copy at another path registers nothing in a teammate process", () => {
		assert.deepEqual(registeredToolNames({ PI_SIMPLE_TEAM_CHILD: "1", PI_SIMPLE_TEAM_RUNTIME_PATH: "/elsewhere/pi-simple-team/index.ts" }), []);
	});

	test("the copy main loaded as the team runtime registers the teammate tools", () => {
		assert.deepEqual(registeredToolNames({ PI_SIMPLE_TEAM_CHILD: "1", PI_SIMPLE_TEAM_RUNTIME_PATH: teamRuntimePath }).sort(), [...childToolNames].sort());
	});

	test("a Pi started inside a teammate's shell runs as main even when it inherits the runtime path", () => {
		const names = registeredToolNames({ PI_SIMPLE_TEAM_CHILD: String(process.pid + 1), PI_SIMPLE_TEAM_RUNTIME_PATH: "/elsewhere/pi-simple-team/index.ts" });
		assert.ok(names.includes("team_list"), `A nested main must keep its manager tools. Got: ${names}`);
	});
});

/** Starts one real-Pi teammate that discovers `discoveredExtensions` from user settings, and records its model requests. */
async function startTeammate(directory: string, discoveredExtensions: string[], extensionPaths: string[]) {
	const executable = Bun.which("pi");
	assert.ok(executable, "The real-Pi check requires pi on PATH.");
	const agentDirectory = path.join(directory, "agent");
	const projectDirectory = path.join(directory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);
	const modelRequests: ModelRequest[] = [];
	const provider = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request: Request): Promise<Response> {
			modelRequests.push(await request.json() as ModelRequest);
			const chunk = (delta: JsonRecord, finishReason: string | null): string => `data: ${JSON.stringify({ id: "inheritance-probe", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
			return new Response(chunk({ role: "assistant", content: "Done." }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		},
	});
	fs.writeFileSync(path.join(agentDirectory, "models.json"), JSON.stringify({ providers: { "local-inheritance": {
		baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", apiKey: "local-fixture",
		models: [{ id: "probe", name: "Inheritance probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
	} } }));
	fs.writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({ extensions: discoveredExtensions, compaction: { enabled: false }, retry: { enabled: false } }));
	const launcher = path.join(directory, "pi-launcher");
	const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
	fs.writeFileSync(launcher, `#!/bin/sh\nexec ${quote(executable)} --no-skills --no-context-files "$@"\n`, { mode: 0o755 });
	const previous = { agentDirectory: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.PI_OFFLINE = "1";
	const tools = new Map<string, RegisteredTool>();
	const shutdownHandlers: Array<() => Promise<void>> = [];
	const context = {
		cwd: projectDirectory, scopedModels: [], modelRegistry: { getAvailable: () => [{ provider: "local-inheritance", id: "probe" }] },
		sessionManager: { getCwd: () => projectDirectory, getSessionId: () => "inheritance-main", getSessionFile: () => path.join(directory, "main.jsonl") },
	};
	const api = {
		on: (event: string, handler: (event: JsonRecord, context: unknown) => Promise<void>) => {
			if (event === "session_start") void handler({ reason: "startup" }, context);
			if (event === "session_shutdown") shutdownHandlers.push(() => handler({ reason: "quit" }, context));
		},
		registerCommand: () => undefined, registerMessageRenderer: () => undefined,
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
	} as unknown as ExtensionAPI;
	const close = async (): Promise<void> => {
		for (const shutdown of shutdownHandlers) await shutdown();
		provider.stop(true);
		for (const [name, value] of [["PI_CODING_AGENT_DIR", previous.agentDirectory], ["PI_OFFLINE", previous.offline]] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
	try {
		loadAsBunStandalonePi(launcher, () => teamExtension(api));
		await tools.get("team_spawn")!.execute("inheritance", { teamName: "inheritance", commonPrompt: "Respond once.", teammates: [{ name: "probe", model: "local-inheritance/probe", thinking: "low", systemPrompt: "Answer.", extensionPaths }] }, new AbortController().signal, undefined, context);
		for (let attempt = 0; attempt < 1000 && modelRequests.length === 0; attempt += 1) await Bun.sleep(10);
		assert.ok(modelRequests.length > 0, "Expected the teammate's first model request.");
		return { firstRequest: modelRequests[0], close };
	} catch (error) {
		await close();
		throw error;
	}
}

/** A tiny extension file that registers one named tool. */
function writeToolExtension(directory: string, toolName: string): string {
	const file = path.join(directory, `${toolName}.ts`);
	fs.writeFileSync(file, `export default function (pi) { pi.registerTool({ name: ${JSON.stringify(toolName)}, label: "Probe", description: "Probe tool.", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "ok" }] }; } }); }\n`);
	return file;
}

/** A second installed copy of this package at another path, as a user with a development checkout would have. */
function writePackageCopy(directory: string): string {
	const copy = path.join(directory, "installed-pi-simple-team");
	fs.mkdirSync(copy);
	for (const entry of fs.readdirSync(repositoryDirectory)) {
		if (entry.endsWith(".ts") || entry === "render-support") fs.cpSync(path.join(repositoryDirectory, entry), path.join(copy, entry), { recursive: true });
	}
	fs.writeFileSync(path.join(copy, "package.json"), JSON.stringify({ name: "pi-simple-team", type: "module", pi: { extensions: ["./index.ts"] } }));
	return copy;
}

const declaredToolNames = (request: ModelRequest): string[] => (request.tools ?? []).map((tool) => String(tool.function?.name));

describe.skipIf(process.env.PI_SIMPLE_TEAM_TEST_REAL_PI !== "1")("teammates inherit discovered extensions", () => {
	test("a teammate receives a discovered extension's tool, its extensionPaths tool and the human-tools briefing line", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-inheritance-"));
		const teammate = await startTeammate(directory, [writeToolExtension(directory, "discovered_probe")], [writeToolExtension(directory, "explicit_probe")]);
		try {
			const declared = declaredToolNames(teammate.firstRequest);
			assert.ok(declared.includes("discovered_probe"), `A discovered extension must load in the teammate. Declared: ${declared}`);
			assert.ok(declared.includes("explicit_probe"), `extensionPaths must still load. Declared: ${declared}`);
			assert.ok(JSON.stringify(teammate.firstRequest.messages).includes(humanToolsLine), "The teammate briefing must say not to use tools meant for a human.");
		} finally {
			await teammate.close();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	test("a discovered second copy of pi-simple-team neither stops startup nor registers its tools twice", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-duplicate-copy-"));
		const teammate = await startTeammate(directory, [writePackageCopy(directory)], []);
		try {
			const declared = declaredToolNames(teammate.firstRequest);
			for (const toolName of childToolNames) assert.equal(declared.filter((name) => name === toolName).length, 1, `Expected ${toolName} once. Declared: ${declared}`);
		} finally {
			await teammate.close();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});

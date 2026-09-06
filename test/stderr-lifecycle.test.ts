import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import teamExtension from "../index.ts";

type JsonRecord = Record<string, unknown>;
type ToolResult = { content: Array<{ type: string; text: string }>; details: JsonRecord };
type RegisteredTool = { name: string; execute: (id: string, params: JsonRecord, signal: AbortSignal, update: undefined, context: unknown) => Promise<ToolResult> };
type LogEntry = { kind: string; summary: string };

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
	for (let attempt = 0; attempt < 150; attempt += 1) {
		if (await check()) return;
		await Bun.sleep(100);
	}
	assert.fail(`Timed out waiting for ${label}`);
}

describe.skipIf(process.env.PI_SIMPLE_TEAM_TEST_REAL_PI !== "1")("RPC stderr and conversation lifetime", () => {
	test("keeps stderr previews and the same Pi conversation across follow-up turns", async () => {
		const executable = Bun.which("pi");
		assert.ok(executable, "The real-Pi check requires pi on PATH");
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-stderr-"));
		const agentDirectory = path.join(directory, "agent");
		fs.mkdirSync(agentDirectory);
		const requests: JsonRecord[] = [];
		const token = `remember-${crypto.randomUUID()}`;
		const diagnostic = `stderr-preview-${crypto.randomUUID()}`;
		const provider = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			async fetch(request: Request): Promise<Response> {
				const body = await request.json() as JsonRecord;
				requests.push(body);
				const messages = body.messages as Array<{ role: string; content: unknown }>;
				const remembered = messages.some((message) => message.role !== "system" && JSON.stringify(message.content).includes(token));
				const answer = requests.length === 1 ? "Stored." : remembered ? token : "MISSING_CONTEXT";
				const chunk = (delta: JsonRecord, finishReason: string | null): string => `data: ${JSON.stringify({ id: "local-probe", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
				return new Response(chunk({ role: "assistant", content: answer }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
			},
		});
		fs.writeFileSync(path.join(agentDirectory, "models.json"), JSON.stringify({ providers: { "local-probe": {
			baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", apiKey: "local-fixture",
			models: [{ id: "probe", name: "Local probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
		} } }));
		fs.writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
		const launcher = path.join(directory, "pi-launcher");
		const processIdFile = path.join(directory, "child.pid");
		const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
		fs.writeFileSync(launcher, `#!/bin/sh\nprintf '%s' "$$" > ${quote(processIdFile)}\nprintf '%s\\n' ${quote(diagnostic + " ".repeat(2) + "x".repeat(2000))} >&2\nexec ${quote(executable)} "$@"\n`, { mode: 0o755 });
		const previousExecutable = process.argv[1];
		const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
		const previousOffline = process.env.PI_OFFLINE;
		process.argv[1] = launcher;
		process.env.PI_CODING_AGENT_DIR = agentDirectory;
		process.env.PI_OFFLINE = "1";
		const tools = new Map<string, RegisteredTool>();
		const shutdownHandlers: Array<() => Promise<void>> = [];
		const context = {
			cwd: directory, scopedModels: [], modelRegistry: { getAvailable: () => [{ provider: "local-probe", id: "probe" }] },
			sessionManager: { getCwd: () => directory, getSessionId: () => "test-main", getSessionFile: () => path.join(directory, "main.jsonl") },
		};
		const api = {
			on: (event: string, handler: (event: JsonRecord, context: unknown) => Promise<void>) => {
				if (event === "session_start") void handler({ reason: "startup" }, context);
				if (event === "session_shutdown") shutdownHandlers.push(() => handler({ reason: "quit" }, context));
			},
			registerCommand: () => {}, registerMessageRenderer: () => {},
			registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		} as unknown as ExtensionAPI;
		const execute = async (name: string, parameters: JsonRecord): Promise<ToolResult> => {
			const tool = tools.get(name);
			assert.ok(tool, `Missing tool ${name}`);
			return tool.execute("probe", parameters, new AbortController().signal, undefined, context);
		};
		const log = async (): Promise<LogEntry[]> => (await execute("teamlog", { team: "stderr-check", limit: 100 })).details.entries as LogEntry[];
		try {
			teamExtension(api);
			const spawned = await execute("team_spawn", { team: "stderr-check", teamPrompt: "Follow instructions.", teammates: [{ name: "probe", model: "local-probe/probe", thinking: "low", prompt: "Wait for a message." }] });
			const session = (spawned.details.sessions as Record<string, { sessionId: string; sessionFile: string }>).probe;
			const processId = Number(fs.readFileSync(processIdFile, "utf8"));
			await waitFor(async () => (await log()).some((entry) => entry.kind === "stderr" && entry.summary.includes(diagnostic)), "stderr preview");
			const stderrEntry = (await log()).find((entry) => entry.kind === "stderr" && entry.summary.includes(diagnostic))!;
			assert.ok(stderrEntry.summary.length < 2000, "The log should contain a shortened preview, not the complete stderr chunk");

			await execute("teamsend", { team: "stderr-check", to: ["probe"], message: `Remember this token: ${token}` });
			await waitFor(async () => (await log()).filter((entry) => entry.kind === "agent_end").length === 1, "first completed turn");
			assert.equal(requests.length, 1, "First delivery should produce exactly one model request");
			assert.ok(fs.readFileSync(session.sessionFile, "utf8").includes(token), "The first turn must remain in the durable Pi session");
			process.kill(processId, 0);

			await execute("teamsend", { team: "stderr-check", to: ["probe"], message: "What token did I ask you to remember?" });
			await waitFor(async () => (await log()).filter((entry) => entry.kind === "agent_end").length === 2, "follow-up completed turn");
			assert.equal(requests.length, 2, "Follow-up delivery should start one more real Pi turn");
			const followUpMessages = requests[1].messages as Array<{ role: string; content: unknown }>;
			assert.ok(followUpMessages.slice(0, -1).some((message) => JSON.stringify(message.content).includes(token)), "Follow-up model request lost the earlier conversation");
			assert.ok(!JSON.stringify(followUpMessages.at(-1)).includes(token), "The follow-up prompt must not supply the remembered token");
			const persistedEntries = fs.readFileSync(session.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { message?: { role: string; content: unknown } });
			const answer = persistedEntries.filter((entry) => entry.message?.role === "assistant").at(-1);
			assert.ok(JSON.stringify(answer?.message?.content).includes(token), "The follow-up answer must use the retained context");
			assert.equal(Number(fs.readFileSync(processIdFile, "utf8")), processId, "Follow-up must reuse the same Pi process");
			process.kill(processId, 0);
			const saved = fs.readFileSync(session.sessionFile, "utf8");
			assert.ok(saved.includes(session.sessionId) && saved.includes("What token"), "Both turns must use the registered session file");
		} finally {
			for (const shutdown of shutdownHandlers) await shutdown();
			provider.stop(true);
			process.argv[1] = previousExecutable;
			if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
			if (previousOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previousOffline;
			fs.rmSync(directory, { recursive: true, force: true });
		}
	}, 60000);
});

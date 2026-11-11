// A stand-in for main in its own process group, for the group-signal test in settlement.test.ts.
// It loads pi-simple-team, starts one real Pi teammate, and prints {"phase":"ready"}. On SIGHUP, which also reaches the
// teammate, it waits until the teammate has exited, then runs its own session_shutdown at once. That is the worst order
// for suppressing an exit notice. It does not run Pi's own dispose path.
// Usage: bun group-signal-host.ts <directory> <pi executable>   with PI_CODING_AGENT_DIR=<directory>/agent
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import teamExtension from "../index.ts";
import { loadAsBunStandalonePi } from "./pi-launch.ts";

type JsonRecord = Record<string, unknown>;
type RegisteredTool = { name: string; execute: (id: string, params: JsonRecord, signal: AbortSignal, update: undefined, context: unknown) => Promise<{ details: JsonRecord }> };

const [directory, executable] = process.argv.slice(2) as [string, string];
const agentDirectory = process.env.PI_CODING_AGENT_DIR!;
fs.mkdirSync(agentDirectory, { recursive: true });
process.env.PI_OFFLINE = "1";

const chunk = (delta: JsonRecord, finishReason: string | null): string => `data: ${JSON.stringify({ id: "group-signal", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
const provider = Bun.serve({
	hostname: "127.0.0.1", port: 0,
	async fetch(request: Request): Promise<Response> {
		await request.json();
		return new Response(chunk({ role: "assistant", content: "Done." }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	},
});
fs.writeFileSync(path.join(agentDirectory, "models.json"), JSON.stringify({ providers: { "local-group": {
	baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", apiKey: "local-fixture",
	models: [{ id: "probe", name: "probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
} } }));
fs.writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
const launcher = path.join(directory, "pi-launcher");
fs.writeFileSync(launcher, `#!/bin/sh\nexec '${executable}' --no-skills --no-context-files --no-prompt-templates --no-themes "$@"\n`, { mode: 0o755 });

const tools = new Map<string, RegisteredTool>();
const shutdownHandlers: Array<() => Promise<void>> = [];
const notices: string[] = [];
const context = {
	cwd: directory, scopedModels: [], modelRegistry: { getAvailable: () => [{ provider: "local-group", id: "probe" }], find: () => undefined },
	sessionManager: { getCwd: () => directory, getSessionId: () => "group-signal-main", getSessionFile: () => path.join(directory, "main.jsonl") },
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
loadAsBunStandalonePi(launcher, () => teamExtension(api));

async function execute(name: string, parameters: JsonRecord): Promise<JsonRecord> {
	return (await tools.get(name)!.execute("group-signal", parameters, new AbortController().signal, undefined, context)).details;
}
async function logEntries(): Promise<JsonRecord[]> {
	return (await execute("team_log", { targets: ["group"], limit: 100 })).entries as JsonRecord[];
}
async function waitForEntry(check: (entry: JsonRecord) => boolean): Promise<JsonRecord> {
	for (;;) {
		const entry = (await logEntries()).find(check);
		if (entry) return entry;
		await Bun.sleep(20);
	}
}
const print = (record: JsonRecord): void => { process.stdout.write(JSON.stringify(record) + "\n"); };

const keepAlive = setInterval(() => undefined, 1_000);
process.on("SIGHUP", async () => {
	const exit = await waitForEntry((entry) => entry.kind === "exit" && String(entry.summary).startsWith("exited"));
	print({ phase: "child-exited", summary: exit.summary });
	for (const shutdown of shutdownHandlers) await shutdown();
	await Bun.sleep(2_500);
	print({ phase: "finished", notices });
	clearInterval(keepAlive);
	provider.stop(true);
	process.exit(0);
});

await execute("team_spawn", { teamName: "group", commonPrompt: "Reply once.", teammates: [{ name: "probe", model: "local-group/probe", thinking: "low", systemPrompt: "Reply once." }] });
await waitForEntry((entry) => entry.kind === "agent_settled");
print({ phase: "ready" });

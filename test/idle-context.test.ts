import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "bun:test";
import { composeSystemPrompt } from "../system-prompt.ts";

type JsonRecord = Record<string, unknown>;
type ModelMessage = { role: string; content: unknown };

describe.skipIf(process.env.PI_SIMPLE_TEAM_TEST_REAL_PI !== "1")("idle conversation context", () => {
	test("records instructions without a turn and includes them once in the next model request", async () => {
		const executable = Bun.which("pi");
		assert.ok(executable, "The real-Pi check requires pi on PATH.");
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-idle-context-"));
		const instructions = `resumption-${crypto.randomUUID()}`;
		const commonPrompt = `common-${crypto.randomUUID()}`;
		const requests: Array<{ messages: ModelMessage[] }> = [];
		let deliveryUrl = "";
		let settled = false;
		const provider = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			async fetch(request: Request): Promise<Response> {
				requests.push(await request.json() as { messages: ModelMessage[] });
				const chunk = (delta: JsonRecord, finishReason: string | null): string => `data: ${JSON.stringify({ id: "idle-probe", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
				return new Response(chunk({ role: "assistant", content: "Done." }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
			},
		});
		const callback = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			async fetch(request: Request): Promise<Response> {
				const body = await request.json() as { tool: string; args: JsonRecord };
				if (body.tool === "register") deliveryUrl = String(body.args.url);
				if (body.tool === "event" && (body.args.event as JsonRecord).type === "agent_settled") settled = true;
				return Response.json(body.tool === "team_context" ? { participants: ["probe"], status: {} } : { accepted: true });
			},
		});
		fs.writeFileSync(path.join(directory, "models.json"), JSON.stringify({ providers: { "local-probe": {
			baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", apiKey: "local-fixture",
			models: [{ id: "probe", name: "Local probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
		} } }));
		fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
		const child = spawn(executable, [
			"--mode", "rpc", "--no-extensions", "-e", path.join(import.meta.dir, "..", "index.ts"),
			"--no-skills", "--no-context-files", "--model", "local-probe/probe", "--thinking", "low",
			"--system-prompt", composeSystemPrompt("idle-team", commonPrompt, "probe", "Follow the supplied instructions.", ["probe"]),
		], {
			cwd: directory,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1", PI_SIMPLE_TEAM_CHILD: "1", PI_SIMPLE_TEAM_CALLBACK_URL: `http://127.0.0.1:${callback.port}`, PI_SIMPLE_TEAM_CALLBACK_TOKEN: "idle-token", PI_SIMPLE_TEAM_TEAM: "idle-team", PI_SIMPLE_TEAM_TEAM_NAME: "idle-team", PI_SIMPLE_TEAM_MEMBER: "probe", PI_SIMPLE_TEAM_PARTICIPANTS: '["probe"]', PI_SIMPLE_TEAM_CAN_MANAGE_OWN_TEAMS: "0" },
		});
		let stderr = "";
		let stdout = "";
		const responses: JsonRecord[] = [];
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			while (stdout.includes("\n")) {
				const newline = stdout.indexOf("\n");
				responses.push(JSON.parse(stdout.slice(0, newline)) as JsonRecord);
				stdout = stdout.slice(newline + 1);
			}
		});
		const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
			for (let attempt = 0; attempt < 500 && !predicate(); attempt += 1) await Bun.sleep(10);
			assert.ok(predicate(), `Expected ${label}. Child stderr: ${stderr}`);
		};
		const deliver = async (message: string, triggerTurn: boolean): Promise<void> => {
			const response = await fetch(deliveryUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "idle-token", tool: "deliver", args: { team: "idle-team", from: "main", to: "probe", sentAt: new Date().toISOString(), message, formattedMessage: message, interrupt: false, triggerTurn } }) });
			assert.equal(response.status, 200, `Expected delivery to succeed: ${await response.text()}`);
		};
		try {
			await waitFor(() => deliveryUrl !== "", "child registration");
			await deliver(instructions, false);
			child.stdin.write(JSON.stringify({ id: "after-staging", type: "get_messages" }) + "\n");
			await waitFor(() => responses.some((response) => response.id === "after-staging"), "a real Pi conversation snapshot after staging");
			const snapshot = responses.find((response) => response.id === "after-staging");
			assert.equal(snapshot?.success, true, `Expected get_messages to succeed. Got: ${JSON.stringify(snapshot)}`);
			assert.equal(requests.length, 0, "Recording resumption instructions must not send a model request.");
			const stagedMessages = (snapshot?.data as { messages?: Array<{ content: unknown }> } | undefined)?.messages;
			assert.ok(Array.isArray(stagedMessages), `Expected conversation messages. Got: ${JSON.stringify(snapshot?.data)}`);
			assert.equal(stagedMessages.filter((message) => JSON.stringify(message.content).includes(instructions)).length, 1, "The recorded instructions must occur once in conversation content.");
			await deliver("Continue the work now.", true);
			await waitFor(() => settled, "the explicitly started turn to settle");
			assert.equal(requests.length, 1, "Only the explicit start should issue a model request.");
			const messages = requests[0].messages;
			assert.equal(messages.filter((message) => message.role !== "system" && JSON.stringify(message.content).includes(instructions)).length, 1, "The model must see the previously staged instructions exactly once.");
			const systemMessages = messages.filter((message) => message.role === "system");
			assert.ok(JSON.stringify(systemMessages).includes(commonPrompt), "The original common system prompt must remain present.");
			assert.ok(!JSON.stringify(systemMessages).includes(instructions), "Resumption instructions must not replace or become system instructions.");
		} finally {
			const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			child.kill("SIGTERM");
			await exited;
			callback.stop(true);
			provider.stop(true);
			fs.rmSync(directory, { recursive: true, force: true });
		}
	}, 30000);
});

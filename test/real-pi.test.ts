import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { describe, test } from "bun:test";

import { composeSystemPrompt } from "../system-prompt.ts";

/**
 * Gated end-to-end check against the real `pi` binary. It proves the two facts the
 * fake-based suite cannot: a child in `--mode rpc` registers its delivery runtime on
 * session_start, and an extension `sendMessage` (deliverAs steer + triggerTurn) starts
 * a real turn there. Run with: PI_SIMPLE_TEAM_TEST_REAL_PI=1 bun test test/real-pi.test.ts
 * Requires a configured default model; the delivered prompt costs one tiny turn.
 */
const realPiEnabled = process.env.PI_SIMPLE_TEAM_TEST_REAL_PI === "1";

type JsonRecord = Record<string, unknown>;

interface CallbackRecord {
	tool: string;
	args: JsonRecord;
}

async function waitFor(predicate: () => boolean, timeoutMilliseconds: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMilliseconds;
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(predicate(), `Timed out waiting for ${label}`);
}

describe.skipIf(!realPiEnabled)("real pi child runtime", () => {
	test("an RPC-mode child registers and a delivered message triggers a turn", async () => {
		const records: CallbackRecord[] = [];
		const token = "real-pi-probe-token";
		const server = http.createServer((request, response) => {
			void (async () => {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRecord;
				const record: CallbackRecord = { tool: String(body.tool), args: (body.args ?? {}) as JsonRecord };
				records.push(record);
				const payload =
					record.tool === "team_context"
						? { team: "probe-team", from: "probe", participants: ["probe"], status: {} }
						: record.tool === "teamstatus"
							? { team: "probe-team", status: {} }
							: { accepted: true, team: "probe-team", from: "probe" };
				const responseBody = JSON.stringify(payload);
				response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(responseBody) });
				response.end(responseBody);
			})();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address !== "string");

		const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-real-pi-"));
		const extensionPath = path.join(import.meta.dir, "..", "index.ts");
		const systemPrompt = composeSystemPrompt("probe-team", "You are part of a connectivity probe.", "probe", "Wait for instructions.", ["probe"], false);
		const child = childProcess.spawn(
			"pi",
			["--mode", "rpc", "--no-extensions", "-e", extensionPath, "--no-prompt-templates", "--no-themes", "--system-prompt", systemPrompt],
			{
				cwd: projectDirectory,
				stdio: ["pipe", "ignore", "pipe"],
				env: {
					...process.env,
					PI_SIMPLE_TEAM_CHILD: "1",
					PI_SIMPLE_TEAM_CALLBACK_URL: `http://127.0.0.1:${address.port}/callback`,
					PI_SIMPLE_TEAM_CALLBACK_TOKEN: token,
					PI_SIMPLE_TEAM_TEAM: "probe-team",
					PI_SIMPLE_TEAM_TEAM_NAME: "probe-team",
					PI_SIMPLE_TEAM_MEMBER: "probe",
					PI_SIMPLE_TEAM_PARTICIPANTS: JSON.stringify(["probe"]),
					PI_SIMPLE_TEAM_CAN_OVERSEE_OWN_TEAMS: "0",
				},
			},
		);
		let childStderr = "";
		child.stderr?.on("data", (chunk: Buffer | string) => {
			childStderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		});

		try {
			await waitFor(() => records.some((record) => record.tool === "register"), 30_000, `registration. stderr: ${childStderr}`);
			const registration = records.find((record) => record.tool === "register")!;
			assert.equal(typeof registration.args.sessionId, "string", `Expected registration to carry a session ID. Got: ${JSON.stringify(registration.args)}`);
			assert.ok(path.isAbsolute(String(registration.args.sessionFile)), `Expected an absolute session file. Got: ${JSON.stringify(registration.args)}`);

			const message = "Reply with the single word ok. Do not call any tools.";
			const delivery = await fetch(String(registration.args.url), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					token,
					tool: "deliver",
					args: { team: "probe-team", from: "main", to: "probe", sentAt: "now", message, formattedMessage: message, interrupt: false },
				}),
			});
			assert.equal(delivery.status, 200, `Expected the child to accept the delivery. Got: ${delivery.status} ${await delivery.text()}`);

			await waitFor(
				() => records.some((record) => record.tool === "event" && (record.args.event as JsonRecord | undefined)?.type === "agent_start"),
				60_000,
				`a turn to start after delivery. stderr: ${childStderr}`,
			);
			await waitFor(
				() => records.some((record) => record.tool === "event" && (record.args.event as JsonRecord | undefined)?.type === "agent_end"),
				120_000,
				`the turn to end. stderr: ${childStderr}`,
			);
		} finally {
			child.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				child.once("exit", () => resolve());
				setTimeout(() => {
					child.kill("SIGKILL");
					resolve();
				}, 10_000).unref();
			});
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			fs.rmSync(projectDirectory, { recursive: true, force: true });
		}
	}, 240_000);
});

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { childToolNames } from "../child-tools.ts";
import teamExtension from "../index.ts";
import { loadAsBunStandalonePi } from "./pi-launch.ts";
import { teamLogLines } from "../render.ts";
import type { TeamLogEntry } from "../teamlog.ts";

type JsonRecord = Record<string, unknown>;
type ToolResult = { content: Array<{ type: string; text: string }>; details: JsonRecord };
type RegisteredTool = { name: string; execute: (id: string, params: JsonRecord, signal: AbortSignal, update: undefined, context: unknown) => Promise<ToolResult> };
type Scenario = "retry" | "cancel" | "cancel-start" | "complete" | "error" | "first-error" | "first-error-cancel" | "interrupt" | "queued" | "rate-limited" | "lifecycle" | "held";

const firstTurnProviderError = "Third-party apps now draw from your extra usage fixture";
const exitNoticeGraceMilliseconds = 2_000;
const rateLimitError = { type: "error", error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit. Please try again later." } };

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		if (await check()) return;
		await Bun.sleep(10);
	}
	assert.fail(`Timed out waiting for ${label}`);
}

async function startTeam(scenario: Scenario, startIdle = false, options: { automaticStart?: boolean; parentSessionFile?: string; commonPrompt?: string; teammatePrompt?: string; teammate?: JsonRecord } = {}) {
	assert.deepEqual(Object.keys(process.env).filter((name) => name.startsWith("PI_SIMPLE_TEAM_") && name !== "PI_SIMPLE_TEAM_TEST_REAL_PI"), [], "Run settlement tests without live team routing or credentials.");
	const executable = Bun.which("pi");
	assert.ok(executable, "The real-Pi check requires Pi 1.1.0 or newer on PATH.");
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-settlement-"));
	const agentDirectory = path.join(directory, "agent");
	fs.mkdirSync(agentDirectory);
	let requestCount = 0;
	const modelRequests: Array<{ messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function?: { name?: string } }>; reasoning_effort?: string }> = [];
	let releaseRetry: () => void = () => undefined;
	const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
	const provider = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request: Request): Promise<Response> {
			modelRequests.push(await request.json() as (typeof modelRequests)[number]);
			requestCount += 1;
			if (scenario === "error") return Response.json({ error: { message: "Invalid API key fixture" } }, { status: 401 });
			if ((scenario === "first-error" || scenario === "first-error-cancel") && requestCount === 1) return Response.json({ error: { message: firstTurnProviderError } }, { status: 400 });
			if (scenario === "rate-limited") return Response.json(rateLimitError, { status: 429 });
			if (scenario === "retry" && requestCount === 1) return Response.json({ error: { message: "overloaded fixture" } }, { status: 503 });
			if (scenario === "retry" || ((scenario === "interrupt" || scenario === "queued" || scenario === "held") && requestCount === 1)) await retryGate;
			const chunk = (delta: JsonRecord, finishReason: string | null): string => `data: ${JSON.stringify({ id: "settlement-probe", object: "chat.completion.chunk", created: 1, model: "probe", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
			return new Response(chunk({ role: "assistant", content: "Successful response." }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		},
	});
	fs.writeFileSync(path.join(agentDirectory, "models.json"), JSON.stringify({ providers: { "local-settlement": {
		baseUrl: `http://127.0.0.1:${provider.port}/v1`, api: "openai-completions", apiKey: "local-fixture",
		models: [
			{ id: "probe", name: "Settlement probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 },
			{ id: "thinker", name: "Settlement thinker", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 },
		],
	} } }));
	fs.writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({ defaultThinkingLevel: "high", compaction: { enabled: false }, retry: { enabled: scenario === "retry" || scenario === "rate-limited", maxRetries: scenario === "rate-limited" ? 3 : 1, baseDelayMs: 10, provider: { maxRetries: 0 } } }));
	const cancellationExtension = path.join(directory, "cancel-after-response.ts");
	fs.writeFileSync(cancellationExtension, 'export default function (pi) { pi.on("agent_before_settle", (_event, context) => { context.abort(); }); }\n');
	const cancelNextRunMarker = path.join(directory, "cancel-next-run");
	const cancelBeforeRequestExtension = path.join(directory, "cancel-before-request.ts");
	fs.writeFileSync(cancelBeforeRequestExtension, `import * as fs from "node:fs";\nexport default function (pi) { pi.on("agent_start", (_event, context) => { if (fs.existsSync(${JSON.stringify(cancelNextRunMarker)})) { fs.rmSync(${JSON.stringify(cancelNextRunMarker)}); context.abort(); } }); }\n`);
	const childPidFile = path.join(directory, "child.pid");
	const quitAfterNextRunMarker = path.join(directory, "quit-after-next-run");
	const lifecycleExtension = path.join(directory, "lifecycle-probe.ts");
	fs.writeFileSync(lifecycleExtension, `import * as fs from "node:fs";\nexport default function (pi) {\n\tpi.on("session_start", () => { fs.writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid)); });\n\tpi.on("agent_settled", (_event, context) => { if (fs.existsSync(${JSON.stringify(quitAfterNextRunMarker)})) context.shutdown(); });\n}\n`);
	const scenarioExtensions: Partial<Record<Scenario, string[]>> = { cancel: [cancellationExtension], "cancel-start": [cancelBeforeRequestExtension], "first-error-cancel": [cancelBeforeRequestExtension], lifecycle: [lifecycleExtension], held: [lifecycleExtension] };
	const launcher = path.join(directory, "pi-launcher");
	const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
	fs.writeFileSync(launcher, `#!/bin/sh\nexec ${quote(executable)} --no-skills --no-context-files --no-prompt-templates --no-themes "$@"\n`, { mode: 0o755 });
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	const previousOffline = process.env.PI_OFFLINE;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	process.env.PI_OFFLINE = "1";
	const tools = new Map<string, RegisteredTool>();
	const shutdownHandlers: Array<() => Promise<void>> = [];
	const mainMessages: JsonRecord[] = [];
	const context = {
		cwd: directory, scopedModels: [], modelRegistry: { getAvailable: () => [{ provider: "local-settlement", id: "probe" }, { provider: "local-settlement", id: "thinker" }], find: () => undefined },
		sessionManager: { getCwd: () => directory, getSessionId: () => `settlement-${scenario}`, getSessionFile: () => options.parentSessionFile ?? path.join(directory, "main.jsonl") },
	};
	const api = {
		on: (event: string, handler: (event: JsonRecord, context: unknown) => Promise<void>) => {
			if (event === "session_start") void handler({ reason: "startup" }, context);
			if (event === "session_shutdown") shutdownHandlers.push(() => handler({ reason: "quit" }, context));
		},
		registerCommand: () => undefined, registerMessageRenderer: () => undefined,
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		sendMessage: (message: JsonRecord) => { mainMessages.push(message); },
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
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
		fs.rmSync(directory, { recursive: true, force: true });
	};
	try {
		loadAsBunStandalonePi(launcher, () => teamExtension(api));
		const spawned = await execute("team_spawn", { teamName: "settlement", startIdle: !options.automaticStart, commonPrompt: options.commonPrompt ?? "Respond once.", teammates: [{ name: "probe", model: "local-settlement/probe", thinking: "low", systemPrompt: options.teammatePrompt ?? "Wait for a message.", forkContext: options.parentSessionFile !== undefined, extensionPaths: scenarioExtensions[scenario] ?? [], ...options.teammate }] });
		if (!startIdle && !options.automaticStart) await execute("team_send_message", { targets: ["probe"], message: "Do the small task." });
		return {
			close, releaseRetry, modelRequests, requests: () => requestCount,
			stop: async (): Promise<ToolResult> => execute("team_shutdown", { team: "settlement" }),
			add: async (startIdle: boolean): Promise<ToolResult> => execute("team_add_teammates", { team: "settlement", startIdle, teammates: [{ name: "addition", model: "local-settlement/probe", thinking: "low", systemPrompt: "ADDITION_SPECIFIC" }] }),
			resume: async (startIdle: boolean, resumptionPrompt?: string): Promise<ToolResult> => execute("team_resume", { team: "settlement", startIdle, ...(resumptionPrompt === undefined ? {} : { resumptionPrompt }) }),
			sessionFile: String((spawned.details.teammates as JsonRecord[])[0].sessionFile),
			savedTeammate: (): JsonRecord => {
				const manifests = path.join(agentDirectory, "pi-simple-team", "teams-v2");
				const [manifest] = fs.readdirSync(manifests).filter((name) => name.endsWith(".json"));
				return (JSON.parse(fs.readFileSync(path.join(manifests, manifest), "utf8")).members as JsonRecord[])[0];
			},
			log: async (): Promise<ToolResult> => execute("team_log", { targets: ["settlement"], limit: 100 }),
			cancelNextRun: (): void => fs.writeFileSync(cancelNextRunMarker, ""),
			quitAfterNextRun: (): void => fs.writeFileSync(quitAfterNextRunMarker, ""),
			childPid: (): number => Number(fs.readFileSync(childPidFile, "utf8")),
			notices: (): string[] => mainMessages.map((message) => String(message.content)),
			status: async (): Promise<JsonRecord> => ((await execute("team_status", { team: "settlement" })).details.status as Record<string, JsonRecord>).probe,
			send: async (interrupt: boolean, recipient = "probe"): Promise<ToolResult> => execute("team_send_message", { targets: [recipient], message: "Continue with this message.", interrupt }),
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
	test.each([false, true])("newly added teammate stages=%s receives its own tagged assignment in its first request", async (startIdle) => {
		const child = await startTeam("complete", false, { commonPrompt: "ADDITION_COMMON" });
		try {
			await waitFor(async () => child.requests() === 1 && !(await child.active()), "the existing teammate to settle");
			await child.add(startIdle);
			if (startIdle) {
				assert.equal(child.requests(), 1, "An idle addition must stage its briefing without starting work.");
				await child.send(false, "addition");
			}
			await waitFor(async () => child.requests() === 2 && ((await child.log()).details.entries as TeamLogEntry[]).some((entry) => entry.teammate === "addition" && entry.kind === "agent_settled"), "the added teammate's first request to settle");
			const input = JSON.stringify(child.modelRequests[1].messages);
			assert.match(input, /<team-system-message>\\nADDITION_COMMON\\n<\/team-system-message>/, "An added teammate needs the existing common instructions immediately.");
			assert.match(input, /<your-specific-system-message>\\nADDITION_SPECIFIC\\n<\/your-specific-system-message>/, "An added teammate needs its own instructions immediately.");
			assert.equal(input.match(/ADDITION_SPECIFIC/g)?.length, 1, "The added assignment must occur once.");
		} finally {
			await child.close();
		}
	}, 30000);

	test("a fork receives its current tagged instructions while keeping inherited system history unchanged", async () => {
		const parent = await startTeam("complete", false, { commonPrompt: "PARENT_COMMON", teammatePrompt: "PARENT_SPECIFIC" });
		let fork: Awaited<ReturnType<typeof startTeam>> | undefined;
		try {
			await waitFor(async () => parent.requests() === 1 && !(await parent.active()), "the parent history to materialize");
			await parent.stop();
			const entries = fs.readFileSync(parent.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as JsonRecord);
			fs.appendFileSync(parent.sessionFile, JSON.stringify({ type: "message", id: "parent-system", parentId: entries.at(-1)!.id, timestamp: new Date().toISOString(), message: { role: "system", content: "OLD_PARENT_SYSTEM", timestamp: Date.now() } }) + "\n");
			const preserved = fs.readFileSync(parent.sessionFile, "utf8");
			fork = await startTeam("complete", false, { automaticStart: true, parentSessionFile: parent.sessionFile, commonPrompt: "FORK_COMMON", teammatePrompt: "FORK_SPECIFIC" });
			await waitFor(async () => fork!.requests() === 1 && !(await fork!.active()), "the fork's first request");
			const messages = fork.modelRequests[0].messages;
			const current = messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content)).join("\n");
			assert.match(current, /<team-system-message>\\nFORK_COMMON\\n<\/team-system-message>/, "The first forked request needs its current common briefing, not only inherited instructions.");
			assert.match(current, /<your-specific-system-message>\\nFORK_SPECIFIC\\n<\/your-specific-system-message>/, "The fork receives its current individual assignment.");
			assert.equal(current.match(/FORK_SPECIFIC/g)?.length, 1, "The current assignment is not duplicated.");
			assert.ok(JSON.stringify(messages.filter((message) => message.role === "system")).includes("OLD_PARENT_SYSTEM"), "The mitigation must not rewrite inherited system messages.");
			assert.equal(fs.readFileSync(parent.sessionFile, "utf8"), preserved, "The source transcript must remain byte-for-byte unchanged.");
		} finally {
			await fork?.close();
			await parent.close();
		}
	}, 30000);

	test("a fork of a transcript that never declared teammate tools still offers every team tool in its first request", async () => {
		const parent = await startTeam("complete", false);
		let fork: Awaited<ReturnType<typeof startTeam>> | undefined;
		try {
			await waitFor(async () => parent.requests() === 1 && !(await parent.active()), "the parent history to materialize");
			await parent.stop();
			const entries = fs.readFileSync(parent.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as JsonRecord);
			// Main's own tool loadout never declares send_main_message. Pi 1.3 restores a forked transcript's loadout.
			fs.appendFileSync(parent.sessionFile, JSON.stringify({ type: "message", id: "main-loadout", parentId: entries.at(-1)!.id, timestamp: new Date().toISOString(), message: { role: "system", content: "", toolsRemoved: [{ name: "send_main_message" }], timestamp: Date.now() } }) + "\n");
			fork = await startTeam("complete", false, { automaticStart: true, parentSessionFile: parent.sessionFile });
			await waitFor(async () => fork!.requests() === 1 && !(await fork!.active()), "the fork's first request");
			const declaredTools = (fork.modelRequests[0].tools ?? []).map((tool) => tool.function?.name);
			for (const toolName of childToolNames) assert.ok(declaredTools.includes(toolName), `A forked teammate must be able to call ${toolName}. Declared tools: ${JSON.stringify(declaredTools)}`);
		} finally {
			await fork?.close();
			await parent.close();
		}
	}, 30000);

	test.each([false, true])("fresh startup stages=%s delivers common and individual instructions in its first custom-message request", async (startIdle) => {
		const child = await startTeam("complete", startIdle, { automaticStart: !startIdle, commonPrompt: "STARTUP_COMMON", teammatePrompt: "STARTUP_SPECIFIC" });
		try {
			if (startIdle) {
				assert.equal(child.requests(), 0, "Initial idle briefing must not start a model request.");
				await child.send(false);
			}
			await waitFor(async () => child.requests() === 1 && !(await child.active()), "the first startup response");
			const messages = child.modelRequests[0].messages;
			const customInput = messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content)).join("\n");
			assert.match(customInput, /<team-system-message>\\nSTARTUP_COMMON\\n<\/team-system-message>/, "The first provider request must receive the common instructions in the tagged custom briefing.");
			assert.match(customInput, /<your-specific-system-message>\\nSTARTUP_SPECIFIC\\n<\/your-specific-system-message>/, "The first provider request must receive the individual instructions in its own tag.");
			assert.equal(customInput.match(/STARTUP_SPECIFIC/g)?.length, 1, "Do not repeat the per-teammate assignment in the kickoff.");
			assert.match(customInput, /team_send_message.*send_main_message/, "The custom briefing must retain coordination guidance.");
			const transcript = fs.readFileSync(child.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as JsonRecord);
			const briefing = transcript.find((entry) => entry.type === "custom_message" && String(entry.content).includes("STARTUP_COMMON"));
			assert.equal(briefing?.customType, "pi-simple-team", "Initial briefing keeps the custom team renderer.");
			assert.equal(briefing?.display, true, "Initial briefing remains visible.");
			assert.equal((briefing?.details as JsonRecord)?.from, "main", "Initial briefing keeps sender attribution.");
		} finally {
			await child.close();
		}
	}, 30000);

	test("resume without prior model activity stages a truthful briefing even without new instructions", async () => {
		const child = await startTeam("complete", true);
		try {
			await child.stop();
			const resumed = await child.resume(true);
			assert.equal(child.requests(), 0, "An idle resume without new instructions must not start the model.");
			await child.send(false);
			await waitFor(async () => child.requests() === 1 && !(await child.active()), "the first explicitly started model response");
			const sessionFile = String((resumed.details.teammates as JsonRecord[])[0].sessionFile);
			const entries = fs.readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as JsonRecord);
			const briefings = entries.filter((entry) => entry.type === "custom_message" && String(entry.content).includes("This session has resumed."));
			assert.equal(briefings.length, 1, "A restarted session needs exactly one resume briefing, even without resumptionPrompt.");
			assert.match(String(briefings[0].content), /No prior model activity is recorded/, "A never-used session must not invent a last-activity timestamp.");
			assert.doesNotMatch(String(briefings[0].content), /Your last recorded model activity was/, "Do not invent previous model activity.");
			assert.match(String(briefings[0].content), /<team-system-message>\nRespond once\.\n<\/team-system-message>/, "A never-materialized session must be initialized again after its staged briefing was lost.");
			assert.equal(String(briefings[0].content).match(/<your-specific-system-message>/g)?.length, 1, "Restart-empty initialization uses one tagged individual briefing, not a duplicate.");
			assert.equal(child.modelRequests[0].messages.filter((message) => JSON.stringify(message.content).includes("This session has resumed.")).length, 1, "The first request must receive the staged briefing once.");
		} finally {
			await child.close();
		}
	}, 30000);

	test("default resume starts once with the custom briefing and retains previous conversation", async () => {
		const child = await startTeam("complete");
		try {
			await waitFor(async () => child.requests() === 1 && !(await child.active()), "initial model activity");
			await child.stop();
			const previousTranscript = fs.readFileSync(child.sessionFile, "utf8");
			const resumed = await child.resume(false);
			await waitFor(async () => child.requests() === 2 && !(await child.active()), "automatic resumption to settle");
			assert.ok(fs.readFileSync(child.sessionFile, "utf8").startsWith(previousTranscript), "Automatic resumption must append without rewriting saved history.");
			assert.equal((resumed.details.teammates as JsonRecord[])[0].systemPrompt, "Wait for a message.", "The saved individual definition must remain unchanged.");
			const messages = child.modelRequests[1].messages;
			const briefing = messages.filter((message) => JSON.stringify(message.content).includes("This session has resumed."));
			assert.equal(briefing.length, 1, "Default resume must send exactly one current briefing to the model.");
			assert.match(JSON.stringify(briefing[0].content), /Your last recorded model activity was/, "A used session must include its recorded activity time.");
			assert.doesNotMatch(JSON.stringify(briefing[0].content), /Wait for a message\./, "Default resume must not repeat the saved per-teammate assignment.");
			assert.ok(messages.some((message) => JSON.stringify(message.content).includes("Do the small task.")), "Earlier conversation must remain available as background.");
			assert.equal(messages.filter((message) => JSON.stringify(message.content).includes("<team-system-message>")).length, 1, "A real restored session inherits its original briefing instead of repeating definitions.");
			assert.ok(messages.some((message) => JSON.stringify(message.content).includes("Respond once.") && JSON.stringify(message.content).includes("Wait for a message.")), "Both saved definitions must still reach the resumed model.");
		} finally {
			await child.close();
		}
	}, 30000);

	test.each([
		{ fork: true, model: "local-settlement/thinker", thinking: "xhigh", runsAt: "xhigh" },
		{ fork: false, model: "local-settlement/thinker", thinking: "xhigh", runsAt: "xhigh" },
		{ fork: true, model: "local-settlement/thinker", thinking: "default", runsAt: "xhigh" },
		{ fork: false, model: "local-settlement/probe", thinking: "xhigh", runsAt: "off" },
	])("resume keeps the thinking level a teammate runs at: fork=$fork model=$model thinking=$thinking", async ({ fork, model, thinking, runsAt }) => {
		const effort = (request: { reasoning_effort?: string }): string => request.reasoning_effort ?? "off";
		// As in issue 26, main's own history records high.
		const parent = fork ? await startTeam("complete", false, { teammate: { model: "local-settlement/thinker", thinking: "high" } }) : undefined;
		let child: Awaited<ReturnType<typeof startTeam>> | undefined;
		try {
			if (parent) {
				await waitFor(async () => parent.requests() === 1 && !(await parent.active()), "main's history at high thinking");
				assert.equal(effort(parent.modelRequests[0]), "high", "The fixture's main history must run at high.");
				await parent.stop();
			}
			const team = await startTeam("complete", false, { automaticStart: true, parentSessionFile: parent?.sessionFile, teammate: { model, thinking: thinking === "default" ? undefined : thinking } });
			child = team;
			await waitFor(async () => team.requests() === 1 && !(await team.active()), "the first turn");
			assert.equal(effort(team.modelRequests[0]), runsAt, "The fixture's teammate must start at its configured level.");
			await team.stop();
			const resumed = await team.resume(false);
			await waitFor(async () => team.requests() === 2 && !(await team.active()), "the resumed turn");
			await team.stop();
			assert.deepEqual(
				{ runsAt: effort(team.modelRequests[1]), reported: (resumed.details.teammates as JsonRecord[])[0].thinking, saved: team.savedTeammate().thinking },
				{ runsAt, reported: runsAt, saved: runsAt },
				"A resumed teammate must run at, report, and save the thinking level it was configured with.",
			);
		} finally {
			await child?.close();
			await parent?.close();
		}
	}, 30000);

	test("resume leaves an already-active teammate's model work and conversation unchanged", async () => {
		const child = await startTeam("queued");
		try {
			await waitFor(async () => child.requests() === 1 && await child.active(), "held active model work");
			const resumed = await child.resume(false, "UNEXPECTED_RESUMPTION");
			assert.equal((resumed.details.alreadyActiveTeammates as JsonRecord[])[0]?.name, "probe", "No-op resume must report the already-active teammate.");
			assert.equal(await child.active(), true, "No-op resume must not cancel or restart the active run.");
			child.releaseRetry();
			await waitFor(async () => !(await child.active()), "unchanged active work to finish");
			assert.equal(child.requests(), 1, "No-op resume must not queue another model request.");
			assert.doesNotMatch(fs.readFileSync(child.sessionFile, "utf8"), /UNEXPECTED_RESUMPTION|This session has resumed/, "An already-active member must receive no resume briefing.");
		} finally {
			await child.close();
		}
	}, 30000);

	test("idle resume appends one dated custom briefing without rewriting history or starting work", async () => {
		const child = await startTeam("complete");
		try {
			await waitFor(async () => child.requests() === 1 && !(await child.active()), "initial recorded model activity");
			await child.stop();
			const history = fs.readFileSync(child.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as JsonRecord);
			const lastResponse = history.findLast((entry) => entry.type === "message" && (entry.message as JsonRecord).role === "assistant");
			assert.ok(lastResponse, "The fixture needs an actual model response before metadata and staging.");
			lastResponse.timestamp = "2026-02-03T14:05:06.000Z";
			const tail = String(history.at(-1)!.id);
			history.push({ type: "session_info", id: "later-info", parentId: tail, timestamp: "2099-01-01T00:00:00.000Z", name: "Recent metadata, not model work" });
			history.push({ type: "custom_message", id: "later-staging", parentId: "later-info", timestamp: "2099-01-02T00:00:00.000Z", customType: "staged", content: "Unconsumed staged context", display: false });
			history.push({ type: "message", id: "later-input", parentId: "later-staging", timestamp: "2099-01-03T00:00:00.000Z", message: { role: "user", content: "Submitted input without a recorded response", timestamp: Date.parse("2099-01-03T00:00:00.000Z") } });
			const previousTranscript = history.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
			fs.writeFileSync(child.sessionFile, previousTranscript);
			const resumptionPrompt = "Review only the current assignment.";
			const resumed = await child.resume(true, resumptionPrompt);
			assert.equal((resumed.details.teammates as JsonRecord[])[0].systemPrompt, "Wait for a message.", "Resumption instructions must not rewrite the saved individual definition.");
			assert.equal(child.requests(), 1, "An idle resume briefing must not issue a model request.");
			assert.equal(await child.active(), false, "Recording the resume briefing must leave the teammate idle.");
			const stagedTranscript = fs.readFileSync(child.sessionFile, "utf8");
			assert.ok(stagedTranscript.startsWith(previousTranscript), "Resumption must preserve every prior transcript entry byte-for-byte.");
			const entries = stagedTranscript.trim().split("\n").map((line) => JSON.parse(line) as JsonRecord);
			const briefing = entries.at(-1)!;
			assert.equal(briefing.type, "custom_message", "The resume briefing must remain a custom message.");
			assert.equal(briefing.customType, "pi-simple-team", "The existing team renderer must receive the same custom type.");
			assert.equal(briefing.display, true, "The briefing must remain visible through the team renderer.");
			assert.equal((briefing.details as JsonRecord).from, "main", "Resume must preserve sender attribution.");
			const content = String(briefing.content);
			assert.match(content, /You are teammate "probe" on team "settlement"/, "Explicit instructions must not replace the restored teammate's identity.");
			assert.match(content, /Your last recorded model activity was .*03 Feb 2026.*(?:GMT|UTC)/, "Report the actual model activity in human-readable time with a timezone, not later metadata or staged context.");
			assert.match(content, /Current time: .*\d{2}:\d{2}:\d{2}.*(?:GMT|UTC)/, "Current time needs a readable date, clock, and explicit timezone.");
			assert.doesNotMatch(content, /2099|Wait for a message\./, "Do not reuse metadata timestamps or repeat the saved individual assignment.");
			assert.ok(content.includes(resumptionPrompt), "The briefing must include the new instructions.");
			const beforeNoop = stagedTranscript;
			await child.resume(true, "Do not send this to an already-live member.");
			assert.equal(fs.readFileSync(child.sessionFile, "utf8"), beforeNoop, "Resuming an already-live member must not append another briefing.");
			await child.send(false);
			await waitFor(async () => child.requests() === 2 && !(await child.active()), "work after the staged briefing");
			const received = child.modelRequests[1].messages;
			assert.equal(received.filter((message) => JSON.stringify(message.content).includes(resumptionPrompt)).length, 1, "The model must receive the appended briefing exactly once.");
			assert.ok(received.some((message) => JSON.stringify(message.content).includes("Do the small task.")), "The resumed model must still receive previous conversation context.");
		} finally {
			await child.close();
		}
	}, 30000);

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

	test("a failed turn reports the provider's error through the teammate status and log, and a later successful turn clears it", async () => {
		const child = await startTeam("first-error");
		try {
			await waitFor(async () => child.requests() === 1 && !(await child.active()), "the failed first turn to settle");
			const transcript = fs.readFileSync(child.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { message?: { role: string; stopReason?: string } });
			assert.equal(transcript.filter((entry) => entry.message?.role === "assistant").at(-1)?.message?.stopReason, "error", "The fixture must produce an actual provider failure on the first turn.");
			const failed = await child.status();
			assert.equal(failed.word, "error", `A teammate whose turn failed must not look idle. Status: ${JSON.stringify(failed)}`);
			assert.match(String(failed.phrase), new RegExp(firstTurnProviderError), "The status phrase must carry the provider's message.");
			const failedLog = await child.log();
			const errorRows = (failedLog.details.entries as TeamLogEntry[]).filter((entry) => entry.kind === "error");
			assert.equal(errorRows.length, 1, `The log must record the failed turn once as an error. Rows: ${failedLog.content[0].text}`);
			assert.match(errorRows[0].summary, new RegExp(firstTurnProviderError), "The error row must carry the provider's message.");
			assert.match(failedLog.content[0].text, new RegExp(firstTurnProviderError), "Main must see the provider's message in team_log.");
			assert.equal(child.notices().length, 1, "A failed run must wake main once.");
			assert.match(child.notices()[0], new RegExp(`ended its latest run on an error\\.\\nCause: .*${firstTurnProviderError}`), "The notice must carry the provider's message.");
			await child.send(false);
			await waitFor(async () => child.requests() === 2 && !(await child.active()), "the successful second turn to settle");
			assert.equal((await child.status()).word, "idle", "A later successful turn must clear the runtime error status.");
			assert.equal(((await child.log()).details.entries as TeamLogEntry[]).filter((entry) => entry.kind === "error").length, 1, "A successful turn must not add error rows.");
			assert.equal(child.notices().length, 1, "A recovery must not notify main again.");
		} finally {
			await child.close();
		}
	}, 30000);

	test("a run cancelled before its first provider request stays idle without an error status or row", async () => {
		const child = await startTeam("cancel-start", true);
		try {
			child.cancelNextRun();
			await child.send(false);
			await waitFor(async () => ((await child.log()).details.entries as TeamLogEntry[]).some((entry) => entry.kind === "agent_settled"), "the cancelled run to settle");
			assert.equal(child.requests(), 0, "The fixture must cancel before any provider request.");
			const entries = (await child.log()).details.entries as TeamLogEntry[];
			assert.deepEqual(entries.filter((entry) => entry.kind === "agent_settled").map((entry) => entry.details), [{ aborted: true }], "The control must be a cancelled settlement.");
			const cancelled = await child.status();
			assert.deepEqual({ word: cancelled.word, phrase: cancelled.phrase }, { word: "idle", phrase: "Spawned" }, "A cancelled run is not a failed run.");
			assert.deepEqual(entries.filter((entry) => entry.kind === "error"), [], "A cancelled run must not log a run failure.");
			assert.deepEqual(child.notices(), [], "A cancelled run must not notify main.");
		} finally {
			await child.close();
		}
	}, 30000);

	test("cancelling a run after a provider failure keeps the failure's status and message", async () => {
		const child = await startTeam("first-error-cancel");
		try {
			await waitFor(async () => child.requests() === 1 && !(await child.active()), "the failed first turn to settle");
			const failed = await child.status();
			assert.equal(failed.word, "error", "The fixture's first turn must fail.");
			child.cancelNextRun();
			await child.send(false);
			await waitFor(async () => ((await child.log()).details.entries as TeamLogEntry[]).filter((entry) => entry.kind === "agent_settled").length === 2, "the cancelled run to settle");
			assert.equal(child.requests(), 1, "The cancelled run must make no provider request.");
			assert.deepEqual(await child.status(), failed, "Cancellation must not replace the provider failure's status or message.");
			assert.equal(((await child.log()).details.entries as TeamLogEntry[]).filter((entry) => entry.kind === "error").length, 1, "Cancellation must not add an error row.");
		} finally {
			await child.close();
		}
	}, 30000);

	test("a run that exhausts Pi's retries on rate limits notifies main once", async () => {
		const child = await startTeam("rate-limited", false, { automaticStart: true });
		try {
			await waitFor(async () => child.requests() === 4 && !(await child.active()), "four rate-limited attempts to settle");
			assert.equal(child.notices().length, 1, `One failed run must give one notice. Notices: ${JSON.stringify(child.notices())}`);
			assert.match(child.notices()[0], /ended its latest run on an error\.\nCause: 429: .*rate_limit_error/, "The notice must carry the final 429 message.");
		} finally {
			await child.close();
		}
	}, 30000);

	test.each([["SIGTERM", 143], ["SIGHUP", 129]] as const)("an outside %s to a registered teammate notifies main once with code %d", async (signal, code) => {
		const child = await startTeam("lifecycle", false, { automaticStart: true });
		try {
			await waitFor(async () => child.requests() === 1 && !(await child.active()), "the first run to settle");
			process.kill(child.childPid(), signal);
			await waitFor(async () => ((await child.log()).details.entries as TeamLogEntry[]).some((entry) => entry.kind === "exit" && entry.summary.startsWith("exited")), "the child to exit");
			await Bun.sleep(exitNoticeGraceMilliseconds + 500);
			assert.deepEqual(child.notices().map((notice) => notice.split("\n")[1]), [`Cause: exited (code=${code}, signal=null)`], "An outside signal must wake main once with the exit code.");
		} finally {
			await child.close();
		}
	}, 30000);

	test("a SIGKILL during a run gives one exit notice and no failed-run notice", async () => {
		const child = await startTeam("held");
		try {
			await waitFor(async () => child.requests() === 1 && await child.active(), "the held provider request");
			process.kill(child.childPid(), "SIGKILL");
			await waitFor(async () => ((await child.log()).details.entries as TeamLogEntry[]).some((entry) => entry.kind === "exit"), "the child to exit");
			await Bun.sleep(exitNoticeGraceMilliseconds + 500);
			assert.deepEqual(child.notices().map((notice) => notice.split("\n")[1]), ["Cause: exited (code=null, signal=SIGKILL)"], "A killed run has no settlement, so only the exit notifies.");
		} finally {
			await child.close();
		}
	}, 30000);

	test("a teammate that quits itself sends no notice", async () => {
		const child = await startTeam("lifecycle", true);
		try {
			child.quitAfterNextRun();
			await child.send(false);
			await waitFor(async () => ((await child.log()).details.entries as TeamLogEntry[]).some((entry) => entry.kind === "exit" && entry.summary === "exited (code=0, signal=null)"), "the self-quit exit");
			await Bun.sleep(exitNoticeGraceMilliseconds + 500);
			assert.deepEqual(child.notices(), [], "A self-quit (code 0 after a quit shutdown) is excluded.");
		} finally {
			await child.close();
		}
	}, 30000);

	test("a SIGHUP to main's whole process group sends no notice when main's shutdown starts after the child exits (stand-in host)", async () => {
		const executable = Bun.which("pi");
		assert.ok(executable, "The real-Pi check requires Pi on PATH.");
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-group-signal-"));
		try {
			const host = Bun.spawn(["bun", path.join(import.meta.dir, "group-signal-host.ts"), directory, executable], { stdout: "pipe", stderr: "inherit", env: { ...process.env, PI_CODING_AGENT_DIR: path.join(directory, "agent") }, detached: true });
			const reader = host.stdout.getReader();
			let buffered = "";
			const events: JsonRecord[] = [];
			const nextEvent = async (): Promise<JsonRecord> => {
				while (!buffered.includes("\n")) {
					const { value, done } = await reader.read();
					if (done) throw new Error(`Host ended early. Output: ${buffered}`);
					buffered += new TextDecoder().decode(value);
				}
				const newline = buffered.indexOf("\n");
				const event = JSON.parse(buffered.slice(0, newline)) as JsonRecord;
				buffered = buffered.slice(newline + 1);
				events.push(event);
				return event;
			};
			assert.equal((await nextEvent()).phase, "ready", "The host must start its teammate first.");
			process.kill(-host.pid, "SIGHUP");
			const exited = await nextEvent();
			assert.equal(exited.phase, "child-exited", `The child must exit before the host's shutdown starts. Events: ${JSON.stringify(events)}`);
			assert.equal(exited.summary, "exited (code=129, signal=null)", "The group signal must reach the child.");
			const finished = await nextEvent();
			assert.deepEqual(finished.notices, [], "An exit caused by main's own group signal must not notify main.");
			await host.exited;
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	}, 30000);

	test.each(["interrupt", "queued"] as const)("a %s delivery preserves activity and waits for the correct settlement boundary", async (scenario) => {
		const child = await startTeam(scenario);
		try {
			await waitFor(async () => child.requests() === 1 && await child.active(), "the held active response");
			await child.send(scenario === "interrupt");
			if (scenario === "queued") {
				const expectedAcknowledgments = ((await child.log()).details.entries as TeamLogEntry[]).filter((entry) => entry.kind === "send").length;
				await waitFor(async () => ((await child.log()).details.entries as TeamLogEntry[]).filter((entry) => entry.kind === "ack").length === expectedAcknowledgments, "every published message to enter the busy child's queue");
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
			assert.equal(entries.filter((entry) => entry.kind === "error").length, 0, "A failed attempt that Pi retried successfully is not a failed run.");
			assert.notEqual((await child.status()).word, "error", "A recovered retry must not leave an error status.");
		} finally {
			await child.close();
		}
	}, 30000);
});

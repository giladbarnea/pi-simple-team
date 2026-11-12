import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import teamExtension from "../index.ts";
import { canonicalProjectDirectory, listTeamManifests, readTeamLeaseState, writeTeamManifest } from "../team-registry.ts";

const extensionPath = path.resolve(import.meta.dir, "..", "index.ts");

type MainSession = Awaited<ReturnType<typeof startMainSession>>;

/** A main Pi session with the extension, driven by a scripted local model. */
async function startMainSession(directory: string) {
	const faux = fauxProvider({ models: [{ id: "faux-target-recovery" }] });
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey(faux.provider.id, "local-test");
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		additionalExtensionPaths: [extensionPath],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		model: faux.getModel(),
		modelRuntime,
		resourceLoader,
		sessionManager: SessionManager.inMemory(directory),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
	});
	await session.bindExtensions({});
	return { session, faux };
}

async function withMainSession(run: (main: MainSession, directory: string) => Promise<void>): Promise<void> {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-target-recovery-"));
	const main = await startMainSession(directory);
	try {
		await run(main, directory);
	} finally {
		await main.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		main.session.dispose();
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

/** Store a dormant team for this project, as a stopped main session leaves it. */
function storeDormantTeam(directory: string, teamId: string, teamName: string, members: Array<[name: string, teammateId: string]>, originMainSessionId = "earlier-main-session"): void {
	const now = new Date().toISOString();
	writeTeamManifest({
		version: 2, id: teamId, name: teamName, originMainSessionId,
		projectDirectory: canonicalProjectDirectory(directory), teamPrompt: "Work.", showOnHerdrPanes: false,
		members: members.map(([name, teammateId]) => ({
			name, systemPrompt: "Work.", model: "fake/fake-model", thinking: "high", forkContext: false, canManageOwnTeams: false,
			showOnHerdrPane: false, live: false, active: false, teammateId, sessionFile: path.join(directory, `${teammateId}.jsonl`), sessionMaterialized: true,
		})),
		state: "dormant", createdAt: now, updatedAt: now, shutdownAt: now,
	});
}

/** The model's first request context, then the tool result the model receives after calling team_send_message. */
async function sendAsModel(main: MainSession, targets: string[]): Promise<{ firstRequest: Context; toolResult: { text: string; isError: boolean } }> {
	const requests: Context[] = [];
	const capture = (context: Context, reply: ReturnType<typeof fauxAssistantMessage>) => { requests.push(context); return reply; };
	main.faux.setResponses([
		(context) => capture(context, fauxAssistantMessage(fauxToolCall("team_send_message", { targets, message: "Follow-up question about your earlier work." }))),
		(context) => capture(context, fauxAssistantMessage("Done.")),
	]);
	await main.session.prompt("Ask the earlier expert a follow-up question.");
	assert.equal(requests.length, 2, `Expected the model to receive the tool result in a second request. Requests: ${requests.length}`);
	const result = requests[1].messages.findLast((message) => message.role === "toolResult");
	assert.ok(result && result.role === "toolResult", `Expected a tool result in the second request. Messages: ${JSON.stringify(requests[1].messages)}`);
	return { firstRequest: requests[0], toolResult: { text: result.content.map((block) => block.type === "text" ? block.text : "").join(""), isError: result.isError } };
}

/** The tools a request offers the model: request-level tools, or those its system messages add (Pi 1.4+). */
function offeredTools(context: Context): Array<{ name: string; description: string }> {
	return [...(context.tools ?? []), ...context.messages.flatMap((message) => message.role === "system" ? (message as { toolsAdded?: Array<{ name: string; description: string }> }).toolsAdded ?? [] : [])];
}

describe("team_spawn description", () => {
	test("tells the model it can spawn a regular background agent as a one-person team", async () => {
		await withMainSession(async (main) => {
			const { firstRequest } = await sendAsModel(main, ["anyone"]);
			const spawn = offeredTools(firstRequest).find((tool) => tool.name === "team_spawn");
			assert.ok(spawn, `Expected the model to receive team_spawn. Tools: ${offeredTools(firstRequest).map((tool) => tool.name)}`);
			assert.equal(
				spawn.description,
				"Spawn a versatile team of agents. It can also be used as a regular background agent spawn in a one-person team. You are automatically part of the team as main. Do not include yourself in teammates. Use `team_resume` to continue an existing team, or `team_add_teammates` to grow one.",
			);
		});
	});
});

describe("team_send_message unknown-target recovery", () => {
	test("names the dormant team and teammate ID and requires team_resume first", async () => {
		await withMainSession(async (main, directory) => {
			storeDormantTeam(directory, "team-optmem-1", "optmem-research", [["read-optmem-owner", "session-optmem-owner"], ["writer", "session-writer"]]);
			const { toolResult } = await sendAsModel(main, ["read-optmem-owner"]);
			assert.equal(toolResult.isError, true, "The send must still fail explicitly.");
			assert.equal(toolResult.text, [
				`Teammate "read-optmem-owner" belongs to a dormant team.`,
				"Team: team-optmem-1",
				"Teammate: session-optmem-owner",
				"Resume this teammate with team_resume, then retry team_send_message.",
			].join("\n"));
			const stored = listTeamManifests(directory).manifests.find((manifest) => manifest.id === "team-optmem-1");
			assert.equal(stored?.state, "dormant", "Reporting the error must not resume the team.");
			assert.equal(readTeamLeaseState("team-optmem-1").state, "unclaimed", "Reporting the error must not claim the team.");
		});
	});

	test("also finds a dormant teammate by its session ID", async () => {
		await withMainSession(async (main, directory) => {
			storeDormantTeam(directory, "team-optmem-1", "optmem-research", [["read-optmem-owner", "session-optmem-owner"]]);
			const { toolResult } = await sendAsModel(main, ["session-optmem-owner"]);
			assert.match(toolResult.text, /^Teammate "session-optmem-owner" belongs to a dormant team\.\nTeam: team-optmem-1\nTeammate: session-optmem-owner\n/);
		});
	});

	test("lists every dormant candidate and asks for disambiguation", async () => {
		await withMainSession(async (main, directory) => {
			storeDormantTeam(directory, "team-review-1", "review", [["reviewer", "session-reviewer-1"]]);
			storeDormantTeam(directory, "team-review-2", "review-again", [["reviewer", "session-reviewer-2"]]);
			const { toolResult } = await sendAsModel(main, ["reviewer"]);
			assert.equal(toolResult.isError, true, "The send must still fail explicitly.");
			const lines = toolResult.text.split("\n");
			assert.equal(lines[0], `Teammate "reviewer" matches more than one dormant teammate. Choose one:`);
			assert.deepEqual(lines.slice(1, -1).sort(), [
				"Team: team-review-1, Teammate: session-reviewer-1",
				"Team: team-review-2, Teammate: session-reviewer-2",
			]);
			assert.equal(lines.at(-1), "Resume the intended teammate with team_resume, then retry team_send_message.");
		});
	});

	test("directs the caller to team_list when no stored teammate matches", async () => {
		await withMainSession(async (main, directory) => {
			storeDormantTeam(directory, "team-optmem-1", "optmem-research", [["read-optmem-owner", "session-optmem-owner"]]);
			const { toolResult } = await sendAsModel(main, ["never-existed"]);
			assert.equal(toolResult.isError, true, "The send must still fail explicitly.");
			assert.equal(
				toolResult.text,
				`Unknown target "never-existed". Available choices: []. No active target matches. Use team_list to find active or dormant teams; resume the intended teammate before retrying.`,
			);
		});
	});

	test("searches only this project's stored teams", async () => {
		const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-other-project-"));
		try {
			await withMainSession(async (main) => {
				storeDormantTeam(otherProject, "team-elsewhere-1", "elsewhere", [["read-optmem-owner", "session-elsewhere"]]);
				const { toolResult } = await sendAsModel(main, ["read-optmem-owner"]);
				assert.match(toolResult.text, /No active target matches\. Use team_list/, "Another project's dormant teammate is not a match for this project.");
				assert.doesNotMatch(toolResult.text, /team-elsewhere-1|session-elsewhere/);
			});
		} finally {
			fs.rmSync(otherProject, { recursive: true, force: true });
		}
	});
});

type SendTool = { execute: (id: string, params: unknown, signal: AbortSignal, onUpdate: undefined, context: unknown) => Promise<unknown> };

/** Loads the extension as a managing teammate of a fake parent team, and returns its team_send_message error text for `targets`. */
async function managingTeammateSendError(directory: string, sessionId: string, targets: string[]): Promise<string> {
	const parent = http.createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ teamName: "parent-team", teamId: "parent-team-id", teammates: [{ name: "lead", teammateId: "lead-id" }] }));
		});
	});
	await new Promise<void>((resolve) => parent.listen(0, "127.0.0.1", resolve));
	const environment = {
		PI_SIMPLE_TEAM_CHILD: "1", PI_SIMPLE_TEAM_CALLBACK_URL: `http://127.0.0.1:${(parent.address() as { port: number }).port}/callback`, PI_SIMPLE_TEAM_CALLBACK_TOKEN: "parent-token",
		PI_SIMPLE_TEAM_TEAM: "parent-team-id", PI_SIMPLE_TEAM_TEAM_NAME: "parent-team", PI_SIMPLE_TEAM_MEMBER: "lead", PI_SIMPLE_TEAM_PROCESS: "test-process", PI_SIMPLE_TEAM_PARTICIPANTS: '["lead"]', PI_SIMPLE_TEAM_CAN_MANAGE_OWN_TEAMS: "1",
	};
	const tools = new Map<string, SendTool>();
	Object.assign(process.env, environment);
	try {
		teamExtension({
			on: () => undefined, registerCommand: () => undefined, registerMessageRenderer: () => undefined,
			registerTool: (tool: SendTool & { name: string }) => tools.set(tool.name, tool),
		} as unknown as ExtensionAPI);
		const context = { cwd: directory, sessionManager: { getCwd: () => directory, getSessionId: () => sessionId } };
		await tools.get("team_send_message")!.execute("boundary", { targets, message: "Follow-up." }, new AbortController().signal, undefined, context);
		assert.fail("Expected the unknown target to be rejected.");
	} catch (error) {
		return (error as Error).message;
	} finally {
		for (const name of Object.keys(environment)) delete process.env[name];
		await new Promise<void>((resolve) => parent.close(() => resolve()));
	}
}

describe("unknown-target recovery for a managing teammate", () => {
	test("names only dormant teammates of teams its own session created", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-manager-boundary-"));
		try {
			storeDormantTeam(directory, "team-own", "own", [["expert", "session-own"]], "manager-session");
			storeDormantTeam(directory, "team-foreign", "foreign", [["expert", "session-foreign"]], "another-main-session");
			assert.equal(await managingTeammateSendError(directory, "manager-session", ["expert"]), [
				`Teammate "expert" belongs to a dormant team.`,
				"Team: team-own",
				"Teammate: session-own",
				"Resume this teammate with team_resume, then retry team_send_message.",
			].join("\n"));
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});

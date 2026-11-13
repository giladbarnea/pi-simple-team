import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "bun:test";
import { useEnvironment } from "./pi-launch.ts";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const extensionPath = path.resolve(import.meta.dir, "..", "index.ts");
const breadcrumbType = "pi-simple-team-teammate";

/** The environment main gives a teammate it starts, as one teammate process of team "crumbs" sees it. */
function teammateEnvironment(callbackUrl: string, parentSessionFile: string): Record<string, string> {
	return {
		PI_SIMPLE_TEAM_CHILD: "1",
		PI_SIMPLE_TEAM_CALLBACK_URL: callbackUrl,
		PI_SIMPLE_TEAM_CALLBACK_TOKEN: "crumb-token",
		PI_SIMPLE_TEAM_TEAM: "main-session-crumbs",
		PI_SIMPLE_TEAM_TEAM_NAME: "crumbs",
		PI_SIMPLE_TEAM_MEMBER: "scout", PI_SIMPLE_TEAM_PROCESS: "crumb-process",
		PI_SIMPLE_TEAM_PARTICIPANTS: JSON.stringify(["main", "scout"]),
		PI_SIMPLE_TEAM_CAN_MANAGE_OWN_TEAMS: "0",
		PI_SIMPLE_TEAM_PARENT_SESSION_ID: "main-session",
		PI_SIMPLE_TEAM_PARENT_SESSION_FILE: parentSessionFile,
	};
}

/** Starts one Pi process of `sessionManager`'s session with the extension loaded, with `environment` as it sees it, and runs one turn. */
async function runTurn(directory: string, sessionManager: SessionManager, environment: Record<string, string>): Promise<{ context: string }> {
	const faux = fauxProvider({ models: [{ id: "faux-crumb" }] });
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey(faux.provider.id, "local-test");
	const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, additionalExtensionPaths: [extensionPath], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	const restoreEnvironment = useEnvironment(environment);
	try {
		await resourceLoader.reload();
		const { session } = await createAgentSession({ cwd: directory, agentDir: directory, model: faux.getModel(), modelRuntime, resourceLoader, sessionManager, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }) });
		try {
			await session.bindExtensions({});
			let context = "";
			const capture: FauxResponseFactory = (transcript) => {
				context = JSON.stringify(transcript);
				return fauxAssistantMessage("Done.");
			};
			faux.setResponses([capture]);
			await session.prompt("Work.");
			return { context };
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	} finally {
		restoreEnvironment();
	}
}

const breadcrumbs = (sessionFile: string) => fs.readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; customType?: string; data?: Record<string, unknown> }).filter((entry) => entry.type === "custom" && entry.customType === breadcrumbType).map((entry) => entry.data!);
const headerId = (sessionFile: string) => (JSON.parse(fs.readFileSync(sessionFile, "utf8").split("\n")[0]!) as { id: string }).id;

test("a teammate session gets one breadcrumb naming its parent session and team; a restart adds none, and a later fork's copy is recognizably inherited", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-breadcrumb-"));
	const main = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ accepted: true }) });
	try {
		const environment = teammateEnvironment(`http://127.0.0.1:${main.port}/callback`, path.join(directory, "main-session.jsonl"));
		const teammateSession = SessionManager.create(directory, path.join(directory, "sessions"));
		const { context } = await runTurn(directory, teammateSession, environment);
		const teammateFile = teammateSession.getSessionFile()!;
		assert.deepEqual(breadcrumbs(teammateFile).map(({ createdAt, ...fields }) => ({ ...fields, createdAt: typeof createdAt })), [{
			sessionId: headerId(teammateFile),
			parentSessionId: "main-session",
			parentSessionFile: path.join(directory, "main-session.jsonl"),
			teamId: "main-session-crumbs",
			teamName: "crumbs",
			teammate: "scout",
			createdAt: "string",
		}]);
		assert.doesNotMatch(context, new RegExp(`${breadcrumbType}|main-session-crumbs|parentSession`), "The breadcrumb never reaches the model's context.");

		await runTurn(directory, SessionManager.open(teammateFile), environment);
		assert.equal(breadcrumbs(teammateFile).length, 1, "A restart of the same teammate session adds no second breadcrumb.");

		const userFork = SessionManager.forkFrom(teammateFile, directory, path.join(directory, "sessions"));
		await runTurn(directory, userFork, {});
		const forkFile = userFork.getSessionFile()!;
		const inherited = breadcrumbs(forkFile);
		assert.equal(inherited.length, 1);
		assert.notEqual(inherited[0]!.sessionId, headerId(forkFile), "A copy inherited through a later fork names the session it was written in, not the fork.");
		assert.equal(inherited[0]!.sessionId, headerId(teammateFile));

		const teammateFork = SessionManager.forkFrom(teammateFile, directory, path.join(directory, "sessions"));
		await runTurn(directory, teammateFork, { ...environment, PI_SIMPLE_TEAM_MEMBER: "grandchild" });
		const own = breadcrumbs(teammateFork.getSessionFile()!).filter((breadcrumb) => breadcrumb.sessionId === headerId(teammateFork.getSessionFile()!));
		assert.deepEqual(own.map((breadcrumb) => breadcrumb.teammate), ["grandchild"], "A teammate forked from a teammate session writes its own breadcrumb beside the inherited one.");
	} finally {
		main.stop(true);
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

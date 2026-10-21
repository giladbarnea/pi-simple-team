import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "bun:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { childToolNames } from "../child-tools.ts";

const extensionPath = path.resolve(import.meta.dir, "..", "index.ts");

/** Load the extension with these environment variables, as a teammate process would see them. */
async function startSession(directory: string, sessionManager: SessionManager, withExtension: boolean, environment: Record<string, string> = {}) {
	const faux = fauxProvider({ models: [{ id: "faux-resume" }] });
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey(faux.provider.id, "local-test");
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		additionalExtensionPaths: withExtension ? [extensionPath] : [],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	Object.assign(process.env, environment);
	try {
		await resourceLoader.reload();
	} finally {
		for (const name of Object.keys(environment)) delete process.env[name];
	}
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		model: faux.getModel(),
		modelRuntime,
		resourceLoader,
		sessionManager,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
	});
	await session.bindExtensions({});
	return { session, faux };
}

/** Save a one-turn session and return its file. */
async function recordSession(directory: string, withExtension: boolean): Promise<string> {
	const sessionManager = SessionManager.create(directory, path.join(directory, "sessions"));
	const recorded = await startSession(directory, sessionManager, withExtension);
	recorded.faux.setResponses([fauxAssistantMessage("Noted.")]);
	await recorded.session.prompt("Remember this session.");
	recorded.session.dispose();
	return sessionManager.getSessionFile()!;
}

for (const canManageOwnTeams of [false, true]) {
	test(`a forked ${canManageOwnTeams ? "managing " : ""}teammate keeps every team tool after /tree back into main's history`, async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-fork-tree-"));
		const main = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ accepted: true }) });
		try {
			// Main's recorded tools never declare send_main_message, and Pi 1.3 restores them on fork and on /tree.
			const mainSessionFile = await recordSession(directory, true);
			const fork = SessionManager.forkFrom(mainSessionFile, directory, path.join(directory, "sessions"));
			const mainTurn = fork.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
			assert.ok(mainTurn, "The fork needs main's recorded turn to navigate back to");
			const { session, faux } = await startSession(directory, fork, true, {
				PI_SIMPLE_TEAM_CHILD: "1",
				PI_SIMPLE_TEAM_CALLBACK_URL: `http://127.0.0.1:${main.port}/callback`,
				PI_SIMPLE_TEAM_CALLBACK_TOKEN: "fork-tree-token",
				PI_SIMPLE_TEAM_TEAM: "fork-tree-team",
				PI_SIMPLE_TEAM_TEAM_NAME: "fork-tree",
				PI_SIMPLE_TEAM_MEMBER: "reviewer",
				PI_SIMPLE_TEAM_PARTICIPANTS: JSON.stringify(["main", "reviewer"]),
				PI_SIMPLE_TEAM_CAN_MANAGE_OWN_TEAMS: canManageOwnTeams ? "1" : "0",
			});
			try {
				faux.setResponses([fauxAssistantMessage("Teammate turn.")]);
				await session.prompt("Work as a teammate.");
				await session.navigateTree(mainTurn.id, { summarize: false });
				const activeTools = session.getActiveToolNames();
				for (const toolName of childToolNames) assert.ok(activeTools.includes(toolName), `Expected ${toolName} after /tree. Active tools: ${activeTools}`);
			} finally {
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
		} finally {
			main.stop(true);
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
}

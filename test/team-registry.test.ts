import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { setSystemTime, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claimTeamLease, releaseTeamLease, type TeamLease } from "../team-registry.ts";

type JsonRecord = Record<string, unknown>;

type ToolResult = {
	content: Array<{ type: string; text: string }>;
	details?: JsonRecord;
};

type RegisteredTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: JsonRecord,
		signal: AbortSignal,
		onUpdate: undefined,
		context: ExtensionContext,
	) => Promise<ToolResult>;
};

type ExtensionEventHandler = (event: JsonRecord, context: ExtensionContext) => Promise<unknown> | unknown;
type TeamExtension = (api: ExtensionAPI) => void;

class ExtensionHost {
	readonly tools = new Map<string, RegisteredTool>();
	private readonly sessionStartHandlers: ExtensionEventHandler[] = [];
	private readonly sessionShutdownHandlers: ExtensionEventHandler[] = [];

	constructor(
		teamExtension: TeamExtension,
		readonly context: ExtensionContext,
	) {
		const api = {
			on: (event: string, handler: ExtensionEventHandler) => {
				if (event === "session_start") this.sessionStartHandlers.push(handler);
				if (event === "session_shutdown") this.sessionShutdownHandlers.push(handler);
			},
			registerCommand: () => undefined,
			registerMessageRenderer: () => undefined,
			registerTool: (tool: RegisteredTool) => this.tools.set(tool.name, tool),
			sendMessage: () => undefined,
		} as unknown as ExtensionAPI;

		teamExtension(api);
	}

	async start(): Promise<void> {
		for (const handler of this.sessionStartHandlers) {
			await handler({ type: "session_start", reason: "startup" }, this.context);
		}
	}

	async execute(toolName: string, params: JsonRecord): Promise<ToolResult> {
		const tool = this.tools.get(toolName);
		if (!tool) throw new Error(`Expected the extension to register ${toolName}.`);
		return tool.execute("test-call", params, new AbortController().signal, undefined, this.context);
	}

	async shutdown(): Promise<void> {
		for (const handler of this.sessionShutdownHandlers) {
			await handler({ type: "session_shutdown", reason: "quit" }, this.context);
		}
	}
}

function makeContext(sessionId: string, projectDirectory: string): ExtensionContext {
	return {
		cwd: projectDirectory,
		hasUI: true,
		mode: "tui",
		scopedModels: [],
		modelRegistry: { getAvailable: () => [{ provider: "fake", id: "fake-model" }] },
		sessionManager: {
			getCwd: () => projectDirectory,
			getSessionFile: () => path.join(projectDirectory, `${sessionId}.jsonl`),
			getSessionId: () => sessionId,
		},
	} as unknown as ExtensionContext;
}

type FakePiInvocation = {
	member: string;
	args: string[];
	sessionId: string;
	sessionFile: string;
	canOverseeOwnTeams: boolean;
};

type FakePiTurn = {
	member: string;
	message: string;
	systemPrompt: string;
};

const fakePiScript = String.raw`#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";

const root = process.env.PI_SIMPLE_TEAM_TEST_ROOT;
const member = process.env.PI_SIMPLE_TEAM_MEMBER;
if (member === "conflict-sensitive" && !process.argv.includes("--no-extensions")) {
	process.stderr.write("conflicting discovered team extension");
	process.exit(1);
}
const sequencePath = path.join(root, member + ".sequence");
const sequence = fs.existsSync(sequencePath) ? Number(fs.readFileSync(sequencePath, "utf8")) + 1 : 1;
fs.writeFileSync(sequencePath, String(sequence));

const sessionArgumentIndex = process.argv.indexOf("--session");
const requestedSessionFile = sessionArgumentIndex === -1 ? undefined : process.argv[sessionArgumentIndex + 1];
const sessionFile = requestedSessionFile ?? path.join(root, "sessions", member + "-" + sequence + ".jsonl");
const sessionId = path.basename(sessionFile, ".jsonl");
if (!requestedSessionFile && (member === "persisted" || sequence > 1)) {
	fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId }) + "\n");
}
fs.appendFileSync(
	path.join(root, "invocations.jsonl"),
	JSON.stringify({
		member,
		args: process.argv.slice(2),
		sessionId,
		sessionFile,
		canOverseeOwnTeams: process.env.PI_SIMPLE_TEAM_CAN_OVERSEE_OWN_TEAMS === "1",
	}) + "\n",
);
const beforeAgentStartHandlers = [];
const sessionStartHandlers = [];
const sessionShutdownHandlers = [];
const registeredTools = new Map();
const extensionArgumentIndex = process.argv.indexOf("-e");
const extensionPath = process.argv[extensionArgumentIndex + 1];
const extensionApi = {
	on: (event, handler) => {
		if (event === "before_agent_start") beforeAgentStartHandlers.push(handler);
		if (event === "session_start") sessionStartHandlers.push(handler);
		if (event === "session_shutdown") sessionShutdownHandlers.push(handler);
	},
	registerCommand: () => undefined,
	registerMessageRenderer: () => undefined,
	registerTool: (tool) => registeredTools.set(tool.name, tool),
};
const { default: teamExtension } = await import(extensionPath);
teamExtension(extensionApi);

const extensionContext = {
	cwd: process.cwd(),
	modelRegistry: { getAvailable: () => [{ provider: "fake", id: "fake-model" }] },
	sessionManager: {
		getCwd: () => process.cwd(),
		getSessionFile: () => sessionFile,
		getSessionId: () => sessionId,
	},
};
for (const handler of sessionStartHandlers) {
	await handler({ type: "session_start", reason: "startup" }, extensionContext);
}
if (member === "recursive-slow-stop") {
	const spawnTool = registeredTools.get("team_spawn");
	await spawnTool.execute(
		"recursive-test-call",
		{
			team: "descendant-team",
			teamPrompt: "Recursive shutdown descendant.",
			teammates: [{ name: "recursive-descendant", prompt: "Wait.", model: "fake/fake-model", thinking: "low" }],
		},
		new AbortController().signal,
		undefined,
		extensionContext,
	);
}

if (member === "slow-stop") {
	process.on("SIGTERM", () => {
		setTimeout(() => {
			fs.appendFileSync(path.join(root, "exits.jsonl"), JSON.stringify({ member }) + "\n");
			process.exit(0);
		}, 150);
	});
}
if (member === "recursive-descendant") {
	process.on("SIGTERM", () => {
		fs.appendFileSync(path.join(root, "exits.jsonl"), JSON.stringify({ member }) + "\n");
		process.exit(0);
	});
}
if (member === "recursive-slow-stop") {
	process.on("SIGTERM", () => {
		void (async () => {
			for (const handler of sessionShutdownHandlers) {
				await handler({ type: "session_shutdown", reason: "quit" }, extensionContext);
			}
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			fs.appendFileSync(path.join(root, "exits.jsonl"), JSON.stringify({ member }) + "\n");
			process.exit(0);
		})();
	});
}

async function handleCommand(command) {
	let systemPrompt;
	if (command.type === "prompt") {
		const systemPromptArgumentIndex = process.argv.indexOf("--system-prompt");
		systemPrompt = process.argv[systemPromptArgumentIndex + 1];
		for (const handler of beforeAgentStartHandlers) {
			const result = await handler(
				{ prompt: command.message, images: [], systemPrompt, systemPromptOptions: {} },
				{},
			);
			if (result && typeof result.systemPrompt === "string") systemPrompt = result.systemPrompt;
		}
		fs.appendFileSync(
			path.join(root, "turns.jsonl"),
			JSON.stringify({ member, message: command.message, systemPrompt }) + "\n",
		);
	}

	const plannedResumeFailure = member === "resume-fails" && sequence > 1 && command.type === "get_state";
	const plannedAddFailure = member === "add-fails" && command.type === "get_state";
	const plannedFailure = plannedResumeFailure || plannedAddFailure;
	const response = {
		type: "response",
		id: command.id,
		command: command.type,
		success: !plannedFailure,
		error: plannedResumeFailure ? "planned resume failure" : plannedAddFailure ? "planned add failure" : undefined,
		data: command.type === "get_state"
			? { isStreaming: false, sessionId, sessionFile }
			: undefined,
	};
	process.stdout.write(JSON.stringify(response) + "\n");
}

let input = "";
let commandQueue = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	input += chunk;
	while (input.includes("\n")) {
		const newline = input.indexOf("\n");
		const line = input.slice(0, newline);
		input = input.slice(newline + 1);
		if (!line.trim()) continue;
		const command = JSON.parse(line);
		commandQueue = commandQueue.then(() => handleCommand(command));
	}
});
process.stdin.resume();
`;

function installFakePi(root: string): () => void {
	const executableDirectory = path.join(root, "bin");
	fs.mkdirSync(executableDirectory);
	fs.mkdirSync(path.join(root, "sessions"));
	fs.writeFileSync(path.join(executableDirectory, "pi"), fakePiScript, { mode: 0o755 });
	const previousPath = process.env.PATH;
	const previousTestRoot = process.env.PI_SIMPLE_TEAM_TEST_ROOT;
	process.env.PATH = `${executableDirectory}${path.delimiter}${previousPath ?? ""}`;
	process.env.PI_SIMPLE_TEAM_TEST_ROOT = root;
	return () => {
		process.env.PATH = previousPath;
		if (previousTestRoot === undefined) delete process.env.PI_SIMPLE_TEAM_TEST_ROOT;
		else process.env.PI_SIMPLE_TEAM_TEST_ROOT = previousTestRoot;
	};
}

function readFakePiInvocations(root: string): FakePiInvocation[] {
	const invocationPath = path.join(root, "invocations.jsonl");
	if (!fs.existsSync(invocationPath)) return [];
	return fs
		.readFileSync(invocationPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as FakePiInvocation);
}

function readFakePiTurns(root: string): FakePiTurn[] {
	const turnsPath = path.join(root, "turns.jsonl");
	if (!fs.existsSync(turnsPath)) return [];
	return fs
		.readFileSync(turnsPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as FakePiTurn);
}

async function waitForFakePiTurns(root: string, expectedCount: number): Promise<FakePiTurn[]> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		const turns = readFakePiTurns(root);
		if (turns.length >= expectedCount) return turns;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Expected ${expectedCount} fake Pi turns. Got: ${JSON.stringify(readFakePiTurns(root))}`);
}

function listedTeam(result: ToolResult, teamId: string): JsonRecord | undefined {
	const teams = Array.isArray(result.details?.teams) ? result.details.teams : [];
	return teams.find((candidate) => typeof candidate === "object" && candidate !== null && (candidate as JsonRecord).id === teamId) as JsonRecord | undefined;
}

function listedMember(result: ToolResult, teamId: string, memberName: string): JsonRecord | undefined {
	const team = listedTeam(result, teamId);
	const members = Array.isArray(team?.members) ? team.members : [];
	return members.find((candidate) => typeof candidate === "object" && candidate !== null && (candidate as JsonRecord).name === memberName) as JsonRecord | undefined;
}

test("team_spawn isolates teammates from conflicting discovered team extensions", async () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-extension-conflict-test-"));
	const agentDirectory = path.join(temporaryDirectory, "agent");
	const projectDirectory = path.join(temporaryDirectory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const restoreFakePi = installFakePi(temporaryDirectory);
	let host: ExtensionHost | undefined;

	try {
		const { default: teamExtension } = await import("../index.ts");
		host = new ExtensionHost(teamExtension, makeContext("origin-main-session-id", projectDirectory));
		await host.start();
		const result = await host.execute("team_spawn", {
			team: "isolated-team",
			teamPrompt: "Ignore unrelated team extensions.",
			teammates: [{ name: "conflict-sensitive", prompt: "Wait.", model: "fake/fake-model", thinking: "low" }],
		});
		assert.equal(result.details?.accepted, true, `Expected teammate startup to ignore conflicting discovered extensions. Got: ${JSON.stringify(result.details)}`);
	} finally {
		await host?.shutdown();
		restoreFakePi();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("team_spawn returns each durable Pi session identity", async () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-spawn-identity-test-"));
	const agentDirectory = path.join(temporaryDirectory, "agent");
	const projectDirectory = path.join(temporaryDirectory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const restoreFakePi = installFakePi(temporaryDirectory);
	let host: ExtensionHost | undefined;

	try {
		const { default: teamExtension } = await import("../index.ts");
		host = new ExtensionHost(teamExtension, makeContext("origin-main-session-id", projectDirectory));
		await host.start();
		const result = await host.execute("team_spawn", {
			team: "identity-team",
			teamPrompt: "Expose durable session identities.",
			teammates: [{ name: "persisted", prompt: "Wait.", model: "fake/fake-model", thinking: "low", canOverseeOwnTeams: true }],
		});
		const invocation = readFakePiInvocations(temporaryDirectory)[0];
		assert.deepEqual(
			result.details?.sessions,
			{ persisted: { sessionId: invocation?.sessionId, sessionFile: invocation?.sessionFile } },
			`Expected team_spawn to return the reported Pi session identity. Got: ${JSON.stringify(result.details)}`,
		);
		const listed = await host.execute("team_list", {});
		const listedTeam = (listed.details?.teams as JsonRecord[] | undefined)?.find((team) => team.id === "origin-main-session-id-identity-team");
		const listedMember = (listedTeam?.members as JsonRecord[] | undefined)?.find((member) => member.name === "persisted");
		assert.equal(
			listedMember?.canOverseeOwnTeams,
			true,
			`Expected the durable attachment to retain recursive-team oversight. Got: ${JSON.stringify(listed.details)}`,
		);
	} finally {
		await host?.shutdown();
		restoreFakePi();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("team_spawn cannot overwrite a dormant team attachment", async () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-spawn-collision-test-"));
	const agentDirectory = path.join(temporaryDirectory, "agent");
	const projectDirectory = path.join(temporaryDirectory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const restoreFakePi = installFakePi(temporaryDirectory);
	let host: ExtensionHost | undefined;

	try {
		const { default: teamExtension } = await import("../index.ts");
		const teamName = "existing-team";
		const teamId = `origin-main-session-id-${teamName}`;
		host = new ExtensionHost(teamExtension, makeContext("origin-main-session-id", projectDirectory));
		await host.start();
		await host.execute("team_spawn", {
			team: teamName,
			teamPrompt: "Keep this attachment.",
			teammates: [{ name: "persisted", prompt: "Wait.", model: "fake/fake-model", thinking: "low" }],
		});
		await host.execute("team_shutdown", { team: teamName });
		const originalMember = listedMember(await host.execute("team_list", {}), teamId, "persisted");
		const invocationCount = readFakePiInvocations(temporaryDirectory).length;

		await assert.rejects(
			() => host!.execute("team_spawn", {
				team: teamName,
				teamPrompt: "Replace the attachment.",
				teammates: [{ name: "replacement", prompt: "Wait.", model: "fake/fake-model", thinking: "low" }],
			}),
			/already exists.*team_resume/i,
			"Expected team_spawn to preserve an existing dormant team attachment.",
		);
		assert.equal(readFakePiInvocations(temporaryDirectory).length, invocationCount, "Expected the rejected spawn to start no replacement Pi session.");
		assert.deepEqual(
			listedMember(await host.execute("team_list", {}), teamId, "persisted"),
			originalMember,
			"Expected the rejected spawn to leave the durable member identity unchanged.",
		);
	} finally {
		await host?.shutdown();
		restoreFakePi();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("canonical team IDs distinguish live teams with the same display name", async () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-canonical-id-test-"));
	const agentDirectory = path.join(temporaryDirectory, "agent");
	const projectDirectory = path.join(temporaryDirectory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const hosts: ExtensionHost[] = [];

	try {
		const { default: teamExtension } = await import("../index.ts");
		const teamName = "shared-name";
		for (const sessionId of ["first-main", "second-main"]) {
			const host = new ExtensionHost(teamExtension, makeContext(sessionId, projectDirectory));
			hosts.push(host);
			await host.start();
			await host.execute("team_spawn", { team: teamName, teamPrompt: sessionId, teammates: [] });
			const result = await host.execute("teamstatus", { team: `${sessionId}-${teamName}` });
			assert.equal(result.details?.team, teamName, `Expected ${sessionId} to address its live team by canonical ID.`);
		}
	} finally {
		for (const host of hosts.reverse()) await host.shutdown();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("an overseeing teammate can discover and resume only teams it created", async () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-recursive-scope-test-"));
	const agentDirectory = path.join(temporaryDirectory, "agent");
	const projectDirectory = path.join(temporaryDirectory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const hosts: ExtensionHost[] = [];

	try {
		const { default: teamExtension } = await import("../index.ts");
		for (const [sessionId, teamName] of [["top-main-session", "parent-team"], ["sibling-session", "sibling-team"]] as const) {
			const host = new ExtensionHost(teamExtension, makeContext(sessionId, projectDirectory));
			hosts.push(host);
			await host.start();
			await host.execute("team_spawn", { team: teamName, teamPrompt: "Foreign scope.", teammates: [] });
			await host.shutdown();
			hosts.pop();
		}

		const childEnvironment = {
			PI_SIMPLE_TEAM_CHILD: "1",
			PI_SIMPLE_TEAM_VISIBLE_CHILD: "0",
			PI_SIMPLE_TEAM_CALLBACK_URL: "http://127.0.0.1:1/callback",
			PI_SIMPLE_TEAM_CALLBACK_TOKEN: "unused",
			PI_SIMPLE_TEAM_TEAM: "top-main-session-parent-team",
			PI_SIMPLE_TEAM_TEAM_NAME: "parent-team",
			PI_SIMPLE_TEAM_MEMBER: "lead",
			PI_SIMPLE_TEAM_PARTICIPANTS: JSON.stringify(["lead"]),
			PI_SIMPLE_TEAM_CAN_OVERSEE_OWN_TEAMS: "1",
		};
		const previousChildEnvironment = Object.fromEntries(Object.keys(childEnvironment).map((name) => [name, process.env[name]]));
		Object.assign(process.env, childEnvironment);
		const overseer = new ExtensionHost(teamExtension, makeContext("lead-session", projectDirectory));
		hosts.push(overseer);
		await overseer.start();
		for (const [name, value] of Object.entries(previousChildEnvironment)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}

		await overseer.execute("team_spawn", { team: "owned-team", teamPrompt: "Owned scope.", teammates: [] });
		const listed = await overseer.execute("team_list", {});
		assert.deepEqual(
			(listed.details?.teams as JsonRecord[] | undefined)?.map((team) => team.id),
			["lead-session-owned-team"],
			`Expected the overseeing teammate to discover only its own teams. Got: ${JSON.stringify(listed.details)}`,
		);
		await assert.rejects(
			() => overseer.execute("team_resume", { team: "top-main-session-parent-team" }),
			/Unknown current-project team/,
			"Expected the overseeing teammate to reject its dormant parent team as outside its management scope.",
		);
	} finally {
		for (const host of hosts.reverse()) await host.shutdown();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("team_shutdown waits for every RPC runtime before releasing ownership", async () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-shutdown-wait-test-"));
	const agentDirectory = path.join(temporaryDirectory, "agent");
	const projectDirectory = path.join(temporaryDirectory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const restoreFakePi = installFakePi(temporaryDirectory);
	let host: ExtensionHost | undefined;

	try {
		const { default: teamExtension } = await import("../index.ts");
		host = new ExtensionHost(teamExtension, makeContext("origin-main-session-id", projectDirectory));
		await host.start();
		await host.execute("team_spawn", {
			team: "slow-shutdown-team",
			teamPrompt: "Wait for process exit.",
			teammates: [{ name: "slow-stop", prompt: "Wait.", model: "fake/fake-model", thinking: "low" }],
		});
		await host.execute("team_shutdown", { team: "slow-shutdown-team" });
		const exitsPath = path.join(temporaryDirectory, "exits.jsonl");
		assert.equal(fs.existsSync(exitsPath), true, "Expected team_shutdown to return only after the RPC child exited.");
	} finally {
		await host?.shutdown();
		await new Promise((resolve) => setTimeout(resolve, 200));
		restoreFakePi();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("team_shutdown gives an overseeing teammate time to stop its own teams", async () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-recursive-shutdown-test-"));
	const agentDirectory = path.join(temporaryDirectory, "agent");
	const projectDirectory = path.join(temporaryDirectory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const restoreFakePi = installFakePi(temporaryDirectory);
	let host: ExtensionHost | undefined;

	try {
		const { default: teamExtension } = await import("../index.ts");
		host = new ExtensionHost(teamExtension, makeContext("origin-main-session-id", projectDirectory));
		await host.start();
		await host.execute("team_spawn", {
			team: "recursive-shutdown-team",
			teamPrompt: "Allow descendant shutdown.",
			teammates: [{
				name: "recursive-slow-stop",
				prompt: "Stop descendants before exiting.",
				model: "fake/fake-model",
				thinking: "low",
				canOverseeOwnTeams: true,
			}],
		});
		await host.execute("team_shutdown", { team: "recursive-shutdown-team" });
		const exitsPath = path.join(temporaryDirectory, "exits.jsonl");
		assert.equal(
			fs.existsSync(exitsPath),
			true,
			"Expected the overseeing teammate to finish recursive cleanup before team_shutdown returned.",
		);
		const exits = fs.readFileSync(exitsPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as JsonRecord);
		assert.deepEqual(
			exits.map((exit) => exit.member).sort(),
			["recursive-descendant", "recursive-slow-stop"],
			"Expected recursive shutdown to stop the descendant before the overseeing teammate exited.",
		);
		const listed = await host.execute("team_list", {});
		const descendantTeam = (listed.details?.teams as JsonRecord[] | undefined)?.find(
			(team) => team.id === "recursive-slow-stop-1-descendant-team",
		);
		assert.deepEqual(
			{
				state: descendantTeam?.state,
				leaseState: descendantTeam?.leaseState,
				memberLive: (descendantTeam?.members as JsonRecord[] | undefined)?.[0]?.live,
			},
			{ state: "dormant", leaseState: "unclaimed", memberLive: false },
			`Expected recursive shutdown to leave the descendant attachment dormant and unclaimed. Got: ${JSON.stringify(descendantTeam)}`,
		);
	} finally {
		await host?.shutdown();
		restoreFakePi();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("team_add grows an owned running team with durable new sessions and a next-turn roster", async () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-add-test-"));
	const agentDirectory = path.join(temporaryDirectory, "agent");
	const projectDirectory = path.join(temporaryDirectory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);

	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const restoreFakePi = installFakePi(temporaryDirectory);
	let host: ExtensionHost | undefined;

	try {
		const { default: teamExtension } = await import("../index.ts");
		const teamName = "growing-team";
		const teamId = `origin-main-session-id-${teamName}`;
		host = new ExtensionHost(teamExtension, makeContext("origin-main-session-id", projectDirectory));
		await host.start();
		await host.execute("team_spawn", {
			team: teamName,
			teamPrompt: "Add public-interface test.",
			teammates: [{ name: "original", prompt: "Wait.", model: "fake/fake-model", thinking: "low" }],
		});

		const invocationCountBeforeRejectedAdds = readFakePiInvocations(temporaryDirectory).length;
		await assert.rejects(
			() =>
				host!.execute("team_add", {
					team: teamId,
					teammates: [
						{ name: "duplicate", prompt: "Wait.", model: "fake/fake-model", thinking: "low" },
						{ name: " duplicate ", prompt: "Wait.", model: "fake/fake-model", thinking: "low" },
					],
				}),
			/duplicate teammate name/i,
			"Expected team_add to reject duplicate names within one request before starting a session.",
		);
		await assert.rejects(
			() =>
				host!.execute("team_add", {
					team: teamId,
					teammates: [{ name: "original", prompt: "Wait.", model: "fake/fake-model", thinking: "low" }],
				}),
			/already.*team|duplicate teammate name/i,
			"Expected team_add to reject a name already present in the team.",
		);
		await assert.rejects(
			() =>
				host!.execute("team_add", {
					team: teamId,
					teammates: [{ name: "main", prompt: "Wait.", model: "fake/fake-model", thinking: "low" }],
				}),
			/"main" is reserved/i,
			"Expected team_add to reject the reserved main name.",
		);
		assert.equal(
			readFakePiInvocations(temporaryDirectory).length,
			invocationCountBeforeRejectedAdds,
			"Expected rejected additions to start no Pi sessions.",
		);

		const addResult = await host.execute("team_add", {
			team: teamId,
			teammates: [
				{ name: "security", prompt: "Review security.", model: "fake/fake-model", thinking: "high" },
				{ name: "operations", prompt: "Review operations.", model: "fake/fake-model", thinking: "medium" },
			],
		});
		assert.deepEqual(
			addResult.details?.added,
			["security", "operations"],
			`Expected team_add to report both new teammates in request order. Got: ${JSON.stringify(addResult.details)}`,
		);

		const invocations = readFakePiInvocations(temporaryDirectory);
		for (const memberName of ["security", "operations"]) {
			const invocation = invocations.find((candidate) => candidate.member === memberName);
			assert.deepEqual(
				invocation?.args.slice(0, 2),
				["--mode", "rpc"],
				`Expected ${memberName} to start as a new RPC Pi session. Got: ${JSON.stringify(invocation)}`,
			);
			assert.equal(
				invocation?.args.includes("--session"),
				false,
				`Expected ${memberName} to start a new session instead of attaching an existing session. Got: ${JSON.stringify(invocation)}`,
			);
		}

		const listed = await host.execute("team_list", {});
		assert.deepEqual(
			listedTeam(listed, teamId)?.teammates,
			["original", "security", "operations"],
			`Expected team_list to expose the persisted expanded roster. Got: ${JSON.stringify(listed.details)}`,
		);
		for (const memberName of ["security", "operations"]) {
			const member = listedMember(listed, teamId, memberName);
			assert.equal(typeof member?.sessionId, "string", `Expected ${memberName} to have a persisted session ID. Got: ${JSON.stringify(member)}`);
			assert.equal(typeof member?.sessionFile, "string", `Expected ${memberName} to have a persisted session file. Got: ${JSON.stringify(member)}`);
		}

		assert.deepEqual(readFakePiTurns(temporaryDirectory), [], "Expected team_add to leave the original teammate asleep.");
		await host.execute("teamsend", {
			team: teamName,
			to: ["original", "security", "operations"],
			message: "Report the current roster.",
		});
		const turns = await waitForFakePiTurns(temporaryDirectory, 3);
		for (const memberName of ["original", "security", "operations"]) {
			const turn = turns.find((candidate) => candidate.member === memberName);
			assert.match(
				turn?.systemPrompt ?? "",
				/Participants: main, original, security, operations\./,
				`Expected ${memberName}'s next turn to see the current roster. Got: ${JSON.stringify(turn)}`,
			);
		}

		await host.execute("team_shutdown", { team: teamName });
		await assert.rejects(
			() =>
				host!.execute("team_add", {
					team: teamId,
					teammates: [{ name: "too-late", prompt: "Wait.", model: "fake/fake-model", thinking: "low" }],
				}),
			/running team/i,
			"Expected team_add to reject a dormant team even when its manifest remains discoverable.",
		);
	} finally {
		await host?.shutdown();
		restoreFakePi();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("failed team_add waits for only its newly started processes to exit", async () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-add-rollback-test-"));
	const agentDirectory = path.join(temporaryDirectory, "agent");
	const projectDirectory = path.join(temporaryDirectory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const restoreFakePi = installFakePi(temporaryDirectory);
	let host: ExtensionHost | undefined;

	try {
		const { default: teamExtension } = await import("../index.ts");
		const teamName = "add-rollback-team";
		const teamId = `origin-main-session-id-${teamName}`;
		host = new ExtensionHost(teamExtension, makeContext("origin-main-session-id", projectDirectory));
		await host.start();
		await host.execute("team_spawn", {
			team: teamName,
			teamPrompt: "Rollback only the new teammates.",
			teammates: [{ name: "persisted", prompt: "Wait.", model: "fake/fake-model", thinking: "low" }],
		});

		await assert.rejects(
			() => host!.execute("team_add", {
				team: teamId,
				teammates: [
					{ name: "slow-stop", prompt: "Wait.", model: "fake/fake-model", thinking: "low" },
					{ name: "add-fails", prompt: "Wait.", model: "fake/fake-model", thinking: "low" },
				],
			}),
			/planned add failure/i,
			"Expected the later teammate's failed readiness handshake to reject team_add.",
		);
		const exitsPath = path.join(temporaryDirectory, "exits.jsonl");
		assert.equal(
			fs.existsSync(exitsPath),
			true,
			"Expected team_add rollback to return only after the newly started slow process exited.",
		);
		const listed = await host.execute("team_list", {});
		assert.deepEqual(
			listedTeam(listed, teamId)?.teammates,
			["persisted"],
			`Expected rollback to remove only the requested additions. Got: ${JSON.stringify(listed.details)}`,
		);
		await host.execute("teamsend", { team: teamId, to: ["persisted"], message: "Confirm that you remained live." });
		const turns = await waitForFakePiTurns(temporaryDirectory, 1);
		assert.equal(turns[0]?.member, "persisted", `Expected the existing teammate to remain reachable. Got: ${JSON.stringify(turns)}`);
	} finally {
		await host?.shutdown();
		restoreFakePi();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("a later same-project session resumes selected and all stopped teammates without losing session identity", async () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-resume-test-"));
	const agentDirectory = path.join(temporaryDirectory, "agent");
	const projectDirectory = path.join(temporaryDirectory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);

	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const restoreFakePi = installFakePi(temporaryDirectory);
	const hosts: ExtensionHost[] = [];

	try {
		const { default: teamExtension } = await import("../index.ts");
		const teamName = "resume-team";
		const teamId = `origin-main-session-id-${teamName}`;
		const originHost = new ExtensionHost(teamExtension, makeContext("origin-main-session-id", projectDirectory));
		hosts.push(originHost);
		await originHost.start();
		await originHost.execute("team_spawn", {
			team: teamName,
			teamPrompt: "Resume public-interface test.",
			teammates: [
				{ name: "persisted", prompt: "Wait.", model: "fake/fake-model", thinking: "low", canOverseeOwnTeams: true },
				{ name: "untouched", prompt: "Wait.", model: "fake/fake-model", thinking: "low" },
			],
		});
		await originHost.execute("team_shutdown", { team: teamName });

		const resumingHost = new ExtensionHost(teamExtension, makeContext("resuming-main-session-id", projectDirectory));
		hosts.push(resumingHost);
		await resumingHost.start();
		const dormantList = await resumingHost.execute("team_list", {});
		const persistedBeforeResume = listedMember(dormantList, teamId, "persisted");
		const untouchedBeforeResume = listedMember(dormantList, teamId, "untouched");
		assert.equal(
			persistedBeforeResume?.sessionFile,
			path.join(temporaryDirectory, "sessions", "persisted-1.jsonl"),
			`Expected team_list to expose the persisted member session file. Got: ${JSON.stringify(dormantList.details)}`,
		);
		assert.equal(
			untouchedBeforeResume?.sessionFile,
			path.join(temporaryDirectory, "sessions", "untouched-1.jsonl"),
			`Expected team_list to expose the untouched member provisional session file. Got: ${JSON.stringify(dormantList.details)}`,
		);

		const selectedResume = await resumingHost.execute("team_resume", { team: teamId, teammates: ["persisted"] });
		assert.deepEqual(
			selectedResume.details?.resumed,
			["persisted"],
			`Expected selective resume to start only persisted. Got: ${JSON.stringify(selectedResume.details)}`,
		);
		const persistedResumeInvocation = readFakePiInvocations(temporaryDirectory).filter((invocation) => invocation.member === "persisted").at(-1);
		assert.deepEqual(
			persistedResumeInvocation?.args.slice(0, 3),
			["--mode", "rpc", "--session"],
			`Expected resumed teammates to use RPC with their session file. Got: ${JSON.stringify(persistedResumeInvocation)}`,
		);
		assert.equal(
			persistedResumeInvocation?.args[3],
			persistedBeforeResume?.sessionFile,
			`Expected resume to pass the exact reported session file. Got: ${JSON.stringify(persistedResumeInvocation)}`,
		);
		assert.equal(
			persistedResumeInvocation?.args.includes("--model"),
			false,
			`Expected persisted session state to choose its restored model. Got: ${JSON.stringify(persistedResumeInvocation)}`,
		);
		assert.equal(
			persistedResumeInvocation?.canOverseeOwnTeams,
			true,
			`Expected resume to restore recursive-team oversight. Got: ${JSON.stringify(persistedResumeInvocation)}`,
		);

		const competingHost = new ExtensionHost(teamExtension, makeContext("competing-main-session-id", projectDirectory));
		hosts.push(competingHost);
		await competingHost.start();
		await assert.rejects(
			() => competingHost.execute("team_resume", { team: teamId }),
			/already owned/i,
			"Expected the live team lease to reject concurrent ownership.",
		);

		const defaultResume = await resumingHost.execute("team_resume", { team: teamId });
		assert.deepEqual(
			defaultResume.details?.resumed,
			["untouched"],
			`Expected default resume to start every stopped member only. Got: ${JSON.stringify(defaultResume.details)}`,
		);
		const untouchedEmptyRestart = readFakePiInvocations(temporaryDirectory).filter((invocation) => invocation.member === "untouched").at(-1);
		assert.equal(
			untouchedEmptyRestart?.args.includes("--session"),
			false,
			`Expected a never-materialized teammate to restart empty. Got: ${JSON.stringify(untouchedEmptyRestart)}`,
		);
		const activeList = await resumingHost.execute("team_list", {});
		const untouchedAfterResume = listedMember(activeList, teamId, "untouched");
		assert.equal(
			untouchedAfterResume?.sessionFile,
			path.join(temporaryDirectory, "sessions", "untouched-2.jsonl"),
			`Expected empty restart to replace the provisional identity. Got: ${JSON.stringify(activeList.details)}`,
		);
		await resumingHost.execute("team_shutdown", { team: teamName });

		const verificationHost = new ExtensionHost(teamExtension, makeContext("verification-main-session-id", projectDirectory));
		hosts.push(verificationHost);
		await verificationHost.start();
		await verificationHost.execute("team_resume", { team: teamId, teammates: ["untouched"] });
		const untouchedPersistedResume = readFakePiInvocations(temporaryDirectory).filter((invocation) => invocation.member === "untouched").at(-1);
		assert.equal(
			untouchedPersistedResume?.args[untouchedPersistedResume.args.indexOf("--session") + 1],
			untouchedAfterResume?.sessionFile,
			`Expected later resume to use the replacement session identity. Got: ${JSON.stringify(untouchedPersistedResume)}`,
		);
		await verificationHost.execute("team_shutdown", { team: teamName });

		fs.rmSync(String(persistedBeforeResume?.sessionFile));
		const missingHistoryHost = new ExtensionHost(teamExtension, makeContext("missing-history-main-session-id", projectDirectory));
		hosts.push(missingHistoryHost);
		await missingHistoryHost.start();
		await assert.rejects(
			() => missingHistoryHost.execute("team_resume", { team: teamId, teammates: ["persisted"] }),
			/materialized session file.*missing/i,
			"Expected resume to fail instead of replacing known conversation history.",
		);
	} finally {
		for (const host of hosts.reverse()) await host.shutdown();
		restoreFakePi();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("a failed selective resume leaves members that were already running alive", async () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-selective-resume-rollback-test-"));
	const agentDirectory = path.join(temporaryDirectory, "agent");
	const projectDirectory = path.join(temporaryDirectory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const restoreFakePi = installFakePi(temporaryDirectory);
	const hosts: ExtensionHost[] = [];

	try {
		const { default: teamExtension } = await import("../index.ts");
		const teamName = "selective-resume-rollback-team";
		const teamId = `origin-main-session-id-${teamName}`;
		const originHost = new ExtensionHost(teamExtension, makeContext("origin-main-session-id", projectDirectory));
		hosts.push(originHost);
		await originHost.start();
		await originHost.execute("team_spawn", {
			team: teamName,
			teamPrompt: "Keep existing runtimes alive after a failed selective resume.",
			teammates: [
				{ name: "persisted", prompt: "Wait.", model: "fake/fake-model", thinking: "low" },
				{ name: "resume-fails", prompt: "Wait.", model: "fake/fake-model", thinking: "low" },
			],
		});
		await originHost.execute("team_shutdown", { team: teamId });

		const resumingHost = new ExtensionHost(teamExtension, makeContext("resuming-main-session-id", projectDirectory));
		hosts.push(resumingHost);
		await resumingHost.start();
		await resumingHost.execute("team_resume", { team: teamId, teammates: ["persisted"] });
		await assert.rejects(
			() => resumingHost.execute("team_resume", { team: teamId, teammates: ["resume-fails"] }),
			/planned resume failure/i,
			"Expected the selected teammate's failed readiness handshake to reject resume.",
		);

		await resumingHost.execute("teamsend", {
			team: teamId,
			to: ["persisted"],
			message: "Confirm that your existing runtime survived.",
		});
		const turns = await waitForFakePiTurns(temporaryDirectory, 1);
		assert.equal(
			turns[0]?.member,
			"persisted",
			`Expected the already-running teammate to remain reachable. Got: ${JSON.stringify(turns)}`,
		);
	} finally {
		for (const host of hosts.reverse()) await host.shutdown();
		restoreFakePi();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("team_list reports the live lease and exact dormant expiry", async () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-list-lifecycle-test-"));
	const agentDirectory = path.join(temporaryDirectory, "agent");
	const projectDirectory = path.join(temporaryDirectory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const initialTime = new Date("2026-01-01T00:00:00.000Z");
	setSystemTime(initialTime);
	let host: ExtensionHost | undefined;

	try {
		const { default: teamExtension } = await import("../index.ts");
		const teamName = "listed-lifecycle-team";
		const teamId = `origin-main-session-id-${teamName}`;
		host = new ExtensionHost(teamExtension, makeContext("origin-main-session-id", projectDirectory));
		await host.start();
		await host.execute("team_spawn", { team: teamName, teamPrompt: "List lifecycle.", teammates: [] });
		const activeTeam = listedTeam(await host.execute("team_list", {}), teamId);
		assert.deepEqual(
			{ state: activeTeam?.state, leaseState: activeTeam?.leaseState, expiresAt: activeTeam?.expiresAt },
			{ state: "active", leaseState: "claimed", expiresAt: undefined },
			`Expected team_list to expose active ownership without an expiry. Got: ${JSON.stringify(activeTeam)}`,
		);

		await host.execute("team_shutdown", { team: teamName });
		const dormantTeam = listedTeam(await host.execute("team_list", {}), teamId);
		assert.deepEqual(
			{ state: dormantTeam?.state, leaseState: dormantTeam?.leaseState, expiresAt: dormantTeam?.expiresAt },
			{ state: "dormant", leaseState: "unclaimed", expiresAt: "2026-01-31T00:00:00.000Z" },
			`Expected team_list to expose released ownership and the 30-day expiry. Got: ${JSON.stringify(dormantTeam)}`,
		);
	} finally {
		setSystemTime();
		await host?.shutdown();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("team_list reports each member's live runtime state", async () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-list-member-state-test-"));
	const agentDirectory = path.join(temporaryDirectory, "agent");
	const projectDirectory = path.join(temporaryDirectory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const restoreFakePi = installFakePi(temporaryDirectory);
	const hosts: ExtensionHost[] = [];

	try {
		const { default: teamExtension } = await import("../index.ts");
		const teamName = "listed-member-state-team";
		const teamId = `origin-main-session-id-${teamName}`;
		const originHost = new ExtensionHost(teamExtension, makeContext("origin-main-session-id", projectDirectory));
		hosts.push(originHost);
		await originHost.start();
		await originHost.execute("team_spawn", {
			team: teamName,
			teamPrompt: "Expose live runtime state.",
			teammates: [
				{ name: "persisted", prompt: "Wait.", model: "fake/fake-model", thinking: "low" },
				{ name: "untouched", prompt: "Wait.", model: "fake/fake-model", thinking: "low" },
			],
		});
		const activeList = await originHost.execute("team_list", {});
		assert.deepEqual(
			["persisted", "untouched"].map((name) => ({ name, live: listedMember(activeList, teamId, name)?.live })),
			[{ name: "persisted", live: true }, { name: "untouched", live: true }],
			`Expected spawned members to report live runtimes. Got: ${JSON.stringify(activeList.details)}`,
		);
		await originHost.execute("team_shutdown", { team: teamId });
		const dormantList = await originHost.execute("team_list", {});
		assert.deepEqual(
			["persisted", "untouched"].map((name) => ({ name, live: listedMember(dormantList, teamId, name)?.live })),
			[{ name: "persisted", live: false }, { name: "untouched", live: false }],
			`Expected shut-down members to report no live runtime. Got: ${JSON.stringify(dormantList.details)}`,
		);

		const resumingHost = new ExtensionHost(teamExtension, makeContext("resuming-main-session-id", projectDirectory));
		hosts.push(resumingHost);
		await resumingHost.start();
		await resumingHost.execute("team_resume", { team: teamId, teammates: ["persisted"] });
		const selectiveList = await resumingHost.execute("team_list", {});
		assert.deepEqual(
			["persisted", "untouched"].map((name) => ({ name, live: listedMember(selectiveList, teamId, name)?.live })),
			[{ name: "persisted", live: true }, { name: "untouched", live: false }],
			`Expected selective resume to report only its running member as live. Got: ${JSON.stringify(selectiveList.details)}`,
		);
	} finally {
		for (const host of hosts.reverse()) await host.shutdown();
		restoreFakePi();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("recovering a stale lease marks the abandoned active manifest dormant", async () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-stale-lease-test-"));
	const agentDirectory = path.join(temporaryDirectory, "agent");
	const projectDirectory = path.join(temporaryDirectory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const initialTime = new Date("2026-01-01T00:00:00.000Z");
	const recoveryTime = new Date("2026-01-02T00:00:00.000Z");
	setSystemTime(initialTime);
	let host: ExtensionHost | undefined;
	let recoveredLease: TeamLease | undefined;

	try {
		const { default: teamExtension } = await import("../index.ts");
		const teamName = "abandoned-team";
		const teamId = `origin-main-session-id-${teamName}`;
		const registryPrefix = path.join(agentDirectory, "pi-simple-team", "teams", encodeURIComponent(teamId));
		const manifestPath = `${registryPrefix}.json`;
		const leasePath = `${registryPrefix}.lease`;
		host = new ExtensionHost(teamExtension, makeContext("origin-main-session-id", projectDirectory));
		await host.start();
		await host.execute("team_spawn", { team: teamName, teamPrompt: "Recover abandoned ownership.", teammates: [] });
		const activeManifest = fs.readFileSync(manifestPath, "utf8");
		const staleLease = JSON.parse(fs.readFileSync(leasePath, "utf8")) as JsonRecord;
		await host.execute("team_shutdown", { team: teamName });
		fs.writeFileSync(manifestPath, activeManifest);
		fs.writeFileSync(leasePath, `${JSON.stringify({ ...staleLease, processId: 2_147_483_647 }, null, 2)}\n`);

		setSystemTime(recoveryTime);
		recoveredLease = claimTeamLease(teamId, "recovering-main-session-id");
		const recoveredManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as JsonRecord;
		assert.deepEqual(
			{
				state: recoveredManifest.state,
				shutdownAt: recoveredManifest.shutdownAt,
				expiresAt: recoveredManifest.expiresAt,
			},
			{
				state: "dormant",
				shutdownAt: "2026-01-02T00:00:00.000Z",
				expiresAt: "2026-02-01T00:00:00.000Z",
			},
			`Expected stale lease recovery to start the abandoned team's dormant TTL. Got: ${JSON.stringify(recoveredManifest)}`,
		);
	} finally {
		if (recoveredLease) releaseTeamLease(recoveredLease);
		setSystemTime();
		await host?.shutdown();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("stale lease reclamation cannot unlink a concurrent live lease", () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-lease-race-test-"));
	const agentDirectory = path.join(temporaryDirectory, "agent");
	const registryDirectory = path.join(agentDirectory, "pi-simple-team", "teams");
	fs.mkdirSync(registryDirectory, { recursive: true });
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const teamId = "origin-main-session-id-raced-team";
	const leasePath = path.join(registryDirectory, `${encodeURIComponent(teamId)}.lease`);
	const staleProcessId = 2_147_483_647;
	const staleLease: TeamLease = {
		version: 1,
		teamId,
		mainSessionId: "abandoned-main-session-id",
		processId: staleProcessId,
		token: "abandoned-token",
		claimedAt: "2026-01-01T00:00:00.000Z",
	};
	const winningLease: TeamLease = {
		...staleLease,
		mainSessionId: "winning-main-session-id",
		processId: process.pid,
		token: "winning-token",
	};
	fs.writeFileSync(leasePath, `${JSON.stringify(staleLease, null, 2)}\n`);
	const originalProcessKill = process.kill;
	let injectedConcurrentLease = false;
	let unexpectedLease: TeamLease | undefined;
	process.kill = ((processId: number, signal?: NodeJS.Signals | number): true => {
		if (processId !== staleProcessId || injectedConcurrentLease) return originalProcessKill(processId, signal);
		injectedConcurrentLease = true;
		fs.writeFileSync(leasePath, `${JSON.stringify(winningLease, null, 2)}\n`);
		throw Object.assign(new Error("No such process"), { code: "ESRCH" });
	}) as typeof process.kill;

	try {
		assert.throws(
			() => {
				unexpectedLease = claimTeamLease(teamId, "losing-main-session-id");
			},
			/already owned.*winning-main-session-id/i,
			"Expected stale reclamation to preserve a live lease installed by a concurrent claimant.",
		);
		assert.deepEqual(
			JSON.parse(fs.readFileSync(leasePath, "utf8")),
			winningLease,
			"Expected the losing claimant to leave the concurrent live lease unchanged.",
		);
	} finally {
		process.kill = originalProcessKill;
		if (unexpectedLease) releaseTeamLease(unexpectedLease);
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("an expired dormant team removes only registry files while an equally old active team remains", async () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-expiry-test-"));
	const agentDirectory = path.join(temporaryDirectory, "agent");
	const projectDirectory = path.join(temporaryDirectory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);

	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const restoreFakePi = installFakePi(temporaryDirectory);
	const initialTime = new Date("2026-01-01T00:00:00.000Z");
	const expirationMilliseconds = 30 * 24 * 60 * 60 * 1_000;
	setSystemTime(initialTime);
	let host: ExtensionHost | undefined;

	try {
		const { default: teamExtension } = await import("../index.ts");
		host = new ExtensionHost(teamExtension, makeContext("origin-main-session-id", projectDirectory));
		await host.start();

		const dormantTeamName = "expiring-team";
		const dormantTeamId = `origin-main-session-id-${dormantTeamName}`;
		await host.execute("team_spawn", {
			team: dormantTeamName,
			teamPrompt: "Expiry public-interface test.",
			teammates: [{ name: "persisted", prompt: "Wait.", model: "fake/fake-model", thinking: "low" }],
		});
		const spawnedTeams = await host.execute("team_list", {});
		const reportedSessionFile = listedMember(spawnedTeams, dormantTeamId, "persisted")?.sessionFile;
		assert.equal(
			typeof reportedSessionFile,
			"string",
			`Expected team_list to expose the teammate Pi session file. Got: ${JSON.stringify(spawnedTeams.details)}`,
		);
		const sessionFile = reportedSessionFile as string;
		const sessionBeforeExpiry = {
			content: fs.readFileSync(sessionFile, "utf8"),
			modifiedAt: fs.statSync(sessionFile).mtimeMs,
		};

		const registryDirectory = path.join(agentDirectory, "pi-simple-team", "teams");
		const dormantRegistryPrefix = path.join(registryDirectory, encodeURIComponent(dormantTeamId));
		const dormantManifestPath = `${dormantRegistryPrefix}.json`;
		const dormantLeasePath = `${dormantRegistryPrefix}.lease`;
		const dormantLease = fs.readFileSync(dormantLeasePath, "utf8");
		await host.execute("team_shutdown", { team: dormantTeamName });
		fs.writeFileSync(dormantLeasePath, dormantLease);

		const activeTeamName = "active-team";
		const activeTeamId = `origin-main-session-id-${activeTeamName}`;
		const activeRegistryPrefix = path.join(registryDirectory, encodeURIComponent(activeTeamId));
		const activeManifestPath = `${activeRegistryPrefix}.json`;
		const activeLeasePath = `${activeRegistryPrefix}.lease`;
		await host.execute("team_spawn", {
			team: activeTeamName,
			teamPrompt: "Active manifest retention test.",
			teammates: [],
		});

		setSystemTime(new Date(initialTime.getTime() + expirationMilliseconds - 1));
		const beforeExpiration = await host.execute("team_list", {});
		assert.equal(
			listedTeam(beforeExpiration, dormantTeamId)?.state,
			"dormant",
			`Expected the dormant manifest to remain before 30 days. Got: ${JSON.stringify(beforeExpiration.details)}`,
		);
		assert.equal(fs.existsSync(dormantLeasePath), true, "Expected registry access before expiry to keep the dormant team lease.");

		setSystemTime(new Date(initialTime.getTime() + expirationMilliseconds));
		const atExpiration = await host.execute("team_list", {});
		assert.equal(
			listedTeam(atExpiration, dormantTeamId),
			undefined,
			`Expected the next registry access at 30 days to remove the dormant team. Got: ${JSON.stringify(atExpiration.details)}`,
		);
		assert.deepEqual(
			listedTeam(atExpiration, activeTeamId) && {
				id: listedTeam(atExpiration, activeTeamId)?.id,
				state: listedTeam(atExpiration, activeTeamId)?.state,
			},
			{ id: activeTeamId, state: "active" },
			`Expected an equally old active manifest to remain. Got: ${JSON.stringify(atExpiration.details)}`,
		);
		assert.equal(fs.existsSync(dormantManifestPath), false, "Expected expiry to delete the dormant team manifest.");
		assert.equal(fs.existsSync(dormantLeasePath), false, "Expected expiry to delete the dormant team lease.");
		assert.equal(fs.existsSync(activeManifestPath), true, "Expected expiry to keep the active team manifest.");
		assert.equal(fs.existsSync(activeLeasePath), true, "Expected expiry to keep the active team lease.");
		assert.equal(fs.existsSync(sessionFile), true, "Expected expiry to keep the teammate Pi session file.");
		assert.deepEqual(
			{
				content: fs.readFileSync(sessionFile, "utf8"),
				modifiedAt: fs.statSync(sessionFile).mtimeMs,
			},
			sessionBeforeExpiry,
			"Expected expiry to leave the teammate Pi session file unchanged.",
		);
	} finally {
		setSystemTime();
		await host?.shutdown();
		restoreFakePi();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("team discovery treats a symlink as the same project directory", async () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-project-path-test-"));
	const agentDirectory = path.join(temporaryDirectory, "agent");
	const projectDirectory = path.join(temporaryDirectory, "project");
	const projectSymlink = path.join(temporaryDirectory, "project-link");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);
	fs.symlinkSync(projectDirectory, projectSymlink, "dir");
	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	let originHost: ExtensionHost | undefined;
	let discoveringHost: ExtensionHost | undefined;

	try {
		const { default: teamExtension } = await import("../index.ts");
		const teamName = "canonical-project-team";
		const teamId = `origin-main-session-id-${teamName}`;
		originHost = new ExtensionHost(teamExtension, makeContext("origin-main-session-id", projectDirectory));
		await originHost.start();
		await originHost.execute("team_spawn", { team: teamName, teamPrompt: "Canonical project test.", teammates: [] });
		await originHost.execute("team_shutdown", { team: teamName });

		discoveringHost = new ExtensionHost(teamExtension, makeContext("new-main-session-id", projectSymlink));
		await discoveringHost.start();
		const result = await discoveringHost.execute("team_list", {});
		assert.equal(
			listedTeam(result, teamId)?.id,
			teamId,
			`Expected the symlinked project path to discover the same team. Got: ${JSON.stringify(result.details)}`,
		);
	} finally {
		await discoveringHost?.shutdown();
		await originHost?.shutdown();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

test("a new extension session discovers a shut-down team in the same project", async () => {
	const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-registry-test-"));
	const agentDirectory = path.join(temporaryDirectory, "agent");
	const projectDirectory = path.join(temporaryDirectory, "project");
	fs.mkdirSync(agentDirectory);
	fs.mkdirSync(projectDirectory);

	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	let originHost: ExtensionHost | undefined;
	let discoveringHost: ExtensionHost | undefined;

	try {
		const { default: teamExtension } = await import("../index.ts");
		const teamName = "dormant-discovery-team";
		const teamId = `origin-main-session-id-${teamName}`;
		originHost = new ExtensionHost(teamExtension, makeContext("origin-main-session-id", projectDirectory));
		await originHost.start();
		await originHost.execute("team_spawn", { team: teamName, teamPrompt: "Registry tracer test.", teammates: [] });
		await originHost.execute("team_shutdown", { team: teamName });

		discoveringHost = new ExtensionHost(teamExtension, makeContext("new-main-session-id", projectDirectory));
		await discoveringHost.start();
		const teamListTool = discoveringHost.tools.get("team_list");
		const result = teamListTool
			? await teamListTool.execute("test-call", {}, new AbortController().signal, undefined, discoveringHost.context)
			: undefined;
		const rawTeams = result?.details?.teams;
		const listedTeams = Array.isArray(rawTeams)
			? rawTeams.filter((team): team is JsonRecord => typeof team === "object" && team !== null)
			: [];
		const dormantTeam = listedTeams.find((team) => team.id === teamId);

		assert.deepEqual(
			dormantTeam && { id: dormantTeam.id, state: dormantTeam.state },
			{ id: teamId, state: "dormant" },
			`Expected team_list in a new same-project session to discover the dormant team. Got: ${JSON.stringify(result?.details)}`,
		);
	} finally {
		await discoveringHost?.shutdown();
		await originHost?.shutdown();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
		fs.rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});

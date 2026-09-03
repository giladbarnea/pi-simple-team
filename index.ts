import * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import * as fs from "node:fs";
import http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, type ContextUsage, type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { bundledSkillsInstruction } from "./bundled-skill.ts";
import { formatContextWindowReport, requireKnownContextUsage, type KnownContextUsage } from "./context-window.ts";
import { formatScopedModelGuidance, validateTeammateModels, type ModelReference } from "./model-preflight.ts";
import { composeSystemPrompt } from "./system-prompt.ts";
import { callParent, readChildRuntimeConfig, registerChildTools } from "./child-tools.ts";
import {
	canonicalProjectDirectory,
	claimTeamLease,
	dormantManifestRetentionMilliseconds,
	listTeamManifests,
	readTeamLeaseState,
	releaseTeamLease,
	writeTeamManifest,
	type TeamLease,
	type TeamManifest,
	type TeamManifestMember,
} from "./team-registry.ts";
import { appendTeamLog, filterTeamLog, normalizeChildEvent, pageTeamLog, preview, renderTeamLogPage, type TeamLogEntry } from "./teamlog.ts";
import { renderReminderToolCall, renderReminderToolResult, renderTeamMessage, renderTeamToolCall, renderTeamToolResult, type TeamMessageDetails } from "./render.ts";
import { openTeamOverview, type TeamSnapshot } from "./team-ui.ts";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

type ThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";

type JsonRecord = Record<string, unknown>;

interface TeamStatus {
	word: string;
	phrase: string;
	updated: string;
}

interface TeammateSpec {
	name: string;
	prompt: string;
	model: string;
	thinking?: ThinkingLevel;
	inheritContext?: boolean;
	canOverseeOwnTeams?: boolean;
}

type TeammateTransport = "rpc" | "herdr";

interface TeammateState {
	name: string;
	prompt: string;
	model: string;
	thinking: ThinkingLevel;
	inheritContext: boolean;
	canOverseeOwnTeams: boolean;
	transport: TeammateTransport;
	sessionId?: string;
	sessionFile?: string;
	sessionMaterialized: boolean;
	process?: ChildProcess;
	paneId?: string;
	deliveryUrl?: string;
	ready?: Promise<void>;
	resolveReady?: () => void;
	rejectReady?: (error: Error) => void;
	alive: boolean;
	deliveryQueue: Promise<void>;
	stderr: string;
}

interface TeamState {
	owner: symbol;
	ownerPi: ExtensionAPI;
	parentPiExecutable: string;
	id?: string;
	name: string;
	projectDirectory?: string;
	showOnHerdrPanes: boolean;
	teamPrompt: string;
	mainSessionFile?: string;
	members: Map<string, TeammateState>;
	statuses: Map<string, TeamStatus>;
	created: string;
	manifest?: TeamManifest;
	lease?: TeamLease;
	log: TeamLogEntry[];
	nextLogSequence: number;
}

const teamLiteExtensionPath = fileURLToPath(import.meta.url);
const thinkingLevels = ["low", "medium", "high", "xhigh", "max"] as const;
const defaultThinkingLevel: ThinkingLevel = "xhigh";
const deliveryTimeoutMilliseconds = 30_000;
const defaultRpcShutdownGraceMilliseconds = 1_000;
const teamMessageType = "pi-simple-team";
const teams = new Map<string, TeamState>();
const callbackToken = crypto.randomBytes(24).toString("hex");
let callbackServer: http.Server | undefined;
let callbackUrl = "";

function status(word: string, phrase: string): TeamStatus {
	return { word, phrase, updated: new Date().toISOString() };
}

function compactName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Name cannot be empty");
	return trimmed;
}

function toolResult(payload: JsonRecord) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
		details: payload,
	};
}

interface CommandResult {
	stdout: string;
	stderr: string;
}

function runCommand(command: string, args: string[], timeoutMilliseconds = 30_000): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		childProcess.execFile(command, args, { timeout: timeoutMilliseconds, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(`${command} ${args.join(" ")} failed: ${error.message}${stderr.trim() ? `\n${stderr.trim()}` : ""}`));
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

async function validateHerdrAvailability(): Promise<string> {
	const tabId = process.env.HERDR_TAB_ID?.trim();
	if (!tabId) throw new Error("showOnHerdrPanes requires HERDR_TAB_ID in the main Pi process");

	let result: CommandResult;
	try {
		result = await runCommand("herdr", ["status", "--json"], 10_000);
	} catch (error) {
		throw new Error(`showOnHerdrPanes requires an available Herdr server: ${error instanceof Error ? error.message : String(error)}`);
	}

	const status = JSON.parse(result.stdout) as { server?: { running?: boolean; compatible?: boolean } };
	if (!status.server?.running || status.server.compatible === false) {
		throw new Error("showOnHerdrPanes requires a running compatible Herdr server");
	}
	return tabId;
}

function formatTeammateMessage(team: TeamState, from: string, message: string): string {
	return [`[from ${from} on team ${team.name}]`, message, "", "Current team status:", JSON.stringify(formatStatus(team), null, 2)].join("\n");
}

async function deliverMessage(team: TeamState, from: string, recipient: TeammateState, message: string, formattedMessage: string, interrupt: boolean): Promise<void> {
	if (!recipient.alive || !recipient.deliveryUrl) throw new Error(`Teammate ${recipient.name} is not ready`);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), deliveryTimeoutMilliseconds);
	try {
		const response = await fetch(recipient.deliveryUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				token: callbackToken,
				tool: "deliver",
				args: { team: team.name, from, to: recipient.name, sentAt: new Date().toISOString(), message, formattedMessage, interrupt },
			}),
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`Teammate ${recipient.name} rejected delivery: ${response.status} ${await response.text()}`);
		const result = (await response.json()) as { accepted?: boolean };
		if (!result.accepted) throw new Error(`Teammate ${recipient.name} did not accept delivery`);
		appendTeamLog(team, { team: team.name, teammate: recipient.name, direction: "runtime", kind: "ack", summary: "message accepted" });
	} catch (error) {
		if (controller.signal.aborted) throw new Error(`Timed out waiting for teammate ${recipient.name} delivery`);
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function deliverToTeammate(team: TeamState, from: string, recipient: TeammateState, message: string, interrupt: boolean): Promise<void> {
	const formattedMessage = formatTeammateMessage(team, from, message);
	appendTeamLog(team, {
		team: team.name,
		teammate: recipient.name,
		direction: from === "main" ? "main->teammate" : "teammate->teammate",
		kind: "deliver",
		summary: preview(message),
		details: { from, to: recipient.name, interrupt },
	});
	await deliverMessage(team, from, recipient, message, formattedMessage, interrupt);
}

function enqueueDelivery(team: TeamState, from: string, recipient: TeammateState, message: string, interrupt: boolean): void {
	appendTeamLog(team, {
		team: team.name,
		teammate: recipient.name,
		direction: from === "main" ? "main->teammate" : "teammate->teammate",
		kind: "send",
		summary: preview(message),
		details: { from, to: recipient.name, interrupt, message },
	});

	recipient.deliveryQueue = recipient.deliveryQueue
		.catch(() => undefined)
		.then(() => deliverToTeammate(team, from, recipient, message, interrupt))
		.catch((error) => {
			const errorMessage = error instanceof Error ? error.message : String(error);
			team.statuses.set(recipient.name, status("error", errorMessage));
			appendTeamLog(team, {
				team: team.name,
				teammate: recipient.name,
				direction: from === "main" ? "main->teammate" : "teammate->teammate",
				kind: "error",
				summary: preview(`delivery to ${recipient.name} failed: ${errorMessage}`),
				details: { from, to: recipient.name, error: errorMessage },
			});
		});
}

/** @example resolveTeamIdentifier([{ id: "main-review", name: "review" }], "review")?.id // "main-review" */
function resolveTeamIdentifier<IdentifiedTeam extends { id?: string; name: string }>(
	candidates: Iterable<IdentifiedTeam>,
	teamIdentifier: string,
): IdentifiedTeam | undefined {
	const matches = [...candidates].filter((team) => team.id === teamIdentifier || team.name === teamIdentifier);
	if (matches.length > 1) throw new Error(`Ambiguous team name: ${teamIdentifier}. Pass the persistent team ID.`);
	return matches[0];
}

function resolveTeam(owner: symbol, teamIdentifier?: string): TeamState {
	const ownedTeams = [...teams.values()].filter((team) => team.owner === owner);
	if (teamIdentifier) {
		const team = resolveTeamIdentifier(ownedTeams, teamIdentifier);
		if (!team) throw new Error(`Unknown team: ${teamIdentifier}`);
		return team;
	}

	if (ownedTeams.length === 1) return ownedTeams[0];
	if (ownedTeams.length === 0) throw new Error("No teams exist. Use team_spawn first.");
	throw new Error(`Multiple teams exist: ${ownedTeams.map((team) => team.id ?? team.name).join(", ")}. Pass team explicitly.`);
}

function resolveCallbackTeam(teamName: string): TeamState {
	const team = teams.get(teamName);
	if (!team) throw new Error(`Unknown team: ${teamName}`);
	return team;
}

function resolveRecipients(team: TeamState, recipientNames: string[]): TeammateState[] {
	const names = recipientNames.map(compactName);
	const recipients = names.map((name) => team.members.get(name));
	const missing = names.filter((name, index) => recipients[index] === undefined);
	if (missing.length > 0) throw new Error(`Unknown teammate(s) in ${team.name}: ${missing.join(", ")}`);
	return recipients as TeammateState[];
}

function resolveContextTargets(owner: symbol, targetNames: string[]): TeammateState[] {
	const ownedTeams = [...teams.values()].filter((team) => team.owner === owner);
	const names = targetNames.map(compactName).filter((name) => name !== "main");
	return names.map((name) => {
		const matches = ownedTeams.flatMap((team) => {
			const teammate = team.members.get(name);
			return teammate ? [teammate] : [];
		});
		if (matches.length === 0) throw new Error(`Unknown teammate: ${name}`);
		if (matches.length > 1) throw new Error(`Ambiguous teammate across teams: ${name}`);
		return matches[0];
	});
}

async function getTeammateContextUsage(teammate: TeammateState, signal?: AbortSignal): Promise<KnownContextUsage> {
	if (!teammate.alive || !teammate.deliveryUrl) throw new Error(`Teammate ${teammate.name} is not ready`);
	const response = await fetch(teammate.deliveryUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token: callbackToken, tool: "report_context_window", args: {} }),
		signal,
	});
	if (!response.ok) throw new Error(`Teammate ${teammate.name} rejected context-window query: ${response.status} ${await response.text()}`);
	const payload = (await response.json()) as { contextUsage?: ContextUsage };
	return requireKnownContextUsage(payload.contextUsage);
}

function formatStatus(team: TeamState): Record<string, TeamStatus> {
	return Object.fromEntries([...team.statuses.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function allStatuses(owner: symbol): Record<string, Record<string, TeamStatus>> {
	return Object.fromEntries([...teams.values()].filter((team) => team.owner === owner).map((team) => [team.name, formatStatus(team)]));
}

function ownedTeamSnapshots(owner: symbol): TeamSnapshot[] {
	return [...teams.values()]
		.filter((team) => team.owner === owner)
		.map((team) => ({
			name: team.name,
			created: team.created,
			showOnHerdrPanes: team.showOnHerdrPanes,
			roster: [...team.members.keys()],
			statuses: formatStatus(team),
			log: [...team.log],
		}));
}

function updateStatus(team: TeamState, participant: string, word?: string, phrase?: string): void {
	if (word === undefined && phrase === undefined) return;
	const previous = team.statuses.get(participant) ?? status("active", "Working");
	team.statuses.set(participant, status(word ?? previous.word, phrase ?? previous.phrase));
}

/** Pure status reads are meta-actions and stay out of the log, like teamlog reads. */
function logStatusDeclaration(team: TeamState, participant: string, word?: string, phrase?: string): void {
	if (word === undefined && phrase === undefined) return;
	appendTeamLog(team, {
		team: team.name,
		teammate: participant,
		direction: "runtime",
		kind: "status",
		summary: preview(`${word ?? ""} ${phrase ?? ""}`.trim()),
		details: { word: word ?? "", phrase: phrase ?? "" },
	});
}

function createTeammateState(team: TeamState, teammateSpec: TeammateSpec): TeammateState {
	const teammateName = compactName(teammateSpec.name);
	const thinking = teammateSpec.thinking ?? defaultThinkingLevel;
	let resolveReady: (() => void) | undefined;
	let rejectReady: ((error: Error) => void) | undefined;
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});

	return {
		name: teammateName,
		prompt: teammateSpec.prompt,
		model: teammateSpec.model,
		thinking,
		inheritContext: Boolean(teammateSpec.inheritContext),
		canOverseeOwnTeams: Boolean(teammateSpec.canOverseeOwnTeams),
		transport: team.showOnHerdrPanes ? "herdr" : "rpc",
		sessionMaterialized: false,
		ready,
		resolveReady,
		rejectReady,
		alive: true,
		deliveryQueue: Promise.resolve(),
		stderr: "",
	};
}

function childEnvironmentOverrides(team: TeamState, teammate: TeammateState, participants: string[]): Record<string, string> {
	return {
		PI_SIMPLE_TEAM_CHILD: "1",
		PI_SIMPLE_TEAM_CALLBACK_URL: callbackUrl,
		PI_SIMPLE_TEAM_CALLBACK_TOKEN: callbackToken,
		PI_SIMPLE_TEAM_TEAM: team.id ?? team.name,
		PI_SIMPLE_TEAM_TEAM_NAME: team.name,
		PI_SIMPLE_TEAM_MEMBER: teammate.name,
		PI_SIMPLE_TEAM_PARTICIPANTS: JSON.stringify(participants),
		PI_SIMPLE_TEAM_CAN_OVERSEE_OWN_TEAMS: teammate.canOverseeOwnTeams ? "1" : "0",
	};
}

function appendSpawnLog(team: TeamState, teammate: TeammateState): void {
	appendTeamLog(team, {
		team: team.name,
		teammate: teammate.name,
		direction: "runtime",
		kind: "spawn",
		summary: `spawned ${teammate.name} (model=${teammate.model}, thinking=${teammate.thinking}, context=${teammate.inheritContext ? "inherited" : "fresh"})`,
		details: { model: teammate.model, thinking: teammate.thinking, inheritContext: teammate.inheritContext, transport: teammate.transport, paneId: teammate.paneId },
	});
}

interface ChildStartOptions {
	sessionFile?: string;
	restartEmpty?: boolean;
}

function attachRpcTeammate(team: TeamState, teammate: TeammateState, participants: string[], options: ChildStartOptions): void {
	const sessionArgs = options.sessionFile
		? ["--session", options.sessionFile]
		: teammate.inheritContext && !options.restartEmpty
			? ["--fork", team.mainSessionFile!]
			: [];
	const modelArgs = options.sessionFile ? [] : ["--model", teammate.model, "--thinking", teammate.thinking];
	const args = [
		"--mode",
		"rpc",
		...sessionArgs,
		"--no-extensions",
		"-e",
		teamLiteExtensionPath,
		"--no-prompt-templates",
		"--no-themes",
		...modelArgs,
		"--system-prompt",
		composeSystemPrompt(team.name, team.teamPrompt, teammate.name, teammate.prompt, participants, teammate.canOverseeOwnTeams),
	];
	const proc = childProcess.spawn(team.parentPiExecutable, args, {
		cwd: team.projectDirectory ?? process.cwd(),
		stdio: ["pipe", "ignore", "pipe"],
		env: { ...process.env, ...childEnvironmentOverrides(team, teammate, participants) },
	});
	teammate.process = proc;
	teammate.alive = true;

	proc.stderr?.on("data", (chunk: Buffer | string) => {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		teammate.stderr += text;
		appendTeamLog(team, { team: team.name, teammate: teammate.name, direction: "runtime", kind: "stderr", summary: preview(text) });
	});
	proc.on("exit", (code, signal) => {
		teammate.alive = false;
		teammate.rejectReady?.(new Error(`${teammate.name} exited (code=${code}, signal=${signal})`));
		team.statuses.set(teammate.name, status("stopped", `Exited code=${code} signal=${signal}`));
		appendTeamLog(team, { team: team.name, teammate: teammate.name, direction: "runtime", kind: "exit", summary: `exited (code=${code}, signal=${signal})`, details: { code, signal } });
	});
	appendSpawnLog(team, teammate);
}

function parseHerdrPaneId(stdout: string, teammateName: string): string {
	const response = JSON.parse(stdout) as { result?: { agent?: { pane_id?: string } } };
	const paneId = response.result?.agent?.pane_id;
	if (!paneId) throw new Error(`herdr agent start did not return a pane for ${teammateName}`);
	return paneId;
}

async function attachHerdrTeammate(
	team: TeamState,
	teammate: TeammateState,
	participants: string[],
	herdrTabId: string,
	options: ChildStartOptions,
): Promise<void> {
	const systemPrompt = composeSystemPrompt(team.name, team.teamPrompt, teammate.name, teammate.prompt, participants, teammate.canOverseeOwnTeams);
	const environment = childEnvironmentOverrides(team, teammate, participants);
	const sessionArgs = options.sessionFile
		? ["--session", options.sessionFile]
		: teammate.inheritContext && !options.restartEmpty
			? ["--fork", team.mainSessionFile!]
			: [];
	const modelArgs = options.sessionFile ? [] : ["--model", teammate.model, "--thinking", teammate.thinking];
	const args = ["agent", "start", teammate.name, "--tab", herdrTabId, "--split", "right", "--no-focus", "--cwd", team.projectDirectory ?? process.cwd()];
	for (const [name, value] of Object.entries(environment)) {
		if (value !== undefined) args.push("--env", `${name}=${value}`);
	}
	args.push(
		"--",
		team.parentPiExecutable,
		...sessionArgs,
		"--no-extensions",
		"-e",
		teamLiteExtensionPath,
		...modelArgs,
		"--system-prompt",
		systemPrompt,
	);
	const result = await runCommand("herdr", args);
	teammate.paneId = parseHerdrPaneId(result.stdout, teammate.name);
	appendSpawnLog(team, teammate);
}

/** Every child registers its delivery runtime through the parent callback; startup completes only after registration. */
async function awaitChildRegistration(teammate: TeammateState): Promise<void> {
	let readinessTimeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			teammate.ready!,
			new Promise<never>((_, reject) => {
				readinessTimeout = setTimeout(() => reject(new Error(`Timed out waiting for teammate ${teammate.name} to register`)), 30_000);
			}),
		]);
	} catch (error) {
		teammate.rejectReady?.(error instanceof Error ? error : new Error(String(error)));
		throw error;
	} finally {
		if (readinessTimeout) clearTimeout(readinessTimeout);
	}
}

async function startTeammate(
	team: TeamState,
	teammate: TeammateState,
	participants: string[],
	herdrTabId?: string,
	startOptions: ChildStartOptions = {},
): Promise<void> {
	if (teammate.transport === "herdr") await attachHerdrTeammate(team, teammate, participants, herdrTabId!, startOptions);
	else attachRpcTeammate(team, teammate, participants, startOptions);
	await awaitChildRegistration(teammate);
}

function manifestMemberFromTeammate(teammate: TeammateState): TeamManifestMember {
	if (!teammate.sessionId || !teammate.sessionFile) {
		throw new Error(`Teammate ${teammate.name} has no reported session identity`);
	}
	if (fs.existsSync(teammate.sessionFile)) teammate.sessionMaterialized = true;
	return {
		name: teammate.name,
		prompt: teammate.prompt,
		model: teammate.model,
		thinking: teammate.thinking,
		inheritContext: teammate.inheritContext,
		canOverseeOwnTeams: teammate.canOverseeOwnTeams,
		transport: teammate.transport,
		live: teammate.alive,
		sessionId: teammate.sessionId,
		sessionFile: teammate.sessionFile,
		sessionMaterialized: teammate.sessionMaterialized,
	};
}

function persistActiveTeamManifest(team: TeamState): void {
	if (!team.manifest) return;
	const updatedAt = new Date().toISOString();
	team.manifest = {
		...team.manifest,
		members: [...team.members.values()].map(manifestMemberFromTeammate),
		state: "active",
		updatedAt,
		shutdownAt: undefined,
		expiresAt: undefined,
	};
	writeTeamManifest(team.manifest);
}

function isHerdrPaneNotFound(error: unknown): boolean {
	return error instanceof Error && error.message.includes('"code":"pane_not_found"');
}

async function closeHerdrPane(teammate: TeammateState): Promise<void> {
	if (!teammate.paneId) return;
	try {
		await runCommand("herdr", ["pane", "close", teammate.paneId], 10_000);
	} catch (error) {
		if (!isHerdrPaneNotFound(error)) throw error;
	}
	teammate.paneId = undefined;
}

async function stopRpcTeammate(teammate: TeammateState): Promise<void> {
	const processToStop = teammate.process;
	if (!processToStop || !teammate.alive) return;

	await new Promise<void>((resolve) => {
		let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
		const resolveExit = (): void => {
			if (forceKillTimeout) clearTimeout(forceKillTimeout);
			resolve();
		};
		processToStop.once("exit", resolveExit);
		processToStop.kill("SIGTERM");
		if (!teammate.canOverseeOwnTeams) {
			forceKillTimeout = setTimeout(() => processToStop.kill("SIGKILL"), defaultRpcShutdownGraceMilliseconds);
			forceKillTimeout.unref();
		}
	});
	teammate.process = undefined;
}

async function shutdownTeam(team: TeamState): Promise<string[]> {
	const errors: string[] = [];
	for (const teammate of team.members.values()) {
		if (teammate.transport === "herdr") {
			teammate.alive = false;
			try {
				await closeHerdrPane(teammate);
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
			continue;
		}
		await stopRpcTeammate(teammate);
	}
	if (team.manifest) {
		try {
			const shutdownAt = new Date().toISOString();
			team.manifest = {
				...team.manifest,
				members: [...team.members.values()].map(manifestMemberFromTeammate),
				state: "dormant",
				updatedAt: shutdownAt,
				shutdownAt,
				expiresAt: new Date(Date.parse(shutdownAt) + dormantManifestRetentionMilliseconds).toISOString(),
			};
			writeTeamManifest(team.manifest);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (team.lease) {
		try {
			releaseTeamLease(team.lease);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
		team.lease = undefined;
	}
	teams.delete(team.id ?? team.name);
	return errors;
}

function closeCallbackServerIfUnused(): void {
	if (teams.size > 0 || !callbackServer) return;
	callbackServer.close();
	callbackServer = undefined;
	callbackUrl = "";
}

async function ensureCallbackServer(): Promise<void> {
	if (callbackServer) return;

	callbackServer = http.createServer((request, response) => {
		void handleCallbackRequest(request, response);
	});

	await new Promise<void>((resolve) => {
		callbackServer!.listen(0, "127.0.0.1", () => {
			const address = callbackServer!.address();
			if (!address || typeof address === "string") throw new Error("Team callback server did not get a port");
			callbackUrl = `http://127.0.0.1:${address.port}/callback`;
			resolve();
		});
	});
}

async function readJsonBody(request: http.IncomingMessage): Promise<JsonRecord> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRecord;
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: JsonRecord): void {
	const body = JSON.stringify(payload);
	response.writeHead(statusCode, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body),
	});
	response.end(body);
}

function validateChildDeliveryUrl(rawUrl: string, teammateName: string): string {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`Invalid delivery URL for ${teammateName}`);
	}
	const port = Number(url.port);
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || !Number.isInteger(port) || port < 1 || port > 65_535 || url.pathname !== "/deliver") {
		throw new Error(`Invalid delivery URL for ${teammateName}`);
	}
	return url.toString();
}

function handleChildEvent(team: TeamState, teammate: TeammateState, event: JsonRecord): void {
	if (event.type === "session_shutdown") {
		teammate.alive = false;
		teammate.deliveryUrl = undefined;
		if (event.reason === "quit") {
			team.statuses.set(teammate.name, status("stopped", "Session shut down"));
			appendTeamLog(team, { team: team.name, teammate: teammate.name, direction: "runtime", kind: "exit", summary: "session shut down", details: { reason: event.reason } });
		}
	}
	const logInput = normalizeChildEvent(team.name, teammate.name, event);
	if (logInput) appendTeamLog(team, logInput);
}

async function handleCallbackRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
	try {
		const body = await readJsonBody(request);
		if (body.token !== callbackToken) {
			writeJson(response, 403, { error: "invalid token" });
			return;
		}

		const team = resolveCallbackTeam(String(body.team));
		const from = compactName(String(body.from));
		const tool = String(body.tool);
		const args = (body.args ?? {}) as JsonRecord;
		const teammate = team.members.get(from);

		if (tool === "register") {
			if (!teammate) throw new Error(`Unknown teammate: ${from}`);
			const url = String(args.url ?? "");
			const sessionId = args.sessionId;
			const sessionFile = args.sessionFile;
			if (typeof sessionId !== "string" || typeof sessionFile !== "string" || !path.isAbsolute(sessionFile)) {
				throw new Error(`Teammate ${from} reported an invalid session identity`);
			}
			try {
				teammate.deliveryUrl = validateChildDeliveryUrl(url, from);
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				teammate.rejectReady?.(failure);
				throw failure;
			}
			teammate.sessionId = sessionId;
			teammate.sessionFile = sessionFile;
			teammate.sessionMaterialized = fs.existsSync(sessionFile);
			teammate.alive = true;
			team.statuses.set(teammate.name, status("idle", "Spawned"));
			teammate.resolveReady?.();
			writeJson(response, 200, { accepted: true, team: team.name, from });
			return;
		}

		if (tool === "event") {
			if (!teammate) throw new Error(`Unknown teammate: ${from}`);
			handleChildEvent(team, teammate, (args.event ?? {}) as JsonRecord);
			writeJson(response, 200, { accepted: true, team: team.name, from });
			return;
		}

		if (tool === "team_context") {
			if (!teammate) throw new Error(`Unknown teammate: ${from}`);
			writeJson(response, 200, {
				team: team.name,
				from,
				participants: [...team.members.keys()],
				status: formatStatus(team),
			});
			return;
		}

		if (tool === "teamsend") {
			const recipients = resolveRecipients(team, (args.to ?? []) as string[]);
			const message = String(args.message ?? "");
			const interrupt = Boolean(args.interrupt);
			for (const recipient of recipients) enqueueDelivery(team, from, recipient, message, interrupt);
			writeJson(response, 200, { accepted: true, team: team.name, from, to: recipients.map((recipient) => recipient.name), interrupt });
			return;
		}

		if (tool === "teammain") {
			const rawMessage = String(args.message ?? "");
			const details: TeamMessageDetails = { team: team.name, from, sentAt: new Date().toISOString(), message: rawMessage };
			appendTeamLog(team, {
				team: team.name,
				teammate: from,
				direction: "teammate->main",
				kind: "main_message",
				summary: preview(rawMessage),
				details: { from, to: "main", message: rawMessage },
			});
			team.ownerPi.sendMessage(
				{ customType: teamMessageType, content: `[${team.name}/${from}] ${rawMessage}`, display: true, details },
				{ deliverAs: "steer", triggerTurn: true },
			);
			writeJson(response, 200, { accepted: true, team: team.name, from, to: "main" });
			return;
		}

		if (tool === "teamstatus") {
			const gerund = args.gerund as string | undefined;
			const phrase = args.phrase as string | undefined;
			updateStatus(team, from, gerund, phrase);
			logStatusDeclaration(team, from, gerund, phrase);
			writeJson(response, 200, { team: team.name, status: formatStatus(team) });
			return;
		}

		writeJson(response, 400, { error: `unknown tool: ${tool}` });
	} catch (error) {
		writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
	}
}

function teammateSchema(modelGuidance: string) {
	return Type.Object({
		name: Type.String({ description: "Teammate name" }),
		prompt: Type.String({ description: "Individual teammate system prompt" }),
		model: Type.String({ description: `Canonical provider/model id for this teammate. ${modelGuidance}` }),
		thinking: Type.Optional(StringEnum(thinkingLevels, { description: "Thinking level for this teammate. Defaults to xhigh.", default: defaultThinkingLevel })),
		inheritContext: Type.Optional(Type.Boolean({ description: "Start from a fork of main's persisted session. The fork is taken during asynchronous child startup. Defaults to false.", default: false })),
		canOverseeOwnTeams: Type.Optional(Type.Boolean({ description: "Allow this teammate to create and manage teams of its own. Defaults to false.", default: false })),
	});
}

function restoreTeamState(owner: symbol, ownerPi: ExtensionAPI, parentPiExecutable: string, manifest: TeamManifest, lease: TeamLease): TeamState {
	const team: TeamState = {
		owner,
		ownerPi,
		parentPiExecutable,
		id: manifest.id,
		name: manifest.name,
		projectDirectory: manifest.projectDirectory,
		showOnHerdrPanes: false,
		teamPrompt: manifest.teamPrompt,
		members: new Map(),
		statuses: new Map([["main", status("available", "Main agent")]]),
		created: manifest.createdAt,
		manifest,
		lease,
		log: [],
		nextLogSequence: 1,
	};
	for (const member of manifest.members) {
		const teammate = createTeammateState(team, {
			name: member.name,
			prompt: member.prompt,
			model: member.model,
			thinking: member.thinking as ThinkingLevel,
			inheritContext: member.inheritContext,
			canOverseeOwnTeams: Boolean(member.canOverseeOwnTeams),
		});
		teammate.transport = "rpc";
		teammate.sessionId = member.sessionId;
		teammate.sessionFile = member.sessionFile;
		teammate.sessionMaterialized = member.sessionMaterialized;
		teammate.alive = false;
		team.members.set(teammate.name, teammate);
		team.statuses.set(teammate.name, status("stopped", "Dormant"));
	}
	return team;
}

function prepareTeammateStart(teammate: TeammateState, transport: TeammateTransport): void {
	teammate.transport = transport;
	teammate.ready = new Promise<void>((resolve, reject) => {
		teammate.resolveReady = resolve;
		teammate.rejectReady = reject;
	});
}

function sessionFileForResume(teammate: TeammateState): string | undefined {
	if (!teammate.sessionFile) throw new Error(`Teammate ${teammate.name} has no reported session file`);
	if (fs.existsSync(teammate.sessionFile)) return teammate.sessionFile;
	if (teammate.sessionMaterialized) {
		throw new Error(`Materialized session file for ${teammate.name} is missing: ${teammate.sessionFile}`);
	}
	// This empty restart becomes redundant when team creation wakes every teammate and guarantees session persistence.
	return undefined;
}

export default function (pi: ExtensionAPI) {
	const childRuntimeConfig = readChildRuntimeConfig();
	if (childRuntimeConfig) {
		registerChildTools(pi, childRuntimeConfig);
		if (!childRuntimeConfig.canOverseeOwnTeams) return;
	}

	const parentPiExecutable = process.argv[1];
	if (!parentPiExecutable) throw new Error("pi-simple-team could not locate the parent Pi executable");
	const owner = Symbol("pi-simple-team-owner");
	const reminderTimers = new Set<ReturnType<typeof setTimeout>>();
	const sessionTeammateRoster = childRuntimeConfig?.participants ?? [];
	pi.registerMessageRenderer(teamMessageType, (message, _options, theme) => renderTeamMessage(message, theme, getMarkdownTheme(), sessionTeammateRoster));

	pi.registerCommand("team", {
		description: "Open a read-only team overview",
		handler: async (_args, context) => {
			await openTeamOverview(context, () => ownedTeamSnapshots(owner));
		},
	});

	pi.on("session_shutdown", async () => {
		for (const timer of reminderTimers) clearTimeout(timer);
		reminderTimers.clear();
		for (const team of [...teams.values()]) {
			if (team.owner === owner) await shutdownTeam(team);
		}
		closeCallbackServerIfUnused();
	});

	pi.on("session_start", (_event, context) => {
		const scopedModels = (context as typeof context & { scopedModels?: ReadonlyArray<{ model: ModelReference }> }).scopedModels ?? [];
		const modelGuidance = formatScopedModelGuidance(scopedModels.map(({ model }) => model));
		pi.registerTool(
			defineTool({
				name: "team_spawn",
				label: "Team Spawn",
				description: `Spawn a persistent team of Pi teammates. Teammates start with fresh context windows unless \`inheritContext\` is true. If the user is interested, set \`showOnHerdrPanes\` to run each teammate in a visible Herdr pane. The main agent (you) is included automatically; do not specify it as a teammate. ${modelGuidance}`,
				promptSnippet: `Spawn persistent Pi teammates. ${modelGuidance} Unless required, don’t fill up your time by repeatedly busy-polling team information. Don’t bash sleep to wait for progress; instead, set your status to advertise that you are counting on teammates to send you important milestones or requests for help, and that otherwise you are staying idle. Send this actively to the team. Then end your turn by sending a simple message to the user, and finally stay put.`,
				renderShell: "self",
				renderCall: (args, theme, context) => renderTeamToolCall("team_spawn", args, theme, context, sessionTeammateRoster),
				renderResult: (result, options, theme, context) => renderTeamToolResult("team_spawn", result, options, theme, context, undefined, sessionTeammateRoster),
				parameters: Type.Object({
					team: Type.String({ description: "Team name" }),
					teamPrompt: Type.String({ description: "Common team system prompt" }),
					teammates: Type.Array(teammateSchema(modelGuidance), { description: "Teammates to spawn" }),
					showOnHerdrPanes: Type.Optional(Type.Boolean({ default: false })),
				}),
				async execute(_toolCallId, params, _signal, _onUpdate, context) {
					const teamName = compactName(params.team);
					const showOnHerdrPanes = Boolean(params.showOnHerdrPanes);
					const herdrTabId = showOnHerdrPanes ? await validateHerdrAvailability() : undefined;

					const teammateSpecs = params.teammates as TeammateSpec[];
					const teammateNames = teammateSpecs.map((teammate) => compactName(teammate.name));
					const duplicateNames = teammateNames.filter((name, index) => teammateNames.indexOf(name) !== index);
					if (duplicateNames.length > 0) throw new Error(`Duplicate teammate name(s): ${[...new Set(duplicateNames)].join(", ")}`);
					if (teammateNames.includes("main")) throw new Error('"main" is reserved');

					validateTeammateModels(teammateSpecs, context.modelRegistry.getAvailable());
					const inheritsMainContext = teammateSpecs.some((teammate) => Boolean(teammate.inheritContext));
					const mainSessionFile = inheritsMainContext ? context.sessionManager.getSessionFile() : undefined;
					if (inheritsMainContext && !mainSessionFile) throw new Error("inheritContext requires a persistent main session");
					const originMainSessionId = context.sessionManager?.getSessionId?.();
					const rawProjectDirectory = context.sessionManager?.getCwd?.() ?? context.cwd;
					const projectDirectory = rawProjectDirectory ? canonicalProjectDirectory(rawProjectDirectory) : undefined;
					const teamId = originMainSessionId && projectDirectory ? `${originMainSessionId}-${teamName}` : undefined;
					const runtimeTeamId = teamId ?? teamName;
					if (teams.has(runtimeTeamId)) throw new Error(`Team already exists: ${runtimeTeamId}`);
					const lease = teamId ? claimTeamLease(teamId, originMainSessionId) : undefined;
					if (teamId && projectDirectory && listTeamManifests(projectDirectory).some((manifest) => manifest.id === teamId)) {
						releaseTeamLease(lease!);
						throw new Error(`Team already exists: ${teamId}. Use team_resume.`);
					}
					sessionTeammateRoster.push(...teammateNames.filter((teammateName) => !sessionTeammateRoster.includes(teammateName)));
					try {
						await ensureCallbackServer();
					} catch (error) {
						if (lease) releaseTeamLease(lease);
						throw error;
					}

					const team: TeamState = {
						owner,
						ownerPi: pi,
						parentPiExecutable,
						id: teamId,
						name: teamName,
						projectDirectory,
						showOnHerdrPanes,
						teamPrompt: params.teamPrompt,
						mainSessionFile,
						members: new Map(),
						statuses: new Map([["main", status("available", "Main agent")]]),
						created: new Date().toISOString(),
						lease,
						log: [],
						nextLogSequence: 1,
					};

					teams.set(runtimeTeamId, team);
					try {
						for (const teammateSpec of teammateSpecs) {
							const teammate = createTeammateState(team, teammateSpec);
							team.members.set(teammate.name, teammate);
							team.statuses.set(teammate.name, status("idle", "Spawned"));
							await startTeammate(team, teammate, teammateNames, herdrTabId);
						}

						if (teamId && originMainSessionId && projectDirectory) {
							const timestamp = new Date().toISOString();
							const manifest: TeamManifest = {
								version: 1,
								id: teamId,
								name: team.name,
								originMainSessionId,
								projectDirectory,
								teamPrompt: team.teamPrompt,
								showOnHerdrPanes: team.showOnHerdrPanes,
								members: [...team.members.values()].map(manifestMemberFromTeammate),
								state: "active",
								createdAt: timestamp,
								updatedAt: timestamp,
							};
							writeTeamManifest(manifest);
							team.manifest = manifest;
						}
					} catch (error) {
						await shutdownTeam(team);
						closeCallbackServerIfUnused();
						throw error;
					}
					return toolResult({
						accepted: true,
						id: team.id,
						team: team.name,
						teammates: [...team.members.keys()],
						sessions: Object.fromEntries(
							[...team.members.values()]
								.filter((teammate) => teammate.sessionId && teammate.sessionFile)
								.map((teammate) => [teammate.name, { sessionId: teammate.sessionId, sessionFile: teammate.sessionFile }]),
						),
						status: formatStatus(team),
						instruction: bundledSkillsInstruction,
					});
				},
			}),
		);
	});

	pi.registerTool(
		defineTool({
			name: "schedule_reminder",
			label: "Schedule Reminder",
			description: "Set yourself a one-shot reminder that wakes you with a custom message after a specified number of minutes.",
			promptSnippet: "Use schedule_reminder as a safety net for team oversight if delegates do not wake you proactively. Ask whether the user wants periodic checks, such as every 30 minutes. Recommend this safety net more strongly as the expected run time grows, especially for multi-hour unattended work. For periodic checks, schedule the next reminder after each check.",
			renderShell: "self",
			renderCall: (args, theme, context) => renderReminderToolCall(args, theme, context),
			renderResult: (result, options, theme, context) => renderReminderToolResult(result, options, theme, context),
			parameters: Type.Object({
				delayMinutes: Type.Number({ exclusiveMinimum: 0, maximum: 35_791, description: "Minutes until the reminder" }),
				message: Type.String({ minLength: 1, description: "Custom message that wakes you" }),
			}),
			async execute(_toolCallId, params) {
				const delayMilliseconds = params.delayMinutes * 60_000;
				const scheduledAt = new Date(Date.now() + delayMilliseconds).toISOString();
				const timer = setTimeout(() => {
					reminderTimers.delete(timer);
					pi.sendMessage(
						{ customType: "pi-simple-team-reminder", content: params.message, display: false },
						{ deliverAs: "followUp", triggerTurn: true },
					);
				}, delayMilliseconds);
				reminderTimers.add(timer);
				timer.unref();
				return toolResult({ scheduledAt, message: params.message });
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "team_list",
			label: "Team List",
			description: childRuntimeConfig
				? "List active and dormant teams created by this overseeing teammate."
				: "List active and dormant teams for the current project.",
			promptSnippet: "List teams for the current project",
			renderShell: "self",
			renderCall: (_args, theme, context) => renderTeamToolCall("team_list", {}, theme, context, sessionTeammateRoster),
			renderResult: (result, options, theme, context) => renderTeamToolResult("team_list", result, options, theme, context, undefined, sessionTeammateRoster),
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal, _onUpdate, context) {
				const projectDirectory = context.sessionManager?.getCwd?.() ?? context.cwd;
				if (!projectDirectory) throw new Error("team_list requires a project directory");
				const managerSessionId = childRuntimeConfig ? context.sessionManager?.getSessionId?.() : undefined;
				if (childRuntimeConfig && !managerSessionId) throw new Error("team_list requires a persistent overseeing teammate session");
				const manifests = listTeamManifests(projectDirectory).filter(
					(manifest) => !managerSessionId || manifest.originMainSessionId === managerSessionId,
				);
				return toolResult({
					teams: manifests.map((manifest) => {
						const liveTeam = teams.get(manifest.id);
						return {
							id: manifest.id,
							name: manifest.name,
							state: manifest.state,
							leaseState: readTeamLeaseState(manifest.id).state,
							teammates: manifest.members.map((member) => member.name),
							members: manifest.members.map((member) => ({
								name: member.name,
								live: liveTeam?.members.get(member.name)?.alive ?? member.live,
								canOverseeOwnTeams: Boolean(member.canOverseeOwnTeams),
								sessionId: member.sessionId,
								sessionFile: member.sessionFile,
							})),
							createdAt: manifest.createdAt,
							updatedAt: manifest.updatedAt,
							shutdownAt: manifest.shutdownAt,
							expiresAt: manifest.expiresAt,
						};
					}),
				});
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "team_resume",
			label: "Team Resume",
			description: childRuntimeConfig
				? "Resume all or selected stopped members of a dormant team created by this overseeing teammate."
				: "Resume all stopped teammates in a dormant current-project team, or only selected stopped teammates.",
			promptSnippet: "Resume all or selected stopped teammates",
			renderShell: "self",
			renderCall: (args, theme, context) => renderTeamToolCall("team_resume", args, theme, context, sessionTeammateRoster),
			renderResult: (result, options, theme, context) => renderTeamToolResult("team_resume", result, options, theme, context, undefined, sessionTeammateRoster),
			parameters: Type.Object({
				team: Type.String({ description: "Team name or persistent ID" }),
				teammates: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Stopped teammate names. Omit to resume all stopped teammates." })),
				showOnHerdrPanes: Type.Optional(Type.Boolean({ default: false, description: "Resume selected teammates in visible Herdr panes. Defaults to RPC." })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, context) {
				const rawProjectDirectory = context.sessionManager?.getCwd?.() ?? context.cwd;
				if (!rawProjectDirectory) throw new Error("team_resume requires a project directory");
				const managerSessionId = childRuntimeConfig ? context.sessionManager?.getSessionId?.() : undefined;
				if (childRuntimeConfig && !managerSessionId) throw new Error("team_resume requires a persistent overseeing teammate session");
				const availableManifests = listTeamManifests(rawProjectDirectory).filter(
					(candidate) => !managerSessionId || candidate.originMainSessionId === managerSessionId,
				);
				const manifest = resolveTeamIdentifier(availableManifests, params.team);
				if (!manifest) throw new Error(`Unknown current-project team: ${params.team}`);
				const requestedNames = params.teammates?.map(compactName) ?? manifest.members.map((member) => member.name);
				const duplicateNames = requestedNames.filter((name, index) => requestedNames.indexOf(name) !== index);
				if (duplicateNames.length > 0) throw new Error(`Duplicate teammate name(s): ${[...new Set(duplicateNames)].join(", ")}`);
				const manifestMemberNames = new Set(manifest.members.map((member) => member.name));
				const missingNames = requestedNames.filter((name) => !manifestMemberNames.has(name));
				if (missingNames.length > 0) throw new Error(`Unknown teammate(s) in ${manifest.name}: ${missingNames.join(", ")}`);
				const showOnHerdrPanes = Boolean(params.showOnHerdrPanes);
				const herdrTabId = showOnHerdrPanes ? await validateHerdrAvailability() : undefined;

				const existingTeam = [...teams.values()].find((candidate) => candidate.id === manifest.id);
				if (existingTeam && existingTeam.owner !== owner) {
					throw new Error(`Team ${manifest.id} is already owned by another main session`);
				}

				let team = existingTeam;
				if (!team) {
					const mainSessionId = context.sessionManager?.getSessionId?.();
					if (!mainSessionId) throw new Error("team_resume requires a persistent main session");
					const lease = claimTeamLease(manifest.id, mainSessionId);
					try {
						await ensureCallbackServer();
						team = restoreTeamState(owner, pi, parentPiExecutable, manifest, lease);
						teams.set(team.id!, team);
					} catch (error) {
						releaseTeamLease(lease);
						closeCallbackServerIfUnused();
						throw error;
					}
				}

				const teammates = requestedNames.map((name) => team.members.get(name)!).filter((teammate) => !teammate.alive);
				let starts: Array<{ teammate: TeammateState; sessionFile: string | undefined }>;
				try {
					starts = teammates.map((teammate) => ({ teammate, sessionFile: sessionFileForResume(teammate) }));
				} catch (error) {
					if (!existingTeam) {
						await shutdownTeam(team);
						closeCallbackServerIfUnused();
					}
					throw error;
				}
				const participantNames = [...team.members.keys()];
				sessionTeammateRoster.push(...participantNames.filter((name) => !sessionTeammateRoster.includes(name)));

				try {
					for (const { teammate, sessionFile } of starts) {
						prepareTeammateStart(teammate, showOnHerdrPanes ? "herdr" : "rpc");
						await startTeammate(team, teammate, participantNames, herdrTabId, {
							sessionFile,
							restartEmpty: sessionFile === undefined,
						});
						team.statuses.set(teammate.name, status("idle", "Resumed"));
					}
					persistActiveTeamManifest(team);
				} catch (error) {
					if (!existingTeam) {
						await shutdownTeam(team);
						closeCallbackServerIfUnused();
						throw error;
					}
					for (const { teammate } of starts) {
						if (teammate.transport === "herdr") {
							teammate.alive = false;
							await closeHerdrPane(teammate);
						} else {
							await stopRpcTeammate(teammate);
						}
						team.statuses.set(teammate.name, status("stopped", "Resume failed"));
					}
					throw error;
				}

				return toolResult({
					accepted: true,
					id: team.id,
					team: team.name,
					teammates: [...team.members.keys()],
					resumed: starts.map(({ teammate }) => teammate.name),
					restartedEmpty: starts.filter(({ sessionFile }) => sessionFile === undefined).map(({ teammate }) => teammate.name),
					sessions: Object.fromEntries(
						starts.map(({ teammate }) => [teammate.name, { sessionId: teammate.sessionId, sessionFile: teammate.sessionFile }]),
					),
				});
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "team_add",
			label: "Team Add",
			description: "Add one or more new RPC teammates to a running team owned by this main session.",
			promptSnippet: "Add new teammates to a running team",
			renderShell: "self",
			renderCall: (args, theme, context) => renderTeamToolCall("team_add", args, theme, context, sessionTeammateRoster),
			renderResult: (result, options, theme, context) => renderTeamToolResult("team_add", result, options, theme, context, undefined, sessionTeammateRoster),
			parameters: Type.Object({
				team: Type.String({ description: "Team name or persistent ID" }),
				teammates: Type.Array(teammateSchema(""), { minItems: 1, description: "New teammates to add" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, context) {
				const team = resolveTeamIdentifier(
					[...teams.values()].filter((candidate) => candidate.owner === owner),
					params.team,
				);
				if (!team || !team.manifest || !team.lease || team.manifest.state !== "active") {
					throw new Error(`team_add requires a running team owned by this main session: ${params.team}`);
				}

				const teammateSpecs = params.teammates as TeammateSpec[];
				const teammateNames = teammateSpecs.map((teammate) => compactName(teammate.name));
				const duplicateNames = teammateNames.filter(
					(name, index) => teammateNames.indexOf(name) !== index || team.members.has(name),
				);
				if (duplicateNames.length > 0) {
					throw new Error(`Duplicate teammate name(s): ${[...new Set(duplicateNames)].join(", ")}`);
				}
				if (teammateNames.includes("main")) throw new Error('"main" is reserved');
				validateTeammateModels(teammateSpecs, context.modelRegistry.getAvailable());

				const inheritsMainContext = teammateSpecs.some((teammate) => Boolean(teammate.inheritContext));
				const mainSessionFile = inheritsMainContext ? context.sessionManager.getSessionFile() : undefined;
				if (inheritsMainContext && !mainSessionFile) throw new Error("inheritContext requires a persistent main session");
				if (mainSessionFile) team.mainSessionFile = mainSessionFile;

				const addedTeammates = teammateSpecs.map((teammateSpec) => createTeammateState(team, teammateSpec));
				for (const teammate of addedTeammates) {
					teammate.transport = "rpc";
					team.members.set(teammate.name, teammate);
					team.statuses.set(teammate.name, status("idle", "Spawned"));
				}
				const participantNames = [...team.members.keys()];
				sessionTeammateRoster.push(...teammateNames.filter((name) => !sessionTeammateRoster.includes(name)));

				try {
					for (const teammate of addedTeammates) await startTeammate(team, teammate, participantNames);
					persistActiveTeamManifest(team);
				} catch (error) {
					for (const teammate of addedTeammates) await stopRpcTeammate(teammate);
					for (const teammate of addedTeammates) {
						team.members.delete(teammate.name);
						team.statuses.delete(teammate.name);
					}
					throw error;
				}

				return toolResult({
					accepted: true,
					id: team.id,
					team: team.name,
					added: teammateNames,
					sessions: Object.fromEntries(
						addedTeammates.map((teammate) => [teammate.name, { sessionId: teammate.sessionId, sessionFile: teammate.sessionFile }]),
					),
					status: formatStatus(team),
				});
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "teamsend",
			label: "Team Send",
			description: childRuntimeConfig
				? "Send to parent-team peers when team is omitted, or to teammates in an owned team when team is set. Fire-and-forget; does not wait for replies."
				: "Send a message from main to teammate(s). Fire-and-forget; does not wait for replies. Teammates will send you messages as they deem appropriate by way of push.",
			promptSnippet: "Send a message from main to teammate(s)",
			renderShell: "self",
			renderCall: (args, theme, context) => renderTeamToolCall("teamsend", args, theme, context, sessionTeammateRoster),
			renderResult: (result, options, theme, context) => renderTeamToolResult("teamsend", result, options, theme, context, getMarkdownTheme(), sessionTeammateRoster),
			parameters: Type.Object({
				team: Type.Optional(Type.String({ description: childRuntimeConfig ? "Owned team name. Omit to use the parent team." : "Team name; optional only when exactly one team exists" })),
				to: Type.Array(Type.String(), { description: "Recipient teammate names" }),
				message: Type.String({ description: "Message to send" }),
				interrupt: Type.Optional(Type.Boolean({ description: "Abort busy recipients before delivery" })),
			}),
			async execute(_toolCallId, params, signal) {
				if (childRuntimeConfig && !params.team) {
					return toolResult(await callParent(childRuntimeConfig, "teamsend", {
						to: params.to,
						message: params.message,
						...(params.interrupt === undefined ? {} : { interrupt: params.interrupt }),
					}, signal));
				}
				const team = resolveTeam(owner, params.team);
				const recipients = resolveRecipients(team, params.to);
				const interrupt = Boolean(params.interrupt);
				for (const recipient of recipients) enqueueDelivery(team, "main", recipient, params.message, interrupt);
				return toolResult({ accepted: true, team: team.name, from: "main", to: recipients.map((recipient) => recipient.name), interrupt });
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "teamstatus",
			label: "Team Status",
			description: childRuntimeConfig
				? "Set or read parent-team status when team is omitted. Set or read an owned team's status when team is set."
				: "Set main's status for a team and/or read team statuses.",
			promptSnippet: "Set/read team status maps",
			renderShell: "self",
			renderCall: (args, theme, context) => renderTeamToolCall("teamstatus", args, theme, context, sessionTeammateRoster),
			renderResult: (result, options, theme, context) => renderTeamToolResult("teamstatus", result, options, theme, context, undefined, sessionTeammateRoster),
			parameters: Type.Object({
				team: Type.Optional(Type.String({ description: childRuntimeConfig ? "Owned team name. Omit to use the parent team." : "Team name; optional for listing all statuses or when exactly one team exists" })),
				// TODO: make gerund and phrase optionality a XOR.
				gerund: Type.Optional(Type.String({ description: "Set one-word gerund main status" })),
				phrase: Type.Optional(Type.String({ description: "Short main status verb-oriented phrase." })),
			}),
			async execute(_toolCallId, params, signal) {
				if (childRuntimeConfig && !params.team) {
					return toolResult(await callParent(childRuntimeConfig, "teamstatus", {
						...(params.gerund === undefined ? {} : { gerund: params.gerund }),
						...(params.phrase === undefined ? {} : { phrase: params.phrase }),
					}, signal));
				}
				if (!params.team && params.gerund === undefined && params.phrase === undefined) {
					return toolResult({ teams: allStatuses(owner) });
				}
				const team = resolveTeam(owner, params.team);
				updateStatus(team, "main", params.gerund, params.phrase);
				logStatusDeclaration(team, "main", params.gerund, params.phrase);
				return toolResult({ team: team.name, status: formatStatus(team) });
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "report_context_window",
			label: "Report Context Window",
			description: childRuntimeConfig
				? "Report your own context-window use when targets is omitted. When targets is present, report selected teammates in owned teams and yourself last."
				: "Report context-window use for selected teammates and main. Main's report is always last.",
			promptSnippet: "Report context-window use for selected teammates and main",
			parameters: Type.Object({
				targets: childRuntimeConfig
					? Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Owned-team teammate names. Omit to report only yourself." }))
					: Type.Array(Type.String({ minLength: 1 }), { description: "Teammate names. Use an empty list to report only main." }),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, context) {
				if (params.targets === undefined) {
					const text = formatContextWindowReport("You have", requireKnownContextUsage(context.getContextUsage()));
					return { content: [{ type: "text" as const, text }], details: {} };
				}
				const teammates = resolveContextTargets(owner, params.targets);
				const reports = await Promise.all(
					teammates.map(async (teammate) => formatContextWindowReport(`Teammate ${teammate.name} has`, await getTeammateContextUsage(teammate, signal))),
				);
				reports.push(formatContextWindowReport("You have", requireKnownContextUsage(context.getContextUsage())));
				return { content: [{ type: "text" as const, text: reports.join("\n") }], details: {} };
			},
		}),
	);

	// TODO: main could use more automatic meta/discoverability information in the return payload. To help orient around what has been read already, what hasn't been read, inside and outside the filtered space, how long is the log, etc.
	pi.registerTool(
		defineTool({
			name: "teamlog",
			label: "Team Log",
			description: "Inspect a compact, paged, filterable event log for a pi-simple-team team.",
			promptSnippet: "Inspect team event log",
			renderShell: "self",
			renderCall: (args, theme, context) => renderTeamToolCall("teamlog", args, theme, context, sessionTeammateRoster),
			renderResult: (result, options, theme, context) => renderTeamToolResult("teamlog", result, options, theme, context, undefined, sessionTeammateRoster),
			parameters: Type.Object({
				team: Type.Optional(Type.String({ description: "Team name; optional only when exactly one team exists" })),
				teammate: Type.Optional(Type.String({ description: "Filter to one teammate name" })),
				kind: Type.Optional(
					Type.Array(Type.String({ minLength: 1 }), {
						minItems: 1,
						description: "Filter to any of these normalized event kinds",
					}),
				),
				search: Type.Optional(Type.String({ description: "Case-insensitive substring search over summary, teammate, direction, kind, and details" })),
				since: Type.Optional(Type.String({ description: "ISO timestamp filter; only entries at or after this time" })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max rows to return, default 20, maximum 100" })),
				cursor: Type.Optional(Type.String({ description: 'Opaque cursor from a previous response, e.g. "before:54"' })),
			}),
			async execute(_toolCallId, params) {
				const team = resolveTeam(owner, params.team);
				const filtered = filterTeamLog(team.log, {
					teammate: params.teammate,
					kind: params.kind,
					search: params.search,
					since: params.since,
				});
				const page = pageTeamLog(filtered, { limit: params.limit, cursor: params.cursor });
				const text = renderTeamLogPage({ team: team.name, ...page });

				return {
					content: [{ type: "text" as const, text }],
					details: {
						team: team.name,
						roster: [...team.members.keys()],
						entries: page.entries,
						totalMatched: page.totalMatched,
						returned: page.returned,
						nextCursor: page.nextCursor,
						filters: {
							teammate: params.teammate,
							kind: params.kind,
							search: params.search,
							since: params.since,
							limit: page.limit,
							cursor: params.cursor,
						},
					},
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "team_shutdown",
			label: "Team Shutdown",
			description: "Stop a team and kill its teammate processes.",
			promptSnippet: "Stop a team and kill its teammate processes",
			renderShell: "self",
			renderCall: (args, theme, context) => renderTeamToolCall("team_shutdown", args, theme, context, sessionTeammateRoster),
			renderResult: (result, options, theme, context) => renderTeamToolResult("team_shutdown", result, options, theme, context, undefined, sessionTeammateRoster),
			parameters: Type.Object({
				team: Type.Optional(Type.String({ description: "Team name; optional only when exactly one team exists" })),
			}),
			async execute(_toolCallId, params) {
				const team = resolveTeam(owner, params.team);
				const teammates = [...team.members.keys()];
				const errors = await shutdownTeam(team);
				closeCallbackServerIfUnused();
				if (errors.length > 0) throw new Error(`Failed to close Herdr teammate pane(s): ${errors.join("; ")}`);
				return toolResult({ stopped: true, team: team.name, teammates });
			},
		}),
	);
}

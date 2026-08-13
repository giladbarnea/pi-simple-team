import * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import * as fs from "node:fs";
import http from "node:http";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { defineTool, type ContextUsage, type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { bundledAiToAiSkillInstruction } from "./bundled-skill.ts";
import { formatContextWindowReport, requireKnownContextUsage, type KnownContextUsage } from "./context-window.ts";
import { formatScopedModelGuidance, validateTeammateModels, type ModelReference } from "./model-preflight.ts";
import { composeSystemPrompt } from "./system-prompt.ts";
import { readChildRuntimeConfig, registerChildTools } from "./child-tools.ts";
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
import { appendTeamLog, filterTeamLog, normalizeChildEvent, nowText, pageTeamLog, preview, renderTeamLogPage, type TeamLogEntry } from "./teamlog.ts";
import { renderTeamMessage, renderTeamToolCall, renderTeamToolResult, type TeamMessageDetails } from "./render.ts";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

type ThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";

type JsonRecord = Record<string, unknown>;

interface TeamStatus {
	word: string;
	phrase: string;
	updated: string;
}

interface RpcResponse extends JsonRecord {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	error?: string;
	data?: unknown;
}

interface PendingRequest {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

interface TeammateSpec {
	name: string;
	prompt: string;
	model: string;
	thinking?: ThinkingLevel;
	inheritContext?: boolean;
}

type TeammateTransport = "rpc" | "herdr";

interface TeammateState {
	name: string;
	prompt: string;
	model: string;
	thinking: ThinkingLevel;
	inheritContext: boolean;
	transport: TeammateTransport;
	sessionId?: string;
	sessionFile?: string;
	sessionMaterialized: boolean;
	process?: ChildProcess;
	paneId?: string;
	visibleUrl?: string;
	visibleReady?: Promise<void>;
	resolveVisibleReady?: () => void;
	rejectVisibleReady?: (error: Error) => void;
	busy: boolean;
	alive: boolean;
	pendingRequests: Map<string, PendingRequest>;
	deliveryQueue: Promise<void>;
	recentEvents: JsonRecord[];
	stderr: string;
}

interface TeamState {
	owner: symbol;
	ownerPi: ExtensionAPI;
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
const visibleDeliveryTimeoutMilliseconds = 30_000;
const teamMessageType = "pi-simple-team";
const teams = new Map<string, TeamState>();
const callbackToken = crypto.randomBytes(24).toString("hex");
let callbackServer: http.Server | undefined;
let callbackUrl = "";
let requestCounter = 0;

function status(word: string, phrase: string): TeamStatus {
	return { word, phrase, updated: nowText() };
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

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

function attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	stream.on("data", (chunk: Buffer | string) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;

			let line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			onLine(line);
		}
	});

	stream.on("end", () => {
		buffer += decoder.end();
		if (buffer.length > 0) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
	});
}

function pushRecentEvent(teammate: TeammateState, event: JsonRecord): void {
	teammate.recentEvents.push(event);
	if (teammate.recentEvents.length > 200) teammate.recentEvents.shift();
}

function rejectPendingRequests(teammate: TeammateState, error: Error): void {
	for (const pending of teammate.pendingRequests.values()) {
		clearTimeout(pending.timeout);
		pending.reject(error);
	}
	teammate.pendingRequests.clear();
}

function handleTeammateEvent(team: TeamState, teammate: TeammateState, event: JsonRecord): void {
	pushRecentEvent(teammate, event);

	if (event.type === "agent_start") teammate.busy = true;
	if (event.type === "agent_end") teammate.busy = false;

	const logInput = normalizeChildEvent(team.name, teammate.name, event);
	if (logInput) appendTeamLog(team, logInput);

	if (event.type !== "response") return;
	const response = event as RpcResponse;
	const requestId = response.id;
	if (!requestId) return;

	const pending = teammate.pendingRequests.get(requestId);
	if (!pending) return;

	teammate.pendingRequests.delete(requestId);
	clearTimeout(pending.timeout);
	pending.resolve(response);
}

function sendRpc(teammate: TeammateState, command: JsonRecord, timeoutMilliseconds = 30_000): Promise<RpcResponse> {
	if (teammate.transport !== "rpc" || !teammate.process || !teammate.alive || teammate.process.exitCode !== null) {
		throw new Error(`Teammate ${teammate.name} is not alive through RPC`);
	}

	const id = `team-${++requestCounter}`;
	const payload = { ...command, id };

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			teammate.pendingRequests.delete(id);
			reject(new Error(`Timed out waiting for ${String(command.type)} response from ${teammate.name}`));
		}, timeoutMilliseconds);

		teammate.pendingRequests.set(id, { resolve, reject, timeout });
		teammate.process!.stdin?.write(serializeJsonLine(payload));
	});
}

async function requireSuccessfulResponse(response: RpcResponse, action: string): Promise<void> {
	if (response.success) return;
	throw new Error(`${action} failed: ${response.error ?? "unknown RPC error"}`);
}

async function getTeammateBusy(teammate: TeammateState): Promise<boolean> {
	if (teammate.transport === "herdr") return teammate.busy;

	const response = await sendRpc(teammate, { type: "get_state" }, 10_000);
	if (!response.success) return teammate.busy;
	const data = response.data as { isStreaming?: boolean } | undefined;
	teammate.busy = Boolean(data?.isStreaming);
	return teammate.busy;
}

async function waitForIdle(teammate: TeammateState, timeoutMilliseconds = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMilliseconds;

	while (Date.now() < deadline) {
		if (!(await getTeammateBusy(teammate))) return;
		await sleep(100);
	}

	throw new Error(`Timed out waiting for ${teammate.name} to become idle`);
}

async function promptTeammate(team: TeamState, teammate: TeammateState, message: string): Promise<void> {
	const response = await sendRpc(teammate, { type: "prompt", message });
	if (response.success) {
		appendTeamLog(team, { team: team.name, teammate: teammate.name, direction: "runtime", kind: "ack", summary: "prompt accepted" });
		return;
	}

	const fallback = await sendRpc(teammate, { type: "prompt", message, streamingBehavior: "steer" });
	if (fallback.success) {
		appendTeamLog(team, { team: team.name, teammate: teammate.name, direction: "runtime", kind: "ack", summary: "steer fallback accepted" });
	} else {
		appendTeamLog(team, {
			team: team.name,
			teammate: teammate.name,
			direction: "runtime",
			kind: "error",
			summary: preview(`steer fallback to ${teammate.name} failed: ${fallback.error ?? "unknown RPC error"}`),
		});
	}
	await requireSuccessfulResponse(fallback, `steer fallback to ${teammate.name}`);
}

async function steerTeammate(team: TeamState, teammate: TeammateState, message: string): Promise<void> {
	const response = await sendRpc(teammate, { type: "steer", message });
	if (response.success) {
		appendTeamLog(team, { team: team.name, teammate: teammate.name, direction: "runtime", kind: "ack", summary: "steer accepted" });
		return;
	}
	appendTeamLog(team, {
		team: team.name,
		teammate: teammate.name,
		direction: "runtime",
		kind: "error",
		summary: preview(`steer to ${teammate.name} rejected: ${response.error ?? "unknown RPC error"}`),
	});
	await promptTeammate(team, teammate, message);
}

function formatTeammateMessage(team: TeamState, from: string, message: string): string {
	return [`[from ${from} on team ${team.name}]`, message, "", "Current team status:", JSON.stringify(formatStatus(team), null, 2)].join("\n");
}

async function deliverVisibleMessage(team: TeamState, from: string, recipient: TeammateState, message: string, formattedMessage: string, interrupt: boolean): Promise<void> {
	if (!recipient.alive || !recipient.visibleUrl) throw new Error(`Visible teammate ${recipient.name} is not ready`);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), visibleDeliveryTimeoutMilliseconds);
	try {
		const response = await fetch(recipient.visibleUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				token: callbackToken,
				tool: "deliver",
				args: { team: team.name, from, to: recipient.name, sentAt: nowText(), message, formattedMessage, interrupt },
			}),
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`Visible teammate ${recipient.name} rejected delivery: ${response.status} ${await response.text()}`);
		const result = (await response.json()) as { accepted?: boolean };
		if (!result.accepted) throw new Error(`Visible teammate ${recipient.name} did not accept delivery`);
		appendTeamLog(team, { team: team.name, teammate: recipient.name, direction: "runtime", kind: "ack", summary: "visible message accepted" });
	} catch (error) {
		if (controller.signal.aborted) throw new Error(`Timed out waiting for visible teammate ${recipient.name} delivery`);
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
	if (recipient.transport === "herdr") {
		await deliverVisibleMessage(team, from, recipient, message, formattedMessage, interrupt);
		return;
	}

	if (interrupt && (recipient.busy || (await getTeammateBusy(recipient)))) {
		await requireSuccessfulResponse(await sendRpc(recipient, { type: "abort" }, 60_000), `abort ${recipient.name}`);
		await waitForIdle(recipient);
		await promptTeammate(team, recipient, formattedMessage);
		return;
	}

	if (recipient.busy || (await getTeammateBusy(recipient))) {
		await steerTeammate(team, recipient, formattedMessage);
		return;
	}

	await promptTeammate(team, recipient, formattedMessage);
}

function enqueueDelivery(team: TeamState, from: string, recipient: TeammateState, message: string, interrupt: boolean): void {
	appendTeamLog(team, {
		team: team.name,
		teammate: recipient.name,
		direction: from === "main" ? "main->teammate" : "teammate->teammate",
		kind: "send",
		summary: preview(message),
		details: { from, to: recipient.name, interrupt },
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

function resolveTeam(owner: symbol, teamIdentifier?: string): TeamState {
	const ownedTeams = [...teams.values()].filter((team) => team.owner === owner);
	if (teamIdentifier) {
		const matches = ownedTeams.filter((team) => team.id === teamIdentifier || team.name === teamIdentifier);
		if (matches.length === 0) throw new Error(`Unknown team: ${teamIdentifier}`);
		if (matches.length > 1) throw new Error(`Ambiguous team name: ${teamIdentifier}. Pass the persistent team ID.`);
		return matches[0]!;
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
	if (teammate.transport === "rpc") {
		const response = await sendRpc(teammate, { type: "get_session_stats" });
		await requireSuccessfulResponse(response, `read context usage from ${teammate.name}`);
		const stats = response.data as { contextUsage?: ContextUsage };
		return requireKnownContextUsage(stats.contextUsage);
	}

	if (!teammate.alive || !teammate.visibleUrl) throw new Error(`Visible teammate ${teammate.name} is not ready`);
	const response = await fetch(teammate.visibleUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token: callbackToken, tool: "report_context_window", args: {} }),
		signal,
	});
	if (!response.ok) throw new Error(`Visible teammate ${teammate.name} rejected context-window query: ${response.status} ${await response.text()}`);
	const payload = (await response.json()) as { contextUsage?: ContextUsage };
	return requireKnownContextUsage(payload.contextUsage);
}

function formatStatus(team: TeamState): Record<string, TeamStatus> {
	return Object.fromEntries([...team.statuses.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function allStatuses(owner: symbol): Record<string, Record<string, TeamStatus>> {
	return Object.fromEntries([...teams.values()].filter((team) => team.owner === owner).map((team) => [team.name, formatStatus(team)]));
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
	let resolveVisibleReady: (() => void) | undefined;
	let rejectVisibleReady: ((error: Error) => void) | undefined;
	const visibleReady = team.showOnHerdrPanes
		? new Promise<void>((resolve, reject) => {
			resolveVisibleReady = resolve;
			rejectVisibleReady = reject;
		})
		: undefined;

	return {
		name: teammateName,
		prompt: teammateSpec.prompt,
		model: teammateSpec.model,
		thinking,
		inheritContext: Boolean(teammateSpec.inheritContext),
		transport: team.showOnHerdrPanes ? "herdr" : "rpc",
		sessionMaterialized: false,
		visibleReady,
		resolveVisibleReady,
		rejectVisibleReady,
		busy: false,
		alive: true,
		pendingRequests: new Map(),
		deliveryQueue: Promise.resolve(),
		recentEvents: [],
		stderr: "",
	};
}

function childEnvironmentOverrides(team: TeamState, teammate: TeammateState, participants: string[], visible: boolean): Record<string, string> {
	return {
		PI_SIMPLE_TEAM_CHILD: "1",
		PI_SIMPLE_TEAM_VISIBLE_CHILD: visible ? "1" : "0",
		PI_SIMPLE_TEAM_CALLBACK_URL: callbackUrl,
		PI_SIMPLE_TEAM_CALLBACK_TOKEN: callbackToken,
		PI_SIMPLE_TEAM_TEAM: team.id ?? team.name,
		PI_SIMPLE_TEAM_TEAM_NAME: team.name,
		PI_SIMPLE_TEAM_MEMBER: teammate.name,
		PI_SIMPLE_TEAM_PARTICIPANTS: JSON.stringify(participants),
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

interface RpcStartOptions {
	sessionFile?: string;
	restartEmpty?: boolean;
}

function attachRpcTeammate(team: TeamState, teammate: TeammateState, participants: string[], options: RpcStartOptions): void {
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
		composeSystemPrompt(team.name, team.teamPrompt, teammate.name, teammate.prompt, participants),
	];
	const proc = childProcess.spawn("pi", args, {
		cwd: team.projectDirectory ?? process.cwd(),
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...childEnvironmentOverrides(team, teammate, participants, false) },
	});
	teammate.process = proc;
	teammate.alive = true;
	teammate.busy = false;

	attachJsonlReader(proc.stdout!, (line) => {
		if (!line.trim()) return;
		try {
			handleTeammateEvent(team, teammate, JSON.parse(line) as JsonRecord);
		} catch {
			teammate.stderr += `\n[unparsed stdout] ${line}`;
		}
	});
	proc.stderr?.on("data", (chunk: Buffer | string) => {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		teammate.stderr += text;
		appendTeamLog(team, { team: team.name, teammate: teammate.name, direction: "runtime", kind: "stderr", summary: preview(text) });
	});
	proc.on("exit", (code, signal) => {
		teammate.alive = false;
		teammate.busy = false;
		rejectPendingRequests(teammate, new Error(`${teammate.name} exited (code=${code}, signal=${signal})`));
		team.statuses.set(teammate.name, status("stopped", `Exited code=${code} signal=${signal}`));
		appendTeamLog(team, { team: team.name, teammate: teammate.name, direction: "runtime", kind: "exit", summary: `exited (code=${code}, signal=${signal})`, details: { code, signal } });
	});
	appendSpawnLog(team, teammate);
}

async function captureRpcSessionIdentity(teammate: TeammateState): Promise<void> {
	const response = await sendRpc(teammate, { type: "get_state" }, 10_000);
	await requireSuccessfulResponse(response, `read session identity from ${teammate.name}`);
	const state = response.data as { sessionId?: unknown; sessionFile?: unknown } | undefined;
	if (typeof state?.sessionId !== "string" || typeof state.sessionFile !== "string" || !path.isAbsolute(state.sessionFile)) {
		throw new Error(`Teammate ${teammate.name} reported an invalid session identity`);
	}
	teammate.sessionId = state.sessionId;
	teammate.sessionFile = state.sessionFile;
	teammate.sessionMaterialized = fs.existsSync(state.sessionFile);
}

function parseHerdrPaneId(stdout: string, teammateName: string): string {
	const response = JSON.parse(stdout) as { result?: { agent?: { pane_id?: string } } };
	const paneId = response.result?.agent?.pane_id;
	if (!paneId) throw new Error(`herdr agent start did not return a pane for ${teammateName}`);
	return paneId;
}

async function attachVisibleTeammate(
	team: TeamState,
	teammate: TeammateState,
	participants: string[],
	herdrTabId: string,
	options: RpcStartOptions,
): Promise<void> {
	const systemPrompt = composeSystemPrompt(team.name, team.teamPrompt, teammate.name, teammate.prompt, participants);
	const environment = childEnvironmentOverrides(team, teammate, participants, true);
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
		"pi",
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

	let readinessTimeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			teammate.visibleReady!,
			new Promise<never>((_, reject) => {
				readinessTimeout = setTimeout(() => reject(new Error(`Timed out waiting for visible teammate ${teammate.name} readiness`)), 30_000);
			}),
		]);
	} catch (error) {
		teammate.rejectVisibleReady?.(error instanceof Error ? error : new Error(String(error)));
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
	rpcOptions: RpcStartOptions = {},
): Promise<void> {
	if (teammate.transport === "herdr") {
		await attachVisibleTeammate(team, teammate, participants, herdrTabId!, rpcOptions);
		return;
	}
	attachRpcTeammate(team, teammate, participants, rpcOptions);
	if (team.id) await captureRpcSessionIdentity(teammate);
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

async function closeVisiblePane(teammate: TeammateState): Promise<void> {
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
		forceKillTimeout = setTimeout(() => processToStop.kill("SIGKILL"), 1_000);
		forceKillTimeout.unref();
	});
	teammate.process = undefined;
}

async function shutdownTeam(team: TeamState): Promise<string[]> {
	const errors: string[] = [];
	for (const teammate of team.members.values()) {
		if (teammate.transport === "herdr") {
			teammate.alive = false;
			try {
				await closeVisiblePane(teammate);
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

function validateVisibleChildUrl(rawUrl: string, teammateName: string): string {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`Invalid visible teammate URL for ${teammateName}`);
	}
	const port = Number(url.port);
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || !Number.isInteger(port) || port < 1 || port > 65_535 || url.pathname !== "/deliver") {
		throw new Error(`Invalid visible teammate URL for ${teammateName}`);
	}
	return url.toString();
}

function handleVisibleEvent(team: TeamState, teammate: TeammateState, event: JsonRecord): void {
	if (event.type === "visible_startup_error") {
		const error = new Error(String(event.error ?? "Visible teammate startup failed"));
		teammate.rejectVisibleReady?.(error);
		throw error;
	}
	if (event.type === "agent_start") teammate.busy = true;
	if (event.type === "agent_end") teammate.busy = false;
	if (event.type === "session_shutdown") {
		teammate.alive = false;
		teammate.busy = false;
		teammate.visibleUrl = undefined;
		if (event.reason === "quit") {
			team.statuses.set(teammate.name, status("stopped", "Session shut down"));
			appendTeamLog(team, { team: team.name, teammate: teammate.name, direction: "runtime", kind: "exit", summary: "visible session shut down", details: { reason: event.reason } });
		}
	}
	pushRecentEvent(teammate, event);
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

		if (tool === "visible_register") {
			if (!teammate || teammate.transport !== "herdr") throw new Error(`Unknown visible teammate: ${from}`);
			const url = String(args.url ?? "");
			const sessionId = args.sessionId;
			const sessionFile = args.sessionFile;
			if (typeof sessionId !== "string" || typeof sessionFile !== "string" || !path.isAbsolute(sessionFile)) {
				throw new Error(`Visible teammate ${from} reported an invalid session identity`);
			}
			try {
				teammate.visibleUrl = validateVisibleChildUrl(url, from);
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				teammate.rejectVisibleReady?.(failure);
				throw failure;
			}
			teammate.sessionId = sessionId;
			teammate.sessionFile = sessionFile;
			teammate.sessionMaterialized = fs.existsSync(sessionFile);
			teammate.alive = true;
			teammate.busy = false;
			team.statuses.set(teammate.name, status("idle", "Spawned"));
			teammate.resolveVisibleReady?.();
			writeJson(response, 200, { accepted: true, team: team.name, from });
			return;
		}

		if (tool === "visible_event") {
			if (!teammate || teammate.transport !== "herdr") throw new Error(`Unknown visible teammate: ${from}`);
			handleVisibleEvent(team, teammate, (args.event ?? {}) as JsonRecord);
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
			const details: TeamMessageDetails = { team: team.name, from, sentAt: nowText(), message: rawMessage };
			appendTeamLog(team, { team: team.name, teammate: from, direction: "teammate->main", kind: "main_message", summary: preview(rawMessage) });
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
	});
}

function restoreTeamState(owner: symbol, ownerPi: ExtensionAPI, manifest: TeamManifest, lease: TeamLease): TeamState {
	const team: TeamState = {
		owner,
		ownerPi,
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

function prepareVisibleTeammate(teammate: TeammateState): void {
	teammate.transport = "herdr";
	teammate.visibleReady = new Promise<void>((resolve, reject) => {
		teammate.resolveVisibleReady = resolve;
		teammate.rejectVisibleReady = reject;
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
		return;
	}

	const owner = Symbol("pi-simple-team-owner");
	const sessionTeammateRoster: string[] = [];
	pi.registerMessageRenderer(teamMessageType, (message, _options, theme) => renderTeamMessage(message, theme, getMarkdownTheme(), sessionTeammateRoster));

	pi.on("session_shutdown", async () => {
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
						id: teamId,
						name: teamName,
						projectDirectory,
						showOnHerdrPanes,
						teamPrompt: params.teamPrompt,
						mainSessionFile,
						members: new Map(),
						statuses: new Map([["main", status("available", "Main agent")]]),
						created: nowText(),
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
						instruction: bundledAiToAiSkillInstruction,
					});
				},
			}),
		);
	});

	pi.registerTool(
		defineTool({
			name: "team_list",
			label: "Team List",
			description: "List active and dormant teams for the current project.",
			promptSnippet: "List teams for the current project",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal, _onUpdate, context) {
				const projectDirectory = context.sessionManager?.getCwd?.() ?? context.cwd;
				if (!projectDirectory) throw new Error("team_list requires a project directory");
				const manifests = listTeamManifests(projectDirectory);
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
			description: "Resume all stopped teammates in a dormant current-project team, or only selected stopped teammates.",
			promptSnippet: "Resume all or selected stopped teammates",
			parameters: Type.Object({
				team: Type.String({ description: "Persistent team ID" }),
				teammates: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Stopped teammate names. Omit to resume all stopped teammates." })),
				showOnHerdrPanes: Type.Optional(Type.Boolean({ default: false, description: "Resume selected teammates in visible Herdr panes. Defaults to RPC." })),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, context) {
				const rawProjectDirectory = context.sessionManager?.getCwd?.() ?? context.cwd;
				if (!rawProjectDirectory) throw new Error("team_resume requires a project directory");
				const manifest = listTeamManifests(rawProjectDirectory).find((candidate) => candidate.id === params.team);
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
						team = restoreTeamState(owner, pi, manifest, lease);
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
						if (showOnHerdrPanes) prepareVisibleTeammate(teammate);
						else teammate.transport = "rpc";
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
							await closeVisiblePane(teammate);
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
					resumed: starts.map(({ teammate }) => teammate.name),
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
			parameters: Type.Object({
				team: Type.String({ description: "Persistent team ID" }),
				teammates: Type.Array(teammateSchema(""), { minItems: 1, description: "New teammates to add" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, context) {
				const team = [...teams.values()].find((candidate) => candidate.id === params.team && candidate.owner === owner);
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
			description: "Send a message from main to teammate(s). Fire-and-forget; does not wait for replies. Teammates will send you messages as they deem appropriate by way of push.",
			promptSnippet: "Send a message from main to teammate(s)",
			renderShell: "self",
			renderCall: (args, theme, context) => renderTeamToolCall("teamsend", args, theme, context, sessionTeammateRoster),
			renderResult: (result, options, theme, context) => renderTeamToolResult("teamsend", result, options, theme, context, getMarkdownTheme(), sessionTeammateRoster),
			parameters: Type.Object({
				team: Type.Optional(Type.String({ description: "Team name; optional only when exactly one team exists" })),
				to: Type.Array(Type.String(), { description: "Recipient teammate names" }),
				message: Type.String({ description: "Message to send" }),
				interrupt: Type.Optional(Type.Boolean({ description: "Abort busy recipients before delivery" })),
			}),
			async execute(_toolCallId, params) {
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
			description: "Set main's status for a team and/or read team statuses.",
			promptSnippet: "Set/read team status maps",
			renderShell: "self",
			renderCall: (args, theme, context) => renderTeamToolCall("teamstatus", args, theme, context, sessionTeammateRoster),
			renderResult: (result, options, theme, context) => renderTeamToolResult("teamstatus", result, options, theme, context, undefined, sessionTeammateRoster),
			parameters: Type.Object({
				team: Type.Optional(Type.String({ description: "Team name; optional for listing all statuses or when exactly one team exists" })),
				// TODO: make gerund and phrase optionality a XOR.
				gerund: Type.Optional(Type.String({ description: "Set one-word gerund main status" })),
				phrase: Type.Optional(Type.String({ description: "Short main status verb-oriented phrase." })),
			}),
			async execute(_toolCallId, params) {
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
			description: "Report context-window use for selected teammates and main. Main's report is always last.",
			promptSnippet: "Report context-window use for selected teammates and main",
			parameters: Type.Object({
				targets: Type.Array(Type.String({ minLength: 1 }), { description: "Teammate names. Use an empty list to report only main." }),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, context) {
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

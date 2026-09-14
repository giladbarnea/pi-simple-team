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
import { resolveTargets, resolveTeammates, interruptedTeammateIds, targetDescription, interruptDescription, type SelectableTeam } from "./team-selection.ts";
import type { Teammate, TeammateRecord, ThinkingLevel } from "./teammate.ts";

type JsonRecord = Record<string, unknown>;

interface TeamStatus {
	word: string;
	phrase: string;
	updated: string;
}

type TeammateTransport = "rpc" | "herdr";

interface TeammateState {
	name: string;
	prompt: string;
	model: string;
	thinking: ThinkingLevel;
	inheritMainContext: boolean;
	canManageOwnTeams: boolean;
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
	active: boolean;
	pendingTurnDeliveries: number;
	deliveryQueue: Promise<void>;
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
let callbackReady: Promise<void> | undefined;
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

/** @example teamIdentity({ name: "review", id: "session-review" }) // { teamName: "review", teamId: "session-review" } */
function teamIdentity(team: { name: string; id?: string }): { teamName: string; teamId: string } {
	return { teamName: team.name, teamId: team.id ?? team.name };
}

/** @example teammateReference({ name: "reviewer", sessionId: "pi-session" }) // { name: "reviewer", teammateId: "pi-session" } */
function teammateReference(teammate: { name: string; sessionId?: string }): { name: string; teammateId: string } {
	return { name: teammate.name, teammateId: teammate.sessionId! };
}

/** @example teammateSummary(idleTeammate).active // false */
function teammateSummary(teammate: TeammateState): Pick<TeammateRecord, "name" | "teammateId" | "live" | "active"> {
	return { ...teammateReference(teammate), live: teammate.alive, active: teammate.alive && (teammate.active || teammate.pendingTurnDeliveries > 0) };
}

/** @example teammateRecord(teammate).teammateId === teammate.sessionId */
function teammateRecord(teammate: TeammateState): TeammateRecord {
	return {
		...teammateSummary(teammate),
		systemPrompt: teammate.prompt,
		model: teammate.model,
		thinking: teammate.thinking,
		inheritMainContext: teammate.inheritMainContext,
		canManageOwnTeams: teammate.canManageOwnTeams,
		showOnHerdrPane: teammate.transport === "herdr",
		sessionFile: teammate.sessionFile!,
	};
}

/** @example lifecycleInstruction(true).includes("idle") // true */
function lifecycleInstruction(startIdle: boolean): string {
	const nextAction = startIdle
		? "No teammates have active work. Use team_send_message to start idle teammates, or team_resume for stopped teammates."
		: "Teammates will message you with milestones or requests for help. Avoid repeated status polling and shell sleeps. Set your status to explain what you expect from them. If you have no independent work, tell the user and end your turn. Ask the user whether to schedule progress checks every 15 minutes. If they agree, use schedule_reminder. After each check, schedule the next while the team needs oversight.";
	return `${bundledSkillsInstruction}\n\n${nextAction}`;
}

/** @example lifecycleResult(emptyTeam).started // false */
function lifecycleResult(team: TeamState): JsonRecord {
	const teammates = [...team.members.values()].map(teammateRecord);
	const started = teammates.some((teammate) => teammate.active);
	return { ...teamIdentity(team), started, teammates, instruction: teammates.length > 0 ? lifecycleInstruction(!started) : bundledSkillsInstruction };
}

/** @example mainMessageResult(team).published // true */
function mainMessageResult(team: TeamState): JsonRecord {
	return {
		...teamIdentity(team), published: true, status: formatStatus(team),
		instruction: "Do not wait for a reply. Continue your work or set your status to explain what you need from main.",
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
				reject(new Error(`${command} ${args.slice(0, 2).join(" ")} failed: ${stderr.trim() || error.message}`));
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

async function validateHerdrAvailability(): Promise<string> {
	const tabId = process.env.HERDR_TAB_ID?.trim();
	if (!tabId) throw new Error("showOnHerdrPanes requires HERDR_TAB_ID in the main Pi process");
	const paneId = process.env.HERDR_PANE_ID?.trim();
	if (!paneId) throw new Error("Visible teammates require a parent Herdr pane. Run the main Pi session in Herdr, or set showOnHerdrPane to false.");

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
	return paneId;
}

function formatTeammateMessage(team: TeamState, from: string, message: string): string {
	return [`[from ${from} on team ${team.name}]`, message, "", "Current team status:", JSON.stringify(formatStatus(team), null, 2)].join("\n");
}

async function deliverMessage(team: TeamState, from: string, recipient: TeammateState, message: string, formattedMessage: string, interrupt: boolean, triggerTurn = true): Promise<void> {
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
				args: { team: team.name, from, to: recipient.name, sentAt: new Date().toISOString(), message, formattedMessage, interrupt, triggerTurn },
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

async function deliverToTeammate(team: TeamState, from: string, recipient: TeammateState, message: string, interrupt: boolean, triggerTurn = true): Promise<void> {
	const formattedMessage = formatTeammateMessage(team, from, message);
	appendTeamLog(team, {
		team: team.name,
		teammate: recipient.name,
		direction: from === "main" ? "main->teammate" : "teammate->teammate",
		kind: "deliver",
		summary: preview(message),
		details: { from, to: recipient.name, interrupt, triggerTurn },
	});
	await deliverMessage(team, from, recipient, message, formattedMessage, interrupt, triggerTurn);
}

function queueDelivery(team: TeamState, from: string, recipient: TeammateState, message: string, interrupt: boolean, triggerTurn = true): Promise<void> {
	appendTeamLog(team, {
		team: team.name,
		teammate: recipient.name,
		direction: from === "main" ? "main->teammate" : "teammate->teammate",
		kind: "send",
		summary: preview(message),
		details: { from, to: recipient.name, interrupt, message, triggerTurn },
	});
	if (triggerTurn) recipient.pendingTurnDeliveries += 1;
	const delivery = recipient.deliveryQueue.then(() => deliverToTeammate(team, from, recipient, message, interrupt, triggerTurn)).finally(() => {
		if (triggerTurn) recipient.pendingTurnDeliveries -= 1;
		persistActiveTeamManifest(team);
	});
	recipient.deliveryQueue = delivery.catch(() => undefined);
	return delivery;
}

function enqueueDelivery(team: TeamState, from: string, recipient: TeammateState, message: string, interrupt: boolean): void {
	void queueDelivery(team, from, recipient, message, interrupt).catch(async (error) => {
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
		const notification = `Message delivery failed for teammate "${recipient.name}" on team "${team.name}" (team ID: ${team.id ?? team.name}).\nOriginal message:\n${message}\nCause: ${errorMessage}\nCheck the teammate's status before retrying.`;
		try {
			if (from === "main") {
				team.ownerPi.sendMessage(
					{ customType: teamMessageType, content: notification, display: true, details: { team: team.name, from: "runtime", sentAt: new Date().toISOString(), message: notification } },
					{ deliverAs: "steer", triggerTurn: true },
				);
				return;
			}
			await deliverToTeammate(team, "runtime", team.members.get(from)!, notification, false);
		} catch (notificationError) {
			appendTeamLog(team, { team: team.name, teammate: from, direction: "runtime", kind: "error", summary: `Could not notify sender "${from}" of delivery failure: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}` });
		}
	});
}

async function kickoffTeammates(team: TeamState, teammates: TeammateState[], startIdle: boolean, resumptionPrompt?: string): Promise<void> {
	if (startIdle && resumptionPrompt === undefined) return;
	const outcomes = await Promise.allSettled(teammates.map((teammate) => {
		// A fork can continue main's workflow unless its latest message restates its own assignment.
		const assignment = `You are teammate "${teammate.name}" on team "${team.name}". Work on your individual assignment, continuing from any prior progress:\n\n${teammate.prompt}\n\nMain coordinates the team. If you inherited main's conversation, use it as background for your own assignment.`;
		return queueDelivery(team, "main", teammate, resumptionPrompt ?? assignment, false, !startIdle);
	}));
	const completed = teammates.filter((_teammate, index) => outcomes[index].status === "fulfilled").map((teammate) => teammate.name);
	const errors = outcomes.flatMap((outcome, index) => {
		if (outcome.status === "fulfilled") return [];
		const teammate = teammates[index];
		const cause: unknown = outcome.reason;
		const message = cause instanceof Error ? cause.message : String(cause);
		team.statuses.set(teammate.name, status("error", message));
		appendTeamLog(team, { team: team.name, teammate: teammate.name, direction: "runtime", kind: "error", summary: message });
		return [`${teammate.name}: ${message}`];
	});
	if (errors.length === 0) return;
	throw new Error(`Team "${team.name}" (team ID: ${team.id ?? team.name}) remains active. ${startIdle ? "Instructions recorded for" : "Work started for"}: ${JSON.stringify(completed)}. Failed teammates: ${errors.join("; ")}. Inspect team_status before retrying; do not spawn the team again.`);
}

/** @example resolveTeamIdentifier([{ id: "main-review", name: "review" }], "review")?.id // "main-review" */
function resolveTeamIdentifier<IdentifiedTeam extends { id?: string; name: string }>(
	candidates: Iterable<IdentifiedTeam>,
	teamIdentifier: string,
): IdentifiedTeam | undefined {
	const matches = [...candidates].filter((team) => team.id === teamIdentifier || team.name === teamIdentifier);
	if (matches.length > 1) throw new Error(`Ambiguous team name: ${JSON.stringify(teamIdentifier)}. Available team IDs by name: ${JSON.stringify(teamChoices(matches))}. Pass the intended persistent team ID in the team parameter.`);
	return matches[0];
}

/** @example teamChoices([{ name: "review", id: "first-review" }, { name: "review", id: "second-review" }]) // { review: ["first-review", "second-review"] } */
function teamChoices(candidates: Iterable<{ name: string; id?: string }>): Record<string, string[]> {
	const choices = [...candidates];
	return Object.fromEntries([...new Set(choices.map((team) => team.name))].map((name) => [name, choices.filter((team) => team.name === name).map((team) => team.id ?? team.name)]));
}

function resolveTeam(owner: symbol, teamIdentifier?: string): TeamState {
	const ownedTeams = [...teams.values()].filter((team) => team.owner === owner);
	if (teamIdentifier) {
		const team = resolveTeamIdentifier(ownedTeams, teamIdentifier);
		if (!team) throw new Error(`Unknown team: ${JSON.stringify(teamIdentifier)}. Available owned team IDs by name: ${JSON.stringify(teamChoices(ownedTeams))}. Use team_list to find dormant teams, or pass an owned active team name or ID in the team parameter.`);
		return team;
	}

	if (ownedTeams.length === 1) return ownedTeams[0];
	if (ownedTeams.length === 0) throw new Error("No active teams are owned by this session. Use team_spawn or team_resume first.");
	throw new Error(`Multiple teams exist. Available team IDs by name: ${JSON.stringify(teamChoices(ownedTeams))}. Pass team explicitly using the intended team ID.`);
}

function resolveCallbackTeam(teamName: string): TeamState {
	const team = teams.get(teamName);
	if (!team) throw new Error(`Unknown team: ${teamName}`);
	return team;
}

/** @example selectableTeam(team).teammates[0].teammateId === team.members.values().next().value.sessionId */
function selectableTeam(team: TeamState): SelectableTeam {
	return { ...teamIdentity(team), teammates: [...team.members.values()].map(teammateReference) };
}

function ownedTargetTeams(owner: symbol): SelectableTeam[] {
	return [...teams.values()].filter((team) => team.owner === owner).map(selectableTeam);
}

async function getTeammateContextUsage(teammate: TeammateState, signal?: AbortSignal): Promise<KnownContextUsage> {
	if (!teammate.alive || !teammate.deliveryUrl) throw new Error(`Teammate ${teammate.name} is not ready`);
	const response = await fetch(teammate.deliveryUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ token: callbackToken, tool: "get_context_window_usage", args: {} }),
		signal,
	});
	if (!response.ok) throw new Error(`Teammate ${teammate.name} rejected context-window query: ${response.status} ${await response.text()}`);
	const payload = (await response.json()) as { contextUsage?: ContextUsage };
	return requireKnownContextUsage(payload.contextUsage);
}

function formatStatus(team: TeamState): Record<string, TeamStatus> {
	return Object.fromEntries([...team.statuses.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function allStatuses(owner: symbol): Array<{ teamName: string; teamId: string; status: Record<string, TeamStatus> }> {
	return [...teams.values()].filter((team) => team.owner === owner).map((team) => ({ ...teamIdentity(team), status: formatStatus(team) }));
}

function ownedTeamSnapshots(owner: symbol): TeamSnapshot[] {
	return [...teams.values()]
		.filter((team) => team.owner === owner)
		.map((team) => ({
			name: team.name,
			created: team.created,
			transports: (["rpc", "herdr"] as const).filter((transport) => [...team.members.values()].some((teammate) => teammate.alive && teammate.transport === transport)),
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

/** Pure status reads are meta-actions and stay out of the log, like team_log reads. */
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

function createTeammateState(teammateSpec: Teammate): TeammateState {
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
		prompt: teammateSpec.systemPrompt,
		model: teammateSpec.model,
		thinking,
		inheritMainContext: Boolean(teammateSpec.inheritMainContext),
		canManageOwnTeams: Boolean(teammateSpec.canManageOwnTeams),
		transport: teammateSpec.showOnHerdrPane ? "herdr" : "rpc",
		sessionMaterialized: false,
		ready,
		resolveReady,
		rejectReady,
		alive: true,
		active: false,
		pendingTurnDeliveries: 0,
		deliveryQueue: Promise.resolve(),
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
		PI_SIMPLE_TEAM_CAN_MANAGE_OWN_TEAMS: teammate.canManageOwnTeams ? "1" : "0",
	};
}

function appendSpawnLog(team: TeamState, teammate: TeammateState): void {
	appendTeamLog(team, {
		team: team.name,
		teammate: teammate.name,
		direction: "runtime",
		kind: "spawn",
		summary: `spawned ${teammate.name} (model=${teammate.model}, thinking=${teammate.thinking}, context=${teammate.inheritMainContext ? "inherited" : "fresh"})`,
		details: { model: teammate.model, thinking: teammate.thinking, inheritMainContext: teammate.inheritMainContext, transport: teammate.transport, paneId: teammate.paneId },
	});
}

interface ChildStartOptions {
	sessionFile?: string;
	restartEmpty?: boolean;
	signal?: AbortSignal;
}

function attachRpcTeammate(team: TeamState, teammate: TeammateState, participants: string[], options: ChildStartOptions): void {
	const sessionArgs = options.sessionFile
		? ["--session", options.sessionFile]
		: teammate.inheritMainContext && !options.restartEmpty
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
		composeSystemPrompt(team.name, team.teamPrompt, teammate.name, teammate.prompt, participants, teammate.canManageOwnTeams),
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
	const response = JSON.parse(stdout) as { result?: { pane?: { pane_id?: string } } };
	const paneId = response.result?.pane?.pane_id;
	if (!paneId) throw new Error(`herdr pane split did not return a pane for teammate "${teammateName}"`);
	return paneId;
}

/** @example shellQuote("two words") // "'two words'" */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function attachHerdrTeammate(
	team: TeamState,
	teammate: TeammateState,
	participants: string[],
	herdrParentPaneId: string,
	options: ChildStartOptions,
): Promise<void> {
	const systemPrompt = composeSystemPrompt(team.name, team.teamPrompt, teammate.name, teammate.prompt, participants, teammate.canManageOwnTeams);
	const environment = childEnvironmentOverrides(team, teammate, participants);
	const sessionArgs = options.sessionFile
		? ["--session", options.sessionFile]
		: teammate.inheritMainContext && !options.restartEmpty
			? ["--fork", team.mainSessionFile!]
			: [];
	const modelArgs = options.sessionFile ? [] : ["--model", teammate.model, "--thinking", teammate.thinking];
	const args = ["pane", "split", "--pane", herdrParentPaneId, "--direction", "right", "--no-focus", "--cwd", team.projectDirectory ?? process.cwd()];
	for (const [name, value] of Object.entries(environment)) {
		if (value !== undefined) args.push("--env", `${name}=${value}`);
	}
	const result = await runCommand("herdr", args);
	teammate.paneId = parseHerdrPaneId(result.stdout, teammate.name);
	await runCommand("herdr", ["pane", "rename", teammate.paneId, teammate.name]);
	const command = [
		team.parentPiExecutable,
		...sessionArgs,
		"--no-extensions",
		"-e",
		teamLiteExtensionPath,
		...modelArgs,
		"--system-prompt",
		systemPrompt,
	].map(shellQuote).join(" ");
	await runCommand("herdr", ["pane", "run", teammate.paneId, command]);
	appendSpawnLog(team, teammate);
}

/** Every child registers its delivery runtime through the parent callback; startup completes only after registration. */
async function awaitChildRegistration(teammate: TeammateState, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	let readinessTimeout: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			teammate.ready!,
			new Promise<never>((_, reject) => {
				readinessTimeout = setTimeout(() => reject(new Error(`Timed out waiting for teammate ${teammate.name} to register`)), 30_000);
				onAbort = () => reject(signal!.reason);
				signal?.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} catch (error) {
		teammate.rejectReady?.(error instanceof Error ? error : new Error(String(error)));
		throw error;
	} finally {
		if (readinessTimeout) clearTimeout(readinessTimeout);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

async function startTeammate(
	team: TeamState,
	teammate: TeammateState,
	participants: string[],
	herdrParentPaneId?: string,
	startOptions: ChildStartOptions = {},
): Promise<void> {
	startOptions.signal?.throwIfAborted();
	if (teammate.transport === "herdr") await attachHerdrTeammate(team, teammate, participants, herdrParentPaneId!, startOptions);
	else attachRpcTeammate(team, teammate, participants, startOptions);
	await awaitChildRegistration(teammate, startOptions.signal);
}

function manifestMemberFromTeammate(teammate: TeammateState): TeamManifestMember {
	if (!teammate.sessionId || !teammate.sessionFile) {
		throw new Error(`Teammate ${teammate.name} has no reported session identity`);
	}
	if (fs.existsSync(teammate.sessionFile)) teammate.sessionMaterialized = true;
	return {
		...teammateRecord(teammate),
		sessionMaterialized: teammate.sessionMaterialized,
	};
}

function persistActiveTeamManifest(team: TeamState): void {
	if (!team.manifest || !teams.has(team.id ?? team.name)) return;
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
		if (!teammate.canManageOwnTeams) {
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
	callbackReady = undefined;
	callbackUrl = "";
}

async function ensureCallbackServer(): Promise<void> {
	if (callbackReady) return callbackReady;

	const server = http.createServer((request, response) => {
		void handleCallbackRequest(request, response);
	});
	callbackServer = server;

	callbackReady = new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Team callback server did not get a port");
			callbackUrl = `http://127.0.0.1:${address.port}/callback`;
			resolve();
		});
	});
	return callbackReady;
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
	if (event.type === "agent_start" || event.type === "work_queued") teammate.active = true;
	if (event.type === "agent_settled" || event.type === "session_shutdown") teammate.active = false;
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
	if (["agent_start", "work_queued", "agent_settled", "session_shutdown"].includes(String(event.type))) persistActiveTeamManifest(team);
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
			teammate.active = false;
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
				...selectableTeam(team),
				from,
				participants: [...team.members.keys()],
				status: formatStatus(team),
			});
			return;
		}

		if (tool === "team_send_message") {
			const candidates = [selectableTeam(team)];
			const selections = resolveTargets(candidates, args.targets as string[]);
			const message = String(args.message ?? "");
			const interrupted = interruptedTeammateIds(candidates, selections, args.interrupt as boolean | string[] | undefined);
			for (const selection of selections) {
				for (const recipient of selection.teammates) enqueueDelivery(team, from, team.members.get(recipient.name)!, message, interrupted.has(recipient.teammateId));
			}
			writeJson(response, 200, { published: true, teams: [{ ...teamIdentity(team), status: formatStatus(team) }], instruction: "Do not wait for replies. Teammates will message you back." });
			return;
		}

		if (tool === "send_main_message") {
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
			writeJson(response, 200, mainMessageResult(team));
			return;
		}

		if (tool === "team_status") {
			const gerund = args.gerund as string | undefined;
			const phrase = args.phrase as string | undefined;
			updateStatus(team, from, gerund, phrase);
			logStatusDeclaration(team, from, gerund, phrase);
			writeJson(response, 200, { ...teamIdentity(team), status: formatStatus(team) });
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
		systemPrompt: Type.String({ description: "Individual teammate system prompt" }),
		model: Type.String({ description: `Canonical provider/model id for this teammate. ${modelGuidance}` }),
		thinking: Type.Optional(StringEnum(thinkingLevels, { description: "Thinking level for this teammate. Defaults to xhigh.", default: defaultThinkingLevel })),
		inheritMainContext: Type.Optional(Type.Boolean({ description: "Start with a clone of your context window rather than start fresh. Defaults to false.", default: false })),
		canManageOwnTeams: Type.Optional(Type.Boolean({ description: "Allow this teammate to create and manage teams of its own. Defaults to false.", default: false })),
		showOnHerdrPane: Type.Optional(Type.Boolean({ description: "Open a visible Herdr pane for this teammate. Defaults to false.", default: false })),
	}, { additionalProperties: false });
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
		const teammate = createTeammateState(member);
		teammate.sessionId = member.teammateId;
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
	// Pi assigns a session path before its first assistant response creates the file.
	return undefined;
}

export default function (pi: ExtensionAPI) {
	const childRuntimeConfig = readChildRuntimeConfig();
	if (childRuntimeConfig) {
		registerChildTools(pi, childRuntimeConfig);
		if (!childRuntimeConfig.canManageOwnTeams) return;
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
				description: "You are automatically part of the team as main. Do not include yourself in teammates. Use team_resume to continue an existing team, or team_add_teammates to grow one.",
				promptSnippet: "Spawn a versatile team of agents.",
				renderShell: "self",
				renderCall: (args, theme, context) => renderTeamToolCall("team_spawn", args, theme, context, sessionTeammateRoster),
				renderResult: (result, options, theme, context) => renderTeamToolResult("team_spawn", result, options, theme, context, undefined, sessionTeammateRoster),
				parameters: Type.Object({
					teamName: Type.String({ description: "Name for the new team" }),
					commonPrompt: Type.String({ description: "Common system prompt for all teammates" }),
					teammates: Type.Array(teammateSchema(modelGuidance), { description: "Teammates to spawn" }),
					showOnHerdrPanes: Type.Optional(Type.Boolean({ description: "Open visible Herdr panes for the team. Overrides individual teammate Herdr settings when explicitly supplied. Defaults to false.", default: false })),
					startIdle: Type.Optional(Type.Boolean({ default: false, description: "Start teammates idle. Otherwise, start work following their common and individual system prompts once everyone is ready. Set true when only a few teammates should start first, then message those teammates." })),
				}, { additionalProperties: false }),
				async execute(_toolCallId, params, signal, _onUpdate, context) {
					signal?.throwIfAborted();
					const teamName = compactName(params.teamName);
					const showOnHerdrPanes = Boolean(params.showOnHerdrPanes);
					const teammateSpecs: Teammate[] = params.teammates.map((teammate) => ({ ...teammate, showOnHerdrPane: params.showOnHerdrPanes ?? teammate.showOnHerdrPane ?? false }));
					const herdrParentPaneId = showOnHerdrPanes || teammateSpecs.some((teammate) => teammate.showOnHerdrPane) ? await validateHerdrAvailability() : undefined;
					const teammateNames = teammateSpecs.map((teammate) => compactName(teammate.name));
					const duplicateNames = teammateNames.filter((name, index) => teammateNames.indexOf(name) !== index);
					if (duplicateNames.length > 0) throw new Error(`Duplicate teammate name(s): ${[...new Set(duplicateNames)].join(", ")}`);
					if (teammateNames.includes("main")) throw new Error('"main" is reserved');

					validateTeammateModels(teammateSpecs, context.modelRegistry.getAvailable());
					const inheritsMainContext = teammateSpecs.some((teammate) => Boolean(teammate.inheritMainContext));
					const mainSessionFile = inheritsMainContext ? context.sessionManager.getSessionFile() : undefined;
					if (inheritsMainContext && !mainSessionFile) throw new Error("inheritMainContext requires a saved main session. Use a saved main session or retry with inheritMainContext: false.");
					const originMainSessionId = context.sessionManager?.getSessionId?.();
					const rawProjectDirectory = context.sessionManager?.getCwd?.() ?? context.cwd;
					const projectDirectory = rawProjectDirectory ? canonicalProjectDirectory(rawProjectDirectory) : undefined;
					const teamId = originMainSessionId && projectDirectory ? `${originMainSessionId}-${teamName}` : undefined;
					const runtimeTeamId = teamId ?? teamName;
					if (teams.has(runtimeTeamId)) throw new Error(`Team already exists: ${runtimeTeamId}`);
					const lease = teamId ? claimTeamLease(teamId, originMainSessionId) : undefined;
					if (teamId && projectDirectory && listTeamManifests(projectDirectory).some((manifest) => manifest.id === teamId)) {
						releaseTeamLease(lease!);
						// TODO: Consider resuming here if all supplied spawn settings can be preserved.
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
						teamPrompt: params.commonPrompt,
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
							const teammate = createTeammateState(teammateSpec);
							team.members.set(teammate.name, teammate);
							team.statuses.set(teammate.name, status("idle", "Spawned"));
							await startTeammate(team, teammate, teammateNames, herdrParentPaneId, { signal });
						}
						signal?.throwIfAborted();

						if (teamId && originMainSessionId && projectDirectory) {
							const timestamp = new Date().toISOString();
							const manifest: TeamManifest = {
								version: 2,
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
					await kickoffTeammates(team, [...team.members.values()], Boolean(params.startIdle));
					return toolResult(lifecycleResult(team));
				},
			}),
		);
	});

	pi.registerTool(
		defineTool({
			name: "schedule_reminder",
			label: "Schedule Reminder",
			description: "Set a one-shot reminder for yourself. Use it when work needs a later check. For periodic checks, schedule the next reminder after each check.",
			renderShell: "self",
			renderCall: (args, theme, context) => renderReminderToolCall(args, theme, context),
			renderResult: (result, options, theme, context) => renderReminderToolResult(result, options, theme, context),
			parameters: Type.Object({
				delayMinutes: Type.Number({ exclusiveMinimum: 0, maximum: 35_791, description: "Minutes until the reminder" }),
				message: Type.String({ minLength: 1, description: "Custom message that wakes you" }),
			}, { additionalProperties: false }),
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
			// TODO: Make listing dormant teams opt-in with includeDormantTeams: boolean.
			label: "Team List",
			description: childRuntimeConfig
				? "List active and dormant teams in the current project that this managing teammate's Pi session created."
				: "List active and dormant teams for the current project.",
			renderShell: "self",
			renderCall: (_args, theme, context) => renderTeamToolCall("team_list", {}, theme, context, sessionTeammateRoster),
			renderResult: (result, options, theme, context) => renderTeamToolResult("team_list", result, options, theme, context, undefined, sessionTeammateRoster),
			parameters: Type.Object({}, { additionalProperties: false }),
			async execute(_toolCallId, _params, _signal, _onUpdate, context) {
				const projectDirectory = context.sessionManager?.getCwd?.() ?? context.cwd;
				if (!projectDirectory) throw new Error("team_list requires a project directory");
				const managerSessionId = childRuntimeConfig ? context.sessionManager?.getSessionId?.() : undefined;
				if (childRuntimeConfig && !managerSessionId) throw new Error("team_list requires a persistent managing teammate Pi session");
				const manifests = listTeamManifests(projectDirectory).filter(
					(manifest) => !managerSessionId || manifest.originMainSessionId === managerSessionId,
				);
				return toolResult({
					teams: manifests.map((manifest) => {
						const liveTeam = teams.get(manifest.id);
						return {
							...teamIdentity(manifest),
							state: manifest.state,
							leaseState: readTeamLeaseState(manifest.id).state,
							teammates: manifest.members.map(({ sessionMaterialized, ...member }) => {
								const runtime = liveTeam?.members.get(member.name);
								return runtime ? teammateRecord(runtime) : member;
							}),
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
				? "Resume all or selected stopped teammates from a current-project team created by your Pi session. Already-running teammates remain as they are."
				: "Resume all or selected stopped teammates from a team in the current project. Already-running teammates remain as they are.",
			renderShell: "self",
			renderCall: (args, theme, context) => renderTeamToolCall("team_resume", args, theme, context, sessionTeammateRoster),
			renderResult: (result, options, theme, context) => renderTeamToolResult("team_resume", result, options, theme, context, undefined, sessionTeammateRoster),
			parameters: Type.Object({
				team: Type.String({ description: "Team name or persistent ID" }),
				// TODO: Should allow defining new teammates or even existing teammates (any Pi session ID belonging to this project) from other teams and sessions for maximum flexibility.
				teammates: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Teammate names or Pi session IDs within this team. Omit to resume all stopped teammates." })),
				showOnHerdrPanes: Type.Optional(Type.Boolean({ default: false, description: "Open visible Herdr panes for selected teammates. Defaults to false." })),
				startIdle: Type.Optional(Type.Boolean({ default: false, description: "Start resumed teammates idle." })),
				resumptionPrompt: Type.Optional(Type.String({ description: "Instructions added once to resumed teammates' conversation context. Does not change system prompts or independently start work." })),
			}, { additionalProperties: false }),
			async execute(_toolCallId, params, signal, _onUpdate, context) {
				signal?.throwIfAborted();
				const rawProjectDirectory = context.sessionManager?.getCwd?.() ?? context.cwd;
				if (!rawProjectDirectory) throw new Error("team_resume requires a project directory");
				const managerSessionId = childRuntimeConfig ? context.sessionManager?.getSessionId?.() : undefined;
				if (childRuntimeConfig && !managerSessionId) throw new Error("team_resume requires a persistent managing teammate Pi session");
				const availableManifests = listTeamManifests(rawProjectDirectory).filter(
					(candidate) => !managerSessionId || candidate.originMainSessionId === managerSessionId,
				);
				const manifest = resolveTeamIdentifier(availableManifests, params.team);
				if (!manifest) throw new Error(`Unknown current-project team: ${JSON.stringify(params.team)}. Call team_list and pass a listed teamId or unique teamName in the team parameter.`);
				const members = manifest.members;
				const requestedNames = resolveTeammates(members, params.teammates ?? members.map((member) => member.teammateId)).map((member) => member.name);
				const showOnHerdrPanes = Boolean(params.showOnHerdrPanes);
				const herdrParentPaneId = showOnHerdrPanes ? await validateHerdrAvailability() : undefined;

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
				const alreadyLiveTeammates = [...team.members.values()].filter((teammate) => teammate.alive);
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
						await startTeammate(team, teammate, participantNames, herdrParentPaneId, {
							sessionFile,
							restartEmpty: sessionFile === undefined,
							signal,
						});
						team.statuses.set(teammate.name, status("idle", "Resumed"));
					}
					signal?.throwIfAborted();
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

				await kickoffTeammates(team, starts.map(({ teammate }) => teammate), Boolean(params.startIdle), params.resumptionPrompt);
				return toolResult({
					...lifecycleResult(team),
					teammates: [...team.members.values()].map((teammate) => {
						const resumed = starts.find((start) => start.teammate === teammate);
						return { ...teammateRecord(teammate), ...(resumed ? { contextRestored: resumed.sessionFile !== undefined } : {}) };
					}),
					alreadyActiveTeammates: alreadyLiveTeammates.filter((teammate) => teammateSummary(teammate).active).map(teammateReference),
					status: formatStatus(team),
				});
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "team_add_teammates",
			label: "Team Add",
			description: "Add teammates to an active team you own. Existing teammates continue their work.",
			promptSnippet: "Add new teammates to a running team",
			renderShell: "self",
			renderCall: (args, theme, context) => renderTeamToolCall("team_add_teammates", args, theme, context, sessionTeammateRoster),
			renderResult: (result, options, theme, context) => renderTeamToolResult("team_add_teammates", result, options, theme, context, undefined, sessionTeammateRoster),
			parameters: Type.Object({
				team: Type.Optional(Type.String({ description: "Team name or persistent ID. Omit when exactly one owned active team exists." })),
				// TODO: Accept existing current-project Pi session IDs as well as new teammate definitions.
				teammates: Type.Array(teammateSchema(""), { minItems: 1, description: "New teammate definitions to add. Existing Pi sessions cannot yet be attached." }),
				startIdle: Type.Optional(Type.Boolean({ default: false, description: "Start added teammates idle." })),
			}, { additionalProperties: false }),
			async execute(_toolCallId, params, signal, _onUpdate, context) {
				signal?.throwIfAborted();
				const team = resolveTeam(owner, params.team);
				if (!team || !team.manifest || !team.lease || team.manifest.state !== "active") {
					throw new Error(`team_add_teammates requires a running team owned by this main session: ${params.team}`);
				}

				const teammateSpecs = params.teammates as Teammate[];
				const herdrParentPaneId = teammateSpecs.some((teammate) => teammate.showOnHerdrPane) ? await validateHerdrAvailability() : undefined;
				const teammateNames = teammateSpecs.map((teammate) => compactName(teammate.name));
				const duplicateNames = teammateNames.filter(
					(name, index) => teammateNames.indexOf(name) !== index || team.members.has(name),
				);
				if (duplicateNames.length > 0) {
					throw new Error(`Duplicate teammate name(s): ${[...new Set(duplicateNames)].join(", ")}`);
				}
				if (teammateNames.includes("main")) throw new Error('"main" is reserved');
				validateTeammateModels(teammateSpecs, context.modelRegistry.getAvailable());

				const inheritsMainContext = teammateSpecs.some((teammate) => Boolean(teammate.inheritMainContext));
				const mainSessionFile = inheritsMainContext ? context.sessionManager.getSessionFile() : undefined;
				if (inheritsMainContext && !mainSessionFile) throw new Error("inheritMainContext requires a saved main session. Use a saved main session or retry with inheritMainContext: false.");
				if (mainSessionFile) team.mainSessionFile = mainSessionFile;

				const addedTeammates = teammateSpecs.map(createTeammateState);
				for (const teammate of addedTeammates) {
					team.members.set(teammate.name, teammate);
					team.statuses.set(teammate.name, status("idle", "Spawned"));
				}
				const participantNames = [...team.members.keys()];
				sessionTeammateRoster.push(...teammateNames.filter((name) => !sessionTeammateRoster.includes(name)));

				try {
					for (const teammate of addedTeammates) await startTeammate(team, teammate, participantNames, herdrParentPaneId, { signal });
					signal?.throwIfAborted();
					persistActiveTeamManifest(team);
				} catch (error) {
					for (const teammate of addedTeammates) {
						if (teammate.transport === "herdr") await closeHerdrPane(teammate);
						else await stopRpcTeammate(teammate);
					}
					for (const teammate of addedTeammates) {
						team.members.delete(teammate.name);
						team.statuses.delete(teammate.name);
					}
					throw error;
				}

				await kickoffTeammates(team, addedTeammates, Boolean(params.startIdle));
				return toolResult({
					...lifecycleResult(team),
					teammates: [...team.members.values()].map(teammateSummary),
					status: formatStatus(team),
				});
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "team_send_message",
			label: "Team Send",
			description: childRuntimeConfig
				? "Message teammates in your parent team or teams you own."
				: "Message teammates in teams you own.",
			promptSnippet: "Message your teammates.",
			renderShell: "self",
			renderCall: (args, theme, context) => renderTeamToolCall("team_send_message", args, theme, context, sessionTeammateRoster),
			renderResult: (result, options, theme, context) => renderTeamToolResult("team_send_message", result, options, theme, context, getMarkdownTheme(), sessionTeammateRoster),
			parameters: Type.Object({
				targets: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: targetDescription }),
				message: Type.String({ description: "Message to send" }),
				interrupt: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String({ minLength: 1 }))], { description: interruptDescription })),
			}, { additionalProperties: false }),
			async execute(_toolCallId, params, signal) {
				const parent = childRuntimeConfig ? await callParent(childRuntimeConfig, "team_context", {}, signal) as unknown as SelectableTeam : undefined;
				const candidates = [...ownedTargetTeams(owner), ...(parent ? [parent] : [])];
				const selections = resolveTargets(candidates, params.targets);
				const interrupted = interruptedTeammateIds(candidates, selections, params.interrupt);
				const statuses: JsonRecord[] = [];
				for (const selection of selections) {
					if (selection.team === parent) {
						const result = await callParent(childRuntimeConfig!, "team_send_message", {
							targets: selection.teammates.map((teammate) => teammate.teammateId), message: params.message,
							interrupt: selection.teammates.filter((teammate) => interrupted.has(teammate.teammateId)).map((teammate) => teammate.teammateId),
						}, signal);
						statuses.push(...result.teams as JsonRecord[]);
						continue;
					}
					const team = teams.get(selection.team.teamId)!;
					for (const recipient of selection.teammates) enqueueDelivery(team, "main", team.members.get(recipient.name)!, params.message, interrupted.has(recipient.teammateId));
					statuses.push({ ...teamIdentity(team), status: formatStatus(team) });
				}
				return toolResult({ published: true, teams: statuses, instruction: "Do not wait for replies. Teammates will message you back." });
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "team_status",
			label: "Team Status",
			description: childRuntimeConfig
				? "Omit `team` to set or read parent-team status. Set `team` to set or read an owned team's status."
				: "Set your own status for a team and/or read team statuses.",
			renderShell: "self",
			renderCall: (args, theme, context) => renderTeamToolCall("team_status", args, theme, context, sessionTeammateRoster),
			renderResult: (result, options, theme, context) => renderTeamToolResult("team_status", result, options, theme, context, undefined, sessionTeammateRoster),
			parameters: Type.Object({
				team: Type.Optional(Type.String({ description: childRuntimeConfig ? "Owned team name or ID. Omit to use the parent team." : "Team name or ID. Omit to read all teams, or to set your status when exactly one owned team exists." })),
				// TODO: make gerund and phrase optionality a XOR.
				gerund: Type.Optional(Type.String({ description: "One-word gerund for your status." })),
				phrase: Type.Optional(Type.String({ description: "Short, action-oriented status phrase." })),
			}, { additionalProperties: false }),
			async execute(_toolCallId, params, signal) {
				if (childRuntimeConfig && !params.team) {
					return toolResult(await callParent(childRuntimeConfig, "team_status", {
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
				return toolResult({ ...teamIdentity(team), status: formatStatus(team) });
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "get_context_window_usage",
			label: "Context Window Usage",
			description: "Get context-window use of selected teammates. Your own window's use is always included.",
			parameters: Type.Object({
				targets: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: `${targetDescription} Omit or pass an empty list for only your own usage.` })),
			}, { additionalProperties: false }),
			async execute(_toolCallId, params, signal, _onUpdate, context) {
				const selections = resolveTargets(ownedTargetTeams(owner), params.targets ?? []);
				const reports = await Promise.all(
					selections.flatMap(({ team, teammates }) => teammates.map(async (teammate) => formatContextWindowReport(
						`Teammate ${teammate.name} (Pi session ID: ${teammate.teammateId}) on team ${team.teamName} (team ID: ${team.teamId}) has`,
						await getTeammateContextUsage(teams.get(team.teamId)!.members.get(teammate.name)!, signal),
					))),
				);
				reports.push(formatContextWindowReport("You have", requireKnownContextUsage(context.getContextUsage())));
				return { content: [{ type: "text" as const, text: reports.join("\n") }], details: {} };
			},
		}),
	);

	// TODO: main could use more automatic meta/discoverability information in the return payload. To help orient around what has been read already, what hasn't been read, inside and outside the filtered space, how long is the log, etc.
	pi.registerTool(
		defineTool({
			name: "team_log",
			label: "Team Log",
			description: "Inspect paged event logs for selected teammates or teams you own.",
			renderShell: "self",
			renderCall: (args, theme, context) => renderTeamToolCall("team_log", args, theme, context, sessionTeammateRoster),
			renderResult: (result, options, theme, context) => renderTeamToolResult("team_log", result, options, theme, context, undefined, sessionTeammateRoster),
			parameters: Type.Object({
				targets: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: `${targetDescription} Omit for all teams you own.` })),
				kind: Type.Optional(
					Type.Array(Type.String({ minLength: 1 }), {
						minItems: 1,
						description: "Filter to any of these normalized event kinds",
					}),
				),
				search: Type.Optional(Type.String({ description: "Case-insensitive substring search over summary, teammate, direction, kind, and details" })),
				since: Type.Optional(Type.String({ description: "ISO timestamp filter; only entries at or after this time" })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max rows to return, default 20, maximum 100" })),
				cursor: Type.Optional(Type.String({ description: "Opaque cursor from the previous response. Keep the same targets and filters when paging." })),
			}, { additionalProperties: false }),
			async execute(_toolCallId, params) {
				const candidates = ownedTargetTeams(owner);
				const selections = resolveTargets(candidates, params.targets ?? candidates.map((team) => team.teamId));
				const entries = selections.flatMap((selection) => {
					const team = teams.get(selection.team.teamId)!;
					const names = new Set(selection.teammates.map((teammate) => teammate.name));
					return team.log.filter((entry) => selection.wholeTeam || names.has(entry.teammate!)).map((entry) => ({ ...entry, team: selection.team.teamId }));
				});
				const filtered = filterTeamLog(entries, {
					kind: params.kind,
					search: params.search,
					since: params.since,
				});
				const page = pageTeamLog(filtered, { limit: params.limit, cursor: params.cursor });
				const selectedTeams = selections.map((selection) => ({
					teamName: selection.team.teamName,
					teamId: selection.team.teamId,
					roster: selection.team.teammates.map((teammate) => teammate.name),
					entries: page.entries.filter((entry) => entry.team === selection.team.teamId),
					totalMatched: filtered.filter((entry) => entry.team === selection.team.teamId).length,
				}));
				const tables = selectedTeams.map((team) => renderTeamLogPage({ team: `${team.teamName} (team ID: ${team.teamId})`, entries: team.entries, totalMatched: team.totalMatched, returned: team.entries.length, limit: page.limit }));
				const text = [...tables, `Total: ${page.returned} of ${page.totalMatched} matching events.${page.nextCursor ? ` nextCursor="${page.nextCursor}"` : ""}`].join("\n\n");

				return {
					content: [{ type: "text" as const, text }],
					details: {
						teams: selectedTeams,
						entries: page.entries,
						totalMatched: page.totalMatched,
						returned: page.returned,
						nextCursor: page.nextCursor,
						filters: {
							targets: params.targets,
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
			renderShell: "self",
			renderCall: (args, theme, context) => renderTeamToolCall("team_shutdown", args, theme, context, sessionTeammateRoster),
			renderResult: (result, options, theme, context) => renderTeamToolResult("team_shutdown", result, options, theme, context, undefined, sessionTeammateRoster),
			parameters: Type.Object({
				team: Type.Optional(Type.String({ description: "Team name or ID. Omit when exactly one owned active team exists." })),
			}, { additionalProperties: false }),
			async execute(_toolCallId, params) {
				const team = resolveTeam(owner, params.team);
				const teammates = [...team.members.values()].map(teammateReference);
				const errors = await shutdownTeam(team);
				closeCallbackServerIfUnused();
				if (errors.length > 0) throw new Error(`Failed to close Herdr teammate pane(s): ${errors.join("; ")}`);
				return toolResult({ ...teamIdentity(team), stopped: true, teammates });
			},
		}),
	);
}

import * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { defineTool, type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { validateTeammateModels } from "./model-preflight.ts";
import { composeSystemPrompt } from "./system-prompt.ts";
import { readChildRuntimeConfig, registerChildTools } from "./child-tools.ts";
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
}

interface TeammateState {
	name: string;
	prompt: string;
	model: string;
	thinking: ThinkingLevel;
	process: ChildProcess;
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
	name: string;
	teamPrompt: string;
	members: Map<string, TeammateState>;
	statuses: Map<string, TeamStatus>;
	created: string;
	log: TeamLogEntry[];
	nextLogSequence: number;
}

const teamLiteExtensionPath = fileURLToPath(import.meta.url);
const thinkingLevels = ["low", "medium", "high", "xhigh", "max"] as const;
const defaultThinkingLevel: ThinkingLevel = "xhigh";
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
	if (!teammate.alive || teammate.process.exitCode !== null) {
		throw new Error(`Teammate ${teammate.name} is not alive`);
	}

	const id = `team-${++requestCounter}`;
	const payload = { ...command, id };

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			teammate.pendingRequests.delete(id);
			reject(new Error(`Timed out waiting for ${String(command.type)} response from ${teammate.name}`));
		}, timeoutMilliseconds);

		teammate.pendingRequests.set(id, { resolve, reject, timeout });
		teammate.process.stdin?.write(serializeJsonLine(payload));
	});
}

async function requireSuccessfulResponse(response: RpcResponse, action: string): Promise<void> {
	if (response.success) return;
	throw new Error(`${action} failed: ${response.error ?? "unknown RPC error"}`);
}

async function getTeammateBusy(teammate: TeammateState): Promise<boolean> {
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

function resolveTeam(owner: symbol, teamName?: string): TeamState {
	const ownedTeams = [...teams.values()].filter((team) => team.owner === owner);
	if (teamName) {
		const team = teams.get(teamName);
		if (!team || team.owner !== owner) throw new Error(`Unknown team: ${teamName}`);
		return team;
	}

	if (ownedTeams.length === 1) return ownedTeams[0];
	if (ownedTeams.length === 0) throw new Error("No teams exist. Use team_spawn first.");
	throw new Error(`Multiple teams exist: ${ownedTeams.map((team) => team.name).join(", ")}. Pass team explicitly.`);
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

function startTeammate(team: TeamState, teammateSpec: TeammateSpec, participants: string[]): TeammateState {
	const teammateName = compactName(teammateSpec.name);
	const thinking = teammateSpec.thinking ?? defaultThinkingLevel;
	const args = [
		"--mode",
		"rpc",
		"-e",
		teamLiteExtensionPath,
		"--no-prompt-templates",
		"--no-themes",
		"--model",
		teammateSpec.model,
		"--thinking",
		thinking,
		"--system-prompt",
		composeSystemPrompt(team.name, team.teamPrompt, teammateName, teammateSpec.prompt, participants),
	];

	const proc = childProcess.spawn("pi", args, {
		cwd: process.cwd(),
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			...process.env,
			PI_SIMPLE_TEAM_CHILD: "1",
			PI_SIMPLE_TEAM_CALLBACK_URL: callbackUrl,
			PI_SIMPLE_TEAM_CALLBACK_TOKEN: callbackToken,
			PI_SIMPLE_TEAM_TEAM: team.name,
			PI_SIMPLE_TEAM_MEMBER: teammateName,
		},
	});

	const teammate: TeammateState = {
		name: teammateName,
		prompt: teammateSpec.prompt,
		model: teammateSpec.model,
		thinking,
		process: proc,
		busy: false,
		alive: true,
		pendingRequests: new Map(),
		deliveryQueue: Promise.resolve(),
		recentEvents: [],
		stderr: "",
	};

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
		appendTeamLog(team, {
			team: team.name,
			teammate: teammate.name,
			direction: "runtime",
			kind: "exit",
			summary: `exited (code=${code}, signal=${signal})`,
			details: { code, signal },
		});
	});

	appendTeamLog(team, {
		team: team.name,
		teammate: teammate.name,
		direction: "runtime",
		kind: "spawn",
		summary: `spawned ${teammate.name} (model=${teammate.model}, thinking=${teammate.thinking})`,
	});

	return teammate;
}

function shutdownTeam(team: TeamState): void {
	for (const teammate of team.members.values()) {
		teammate.alive = false;
		teammate.process.kill("SIGTERM");
		setTimeout(() => {
			if (teammate.process.exitCode === null) teammate.process.kill("SIGKILL");
		}, 1_000).unref();
	}
	teams.delete(team.name);
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
			updateStatus(team, from, args.word as string | undefined, args.phrase as string | undefined);
			appendTeamLog(team, {
				team: team.name,
				teammate: from,
				direction: "runtime",
				kind: "status",
				summary: preview(`${String(args.word ?? "")} ${String(args.phrase ?? "")}`.trim()),
			});
			writeJson(response, 200, { team: team.name, status: formatStatus(team) });
			return;
		}

		writeJson(response, 400, { error: `unknown tool: ${tool}` });
	} catch (error) {
		writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
	}
}

const teammateSchema = Type.Object({
	name: Type.String({ description: "Teammate name" }),
	prompt: Type.String({ description: "Individual teammate system prompt" }),
	model: Type.String({ description: "Model pattern or provider/model id for this teammate" }),
	thinking: Type.Optional(StringEnum(thinkingLevels, { description: "Thinking level for this teammate. Defaults to xhigh.", default: defaultThinkingLevel })),
});

export default function (pi: ExtensionAPI) {
	const childRuntimeConfig = readChildRuntimeConfig();
	if (childRuntimeConfig) {
		registerChildTools(pi, childRuntimeConfig);
		return;
	}

	const owner = Symbol("pi-simple-team-owner");
	pi.registerMessageRenderer(teamMessageType, (message, _options, theme) => renderTeamMessage(message, theme, getMarkdownTheme()));

	pi.on("session_shutdown", async () => {
		for (const team of [...teams.values()]) {
			if (team.owner === owner) shutdownTeam(team);
		}
		closeCallbackServerIfUnused();
	});

	pi.registerTool(
		defineTool({
			name: "team_spawn",
			label: "Team Spawn",
			description: "Spawn a persistent team of RPC Pi teammates with fresh context windows. The main agent is included automatically; do not specify it as a teammate.",
			promptSnippet: "Spawn persistent RPC Pi teammate processes",
			renderShell: "self",
			renderCall: (args, theme, context) => renderTeamToolCall("team_spawn", args, theme, context),
			renderResult: (result, options, theme, context) => renderTeamToolResult("team_spawn", result, options, theme, context),
			parameters: Type.Object({
				team: Type.String({ description: "Team name" }),
				teamPrompt: Type.String({ description: "Common team system prompt" }),
				teammates: Type.Array(teammateSchema, { description: "Teammates to spawn" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const teamName = compactName(params.team);
				if (teams.has(teamName)) throw new Error(`Team already exists: ${teamName}`);

				const teammateSpecs = params.teammates as TeammateSpec[];
				const teammateNames = teammateSpecs.map((teammate) => compactName(teammate.name));
				const duplicateNames = teammateNames.filter((name, index) => teammateNames.indexOf(name) !== index);
				if (duplicateNames.length > 0) throw new Error(`Duplicate teammate name(s): ${[...new Set(duplicateNames)].join(", ")}`);
				if (teammateNames.includes("main")) throw new Error('"main" is reserved');

				await validateTeammateModels(teammateSpecs);
				await ensureCallbackServer();

				const team: TeamState = {
					owner,
					ownerPi: pi,
					name: teamName,
					teamPrompt: params.teamPrompt,
					members: new Map(),
					statuses: new Map([["main", status("available", "Main agent")]]),
					created: nowText(),
					log: [],
					nextLogSequence: 1,
				};

				teams.set(teamName, team);
				try {
					for (const teammateSpec of teammateSpecs) {
						const teammate = startTeammate(team, teammateSpec, teammateNames);
						team.members.set(teammate.name, teammate);
						team.statuses.set(teammate.name, status("idle", "Spawned"));
					}
				} catch (error) {
					shutdownTeam(team);
					closeCallbackServerIfUnused();
					throw error;
				}

				return toolResult({
					accepted: true,
					team: team.name,
					teammates: [...team.members.keys()],
					status: formatStatus(team),
				});
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "teamsend",
			label: "Team Send",
			description: "Send a message from main to teammate(s). Fire-and-forget; does not wait for replies.",
			promptSnippet: "Send a message from main to teammate(s)",
			renderShell: "self",
			renderCall: (args, theme, context) => renderTeamToolCall("teamsend", args, theme, context),
			renderResult: (result, options, theme, context) => renderTeamToolResult("teamsend", result, options, theme, context, getMarkdownTheme()),
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
			renderCall: (args, theme, context) => renderTeamToolCall("teamstatus", args, theme, context),
			renderResult: (result, options, theme, context) => renderTeamToolResult("teamstatus", result, options, theme, context),
			parameters: Type.Object({
				team: Type.Optional(Type.String({ description: "Team name; optional for listing all statuses or when exactly one team exists" })),
				word: Type.Optional(Type.String({ description: "One-word main status" })),
				phrase: Type.Optional(Type.String({ description: "Short main status phrase" })),
			}),
			async execute(_toolCallId, params) {
				if (!params.team && params.word === undefined && params.phrase === undefined) {
					return toolResult({ teams: allStatuses(owner) });
				}
				const team = resolveTeam(owner, params.team);
				updateStatus(team, "main", params.word, params.phrase);
				appendTeamLog(team, {
					team: team.name,
					teammate: "main",
					direction: "runtime",
					kind: "status",
					summary: preview(`${params.word ?? ""} ${params.phrase ?? ""}`.trim()),
				});
				return toolResult({ team: team.name, status: formatStatus(team) });
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "teamlog",
			label: "Team Log",
			description: "Inspect a compact, paged, filterable event log for a pi-simple-team team.",
			promptSnippet: "Inspect team event log",
			renderShell: "self",
			renderCall: (args, theme, context) => renderTeamToolCall("teamlog", args, theme, context),
			renderResult: (result, options, theme, context) => renderTeamToolResult("teamlog", result, options, theme, context),
			parameters: Type.Object({
				team: Type.Optional(Type.String({ description: "Team name; optional only when exactly one team exists" })),
				teammate: Type.Optional(Type.String({ description: "Filter to one teammate name" })),
				kind: Type.Optional(Type.String({ description: "Filter to one normalized event kind" })),
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
			renderCall: (args, theme, context) => renderTeamToolCall("team_shutdown", args, theme, context),
			renderResult: (result, options, theme, context) => renderTeamToolResult("team_shutdown", result, options, theme, context),
			parameters: Type.Object({
				team: Type.Optional(Type.String({ description: "Team name; optional only when exactly one team exists" })),
			}),
			async execute(_toolCallId, params) {
				const team = resolveTeam(owner, params.team);
				const teammates = [...team.members.keys()];
				shutdownTeam(team);
				closeCallbackServerIfUnused();
				return toolResult({ stopped: true, team: team.name, teammates });
			},
		}),
	);
}

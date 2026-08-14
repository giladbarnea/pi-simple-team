import * as http from "node:http";
import { defineTool, getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatContextWindowReport, requireKnownContextUsage } from "./context-window.ts";
import { renderTeamMessage } from "./render.ts";

type JsonRecord = Record<string, unknown>;

const teamMessageType = "pi-simple-team";
const defaultVisibleInterruptWaitTimeoutMilliseconds = 25_000;
const visibleLifecycleRetryAttempts = 3;

export interface ChildRuntimeConfig {
	callbackUrl: string;
	callbackToken: string;
	teamId?: string;
	teamName: string;
	teammateName: string;
	visible: boolean;
	participants: string[];
	canOverseeOwnTeams: boolean;
	interruptWaitTimeoutMilliseconds?: number;
}

function requiredEnvironmentVariable(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

function readParticipants(): string[] {
	const value = requiredEnvironmentVariable("PI_SIMPLE_TEAM_PARTICIPANTS");
	const participants = JSON.parse(value) as unknown;
	if (!Array.isArray(participants) || participants.some((participant) => typeof participant !== "string")) {
		throw new Error("PI_SIMPLE_TEAM_PARTICIPANTS must be a JSON string array");
	}
	return participants;
}

function readRequiredChildRuntimeConfig(): ChildRuntimeConfig {
	const teamId = requiredEnvironmentVariable("PI_SIMPLE_TEAM_TEAM");
	return {
		callbackUrl: requiredEnvironmentVariable("PI_SIMPLE_TEAM_CALLBACK_URL"),
		callbackToken: requiredEnvironmentVariable("PI_SIMPLE_TEAM_CALLBACK_TOKEN"),
		teamId,
		teamName: process.env.PI_SIMPLE_TEAM_TEAM_NAME ?? teamId,
		teammateName: requiredEnvironmentVariable("PI_SIMPLE_TEAM_MEMBER"),
		visible: process.env.PI_SIMPLE_TEAM_VISIBLE_CHILD === "1",
		participants: readParticipants(),
		canOverseeOwnTeams: process.env.PI_SIMPLE_TEAM_CAN_OVERSEE_OWN_TEAMS === "1",
	};
}

export function readChildRuntimeConfig(): ChildRuntimeConfig | undefined {
	if (process.env.PI_SIMPLE_TEAM_CHILD !== "1") return undefined;
	return readRequiredChildRuntimeConfig();
}

export async function callParent(config: ChildRuntimeConfig, tool: string, args: JsonRecord, signal?: AbortSignal): Promise<JsonRecord> {
	const response = await fetch(config.callbackUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			token: config.callbackToken,
			team: config.teamId ?? config.teamName,
			from: config.teammateName,
			tool,
			args,
		}),
		signal,
	});

	if (!response.ok) {
		throw new Error(`team runtime rejected ${tool}: ${response.status} ${await response.text()}`);
	}

	return (await response.json()) as JsonRecord;
}

function toolResult(payload: JsonRecord): { content: [{ type: "text"; text: string }]; details: JsonRecord } {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
		details: payload,
	};
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: JsonRecord): void {
	const body = JSON.stringify(payload);
	response.writeHead(statusCode, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body),
	});
	response.end(body);
}

async function readJsonBody(request: http.IncomingMessage): Promise<JsonRecord> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRecord;
}

interface VisibleDelivery {
	team: string;
	from: string;
	to: string;
	sentAt: string;
	message: string;
	formattedMessage: string;
	interrupt: boolean;
}

function startVisibleChild(pi: ExtensionAPI, config: ChildRuntimeConfig): void {
	let server: http.Server | undefined;
	let activeContext: ExtensionContext | undefined;
	let idle = true;
	let idleWaiters: Array<() => void> = [];
	let lifecycleQueue: Promise<void> = Promise.resolve();
	let lifecycleError: Error | undefined;

	const notifyParent = (event: JsonRecord): Promise<void> => {
		lifecycleQueue = lifecycleQueue.then(async () => {
			if (lifecycleError) return;
			for (let attempt = 1; attempt <= visibleLifecycleRetryAttempts; attempt += 1) {
				try {
					await callParent(config, "visible_event", { event });
					return;
				} catch (error) {
					if (attempt === visibleLifecycleRetryAttempts) lifecycleError = error instanceof Error ? error : new Error(String(error));
				}
			}
		});
		return lifecycleQueue;
	};

	const waitForIdle = async (): Promise<void> => {
		if (idle) return;
		await new Promise<void>((resolve, reject) => {
			let resolveIdle: () => void;
			const timeout = setTimeout(() => {
				idleWaiters = idleWaiters.filter((waiter) => waiter !== resolveIdle);
				reject(new Error("Timed out waiting for visible child to settle after interrupt"));
			}, config.interruptWaitTimeoutMilliseconds ?? defaultVisibleInterruptWaitTimeoutMilliseconds);
			resolveIdle = (): void => {
				clearTimeout(timeout);
				resolve();
			};
			idleWaiters.push(resolveIdle);
		});
	};

	const markIdle = (): void => {
		idle = true;
		activeContext = undefined;
		const waiters = idleWaiters;
		idleWaiters = [];
		for (const resolve of waiters) resolve();
	};

	pi.on("agent_start", (event, context) => {
		idle = false;
		activeContext = context;
		notifyParent({ type: "agent_start" });
	});
	pi.on("agent_end", (event) => {
		notifyParent({ type: "agent_end", messages: event.messages });
	});
	pi.on("agent_settled", () => {
		notifyParent({ type: "agent_settled" });
		markIdle();
	});
	pi.on("tool_execution_start", (event) => {
		notifyParent({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
	});
	pi.on("tool_execution_end", (event) => {
		notifyParent({ type: "tool_execution_end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, result: event.result });
	});
	pi.on("session_start", async (_event, context) => {
		server = http.createServer((request, response) => {
			void (async () => {
				try {
					const body = await readJsonBody(request);
					if (body.token !== config.callbackToken) {
						writeJson(response, 403, { error: "invalid token" });
						return;
					}

					if (body.tool === "report_context_window") {
						writeJson(response, 200, { contextUsage: requireKnownContextUsage(context.getContextUsage()) });
						return;
					}

					if (body.tool !== "deliver") {
						writeJson(response, 400, { error: `unknown tool: ${String(body.tool)}` });
						return;
					}

					const delivery = body.args as unknown as VisibleDelivery;
					if (lifecycleError) throw new Error(`Visible lifecycle callback failed: ${lifecycleError.message}`);
					if (delivery.interrupt && activeContext) {
						activeContext.abort();
						await waitForIdle();
					}

					pi.sendMessage(
						{
							customType: teamMessageType,
							content: delivery.formattedMessage,
							display: true,
							details: {
								team: delivery.team,
								from: delivery.from,
								to: delivery.to,
								sentAt: delivery.sentAt,
								message: delivery.message,
							},
						},
						{ deliverAs: "steer", triggerTurn: true },
					);
					writeJson(response, 200, { accepted: true, team: config.teamName, from: delivery.from, to: delivery.to, interrupt: delivery.interrupt });
				} catch (error) {
					writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
				}
			})();
		});

		await new Promise<void>((resolve, reject) => {
			server!.once("error", reject);
			server!.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Visible teammate server did not get a port");

		try {
			await callParent(config, "visible_register", {
				url: `http://127.0.0.1:${address.port}/deliver`,
				sessionId: context.sessionManager.getSessionId(),
				sessionFile: context.sessionManager.getSessionFile(),
			});
		} catch (error) {
			context.shutdown();
			throw error;
		}
	});

	pi.on("session_shutdown", async (event) => {
		markIdle();
		await notifyParent({ type: "session_shutdown", reason: event.reason });
		await new Promise<void>((resolve, reject) => {
			if (!server) {
				resolve();
				return;
			}
			server.close((error) => (error ? reject(error) : resolve()));
		});
	});
}

export function registerChildTools(pi: ExtensionAPI, config: ChildRuntimeConfig): void {
	pi.registerMessageRenderer(teamMessageType, (message, _options, theme) => renderTeamMessage(message, theme, getMarkdownTheme(), config.participants));
	const startupRosterInstruction = `Participants: main, ${config.participants.join(", ")}.`;
	pi.on("before_agent_start", async (event, context) => {
		const teamContext = await callParent(config, "team_context", {}, context.signal);
		const rawParticipants: unknown = teamContext.participants;
		if (!Array.isArray(rawParticipants) || rawParticipants.some((participant: unknown) => typeof participant !== "string")) {
			throw new Error("team runtime returned an invalid participant list");
		}
		const participants = rawParticipants as string[];
		if (!event.systemPrompt.includes(startupRosterInstruction)) {
			throw new Error("team runtime could not find its startup roster instruction");
		}
		config.participants.splice(0, config.participants.length, ...participants);
		return {
			systemPrompt: event.systemPrompt.replace(
				startupRosterInstruction,
				`Participants: main, ${participants.join(", ")}.`,
			),
		};
	});
	if (config.visible) startVisibleChild(pi, config);

	pi.registerTool(
		defineTool({
			name: "report_context_window",
			label: "Report Context Window",
			description: "Report your current context-window use.",
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal, _onUpdate, context) {
				const text = formatContextWindowReport("You have", requireKnownContextUsage(context.getContextUsage()));
				return { content: [{ type: "text" as const, text }], details: {} };
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "teamsend",
			label: "Team Send",
			description: "Send a message to teammate(s) (not main). To message the main agent, use teammain. Returns once the runtime accepts the send request, not after recipients reply.",
			parameters: Type.Object({
				to: Type.Array(Type.String(), { description: "Recipient teammate names" }),
				message: Type.String({ description: "Message to send" }),
				interrupt: Type.Optional(Type.Boolean({ description: "Abort busy recipients before delivering this message." })),
			}),
			async execute(_toolCallId, params, signal) {
				return toolResult(await callParent(config, "teamsend", params, signal));
			},
		}),
	);

	// TODO: should be renamed `sendmain` across the project.
	pi.registerTool(
		defineTool({
			name: "teammain",
			label: "Team Main",
			description: "Send a message to the main agent.",
			parameters: Type.Object({
				message: Type.String({ description: "Message to send to the main agent" }),
			}),
			async execute(_toolCallId, params, signal) {
				return toolResult(await callParent(config, "teammain", params, signal));
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "teamstatus",
			label: "Team Status",
			description: "Set your public status and read everyone's public status.",
		// TODO: If this typing system supports it, I want gerund and phrase optionality to be a XOR
			parameters: Type.Object({
				gerund: Type.Optional(Type.String({ description: "One-word gerund status." })),
				phrase: Type.Optional(Type.String({ description: "Short status phrase. Verb-oriented." })),
			}),
			async execute(_toolCallId, params, signal) {
				return toolResult(await callParent(config, "teamstatus", params, signal));
			},
		}),
	);
}

export default function (pi: ExtensionAPI) {
	registerChildTools(pi, readRequiredChildRuntimeConfig());
}

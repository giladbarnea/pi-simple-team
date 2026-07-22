import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type JsonRecord = Record<string, unknown>;

export interface ChildRuntimeConfig {
	callbackUrl: string;
	callbackToken: string;
	teamName: string;
	teammateName: string;
}

function requiredEnvironmentVariable(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

function readRequiredChildRuntimeConfig(): ChildRuntimeConfig {
	return {
		callbackUrl: requiredEnvironmentVariable("PI_SIMPLE_TEAM_CALLBACK_URL"),
		callbackToken: requiredEnvironmentVariable("PI_SIMPLE_TEAM_CALLBACK_TOKEN"),
		teamName: requiredEnvironmentVariable("PI_SIMPLE_TEAM_TEAM"),
		teammateName: requiredEnvironmentVariable("PI_SIMPLE_TEAM_MEMBER"),
	};
}

export function readChildRuntimeConfig(): ChildRuntimeConfig | undefined {
	if (process.env.PI_SIMPLE_TEAM_CHILD !== "1") return undefined;
	return readRequiredChildRuntimeConfig();
}

async function callParent(config: ChildRuntimeConfig, tool: string, args: JsonRecord, signal?: AbortSignal): Promise<JsonRecord> {
	const response = await fetch(config.callbackUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			token: config.callbackToken,
			team: config.teamName,
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

export function registerChildTools(pi: ExtensionAPI, config: ChildRuntimeConfig): void {
	pi.registerTool(
		defineTool({
			name: "teamsend",
			label: "Team Send",
			description: "Send a message to teammates. To message the main agent, use teammain. Returns once the runtime accepts the send request, not after recipients reply.",
			promptSnippet: "Send a message to teammate(s)",
			promptGuidelines: [
				"Use teamsend to talk to teammates. It is fire-and-forget: do not wait for a reply unless a teammate later sends one.",
			],
			parameters: Type.Object({
				to: Type.Array(Type.String(), { description: "Recipient teammate names" }),
				message: Type.String({ description: "Message to send" }),
				interrupt: Type.Optional(Type.Boolean({ description: "Abort busy recipients before delivering this message" })),
			}),
			async execute(_toolCallId, params, signal) {
				return toolResult(await callParent(config, "teamsend", params, signal));
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "teammain",
			label: "Team Main",
			description: "Send a message to the main agent/team lead. The main agent is never interrupted.",
			promptSnippet: "Send a message to the main agent/team lead",
			promptGuidelines: ["Use teammain to update or ask the main agent. The main agent may receive it later if busy."],
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
			promptSnippet: "Set/read the public team status map",
			parameters: Type.Object({
				word: Type.Optional(Type.String({ description: "One-word status" })),
				phrase: Type.Optional(Type.String({ description: "Short status phrase" })),
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

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
			description: "Send a message to teammate(s) (not main). To message the main agent, use teammain. Returns once the runtime accepts the send request, not after recipients reply.",
			promptSnippet: "Send a message to teammate(s)",
			promptGuidelines: [
				"Use teamsend to talk to teammates. From your POV (sender), it is fire-and-forget. From the recipient’s POV, it’s pushed to context as soon as possible.",
			],
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
			promptSnippet: "Send a message to the main agent.",
			promptGuidelines: ["Use teammain to update or ask the main agent. Main agent sees the big picture and has been aware of the team’s actions and status updates since the team was created."],
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

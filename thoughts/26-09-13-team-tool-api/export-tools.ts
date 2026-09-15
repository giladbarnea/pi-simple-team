import * as fs from "node:fs";
import * as path from "node:path";
import teamExtension from "../../index.ts";

type Tool = { name: string; description: string; promptSnippet?: string; promptGuidelines?: string[]; parameters: unknown };
type Handler = (event: object, context: object) => unknown;
const output: Record<string, Tool[]> = {};
const environment = {
	PI_SIMPLE_TEAM_CHILD: "1", PI_SIMPLE_TEAM_CALLBACK_URL: "http://127.0.0.1:1/callback",
	PI_SIMPLE_TEAM_CALLBACK_TOKEN: "export-only", PI_SIMPLE_TEAM_TEAM: "parent-id",
	PI_SIMPLE_TEAM_TEAM_NAME: "parent", PI_SIMPLE_TEAM_MEMBER: "member",
	PI_SIMPLE_TEAM_PARTICIPANTS: '["member","peer"]', PI_SIMPLE_TEAM_CAN_MANAGE_OWN_TEAMS: "0",
};
const original = Object.fromEntries(Object.keys(environment).map((name) => [name, process.env[name]]));
try {
	for (const role of ["main", "manager", "member"]) {
		for (const name of Object.keys(environment)) delete process.env[name];
		if (role !== "main") Object.assign(process.env, environment, { PI_SIMPLE_TEAM_CAN_MANAGE_OWN_TEAMS: role === "manager" ? "1" : "0" });
		const tools = new Map<string, Tool>();
		const starts: Handler[] = [];
		const api = {
			on: (event: string, handler: Handler) => { if (event === "session_start") starts.push(handler); },
			registerTool: (tool: Tool) => tools.set(tool.name, tool),
			registerCommand: () => undefined, registerMessageRenderer: () => undefined,
		} as unknown as Parameters<typeof teamExtension>[0];
		teamExtension(api);
		if (role !== "member") await starts.at(-1)!({}, { scopedModels: [{ model: { provider: "provider", id: "model" } }] });
		output[role] = [...tools.values()].map(({ name, description, promptSnippet, promptGuidelines, parameters }) => ({ name, description, promptSnippet, promptGuidelines, parameters }));
	}
	fs.writeFileSync(path.join(import.meta.dir, "registered-tools.json"), JSON.stringify(output, null, 2) + "\n");
} finally {
	for (const [name, value] of Object.entries(original)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import teamExtension from "../index.ts";
import { loadAsBunStandalonePi } from "./pi-launch.ts";

type JsonRecord = Record<string, unknown>;
type Tool = { execute: (id: string, params: JsonRecord, signal: AbortSignal, update: undefined, context: ExtensionContext) => Promise<unknown> };
const [projectDirectory, selector, launcher] = process.argv.slice(2);
const tools = new Map<string, Tool>();
const handlers = new Map<string, Array<(event: JsonRecord, context: ExtensionContext) => Promise<void>>>();
const context = {
	cwd: projectDirectory, modelRegistry: { getAvailable: () => [{ provider: "local", id: "a" }] },
	sessionManager: { getCwd: () => projectDirectory, getSessionId: () => "competing-main", getEntries: () => [] },
} as unknown as ExtensionContext;
const api = {
	on: (event: string, handler: (event: JsonRecord, context: ExtensionContext) => Promise<void>) => handlers.set(event, [...handlers.get(event) ?? [], handler]),
	registerCommand: () => undefined, registerMessageRenderer: () => undefined, sendMessage: () => undefined,
	registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
} as unknown as ExtensionAPI;
loadAsBunStandalonePi(launcher, () => teamExtension(api));
try {
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, context);
	const result = await tools.get("team_spawn")!.execute("competing", { teamName: "second", commonPrompt: "Wait.", startIdle: true, teammates: [{ name: "loser", systemPrompt: "Wait.", session: selector }] }, new AbortController().signal, undefined, context);
	console.log(JSON.stringify({ result }));
} catch (error) {
	console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
} finally {
	for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "new" }, context);
}

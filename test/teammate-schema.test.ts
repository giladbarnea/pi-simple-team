import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import teamExtension from "../index.ts";

type ToolResultMessage = Extract<AgentSession["messages"][number], { role: "toolResult" }>;

async function withFauxSession(run: (session: AgentSession, call: (name: string, arguments_: ToolCall["arguments"]) => Promise<ToolResultMessage>, enteredTools: string[]) => Promise<void>): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "pi-team-schema-"));
	const faux = fauxProvider();
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const enteredTools: string[] = [];
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [teamExtension, createCodemodeExtension(), (pi: ExtensionAPI) => {
			pi.on("tool_call", (event) => { enteredTools.push(event.toolName); });
		}],
	});
	await resourceLoader.reload();
	const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models-store.json"), refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	const { session } = await createAgentSession({
		cwd: directory, agentDir: directory, model: faux.getModel(), modelRuntime, settingsManager, resourceLoader,
		sessionManager: SessionManager.inMemory(directory),
	});
	await session.bindExtensions({});
	session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
	const call = async (name: string, arguments_: ToolCall["arguments"]): Promise<ToolResultMessage> => {
		const id = crypto.randomUUID();
		faux.setResponses([fauxAssistantMessage(fauxToolCall(name, arguments_, { id }), { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
		await session.prompt("Run the scripted tool call.");
		const result = session.messages.find((message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === id);
		assert.ok(result, `Pi must return the scripted ${name} tool result. Messages: ${JSON.stringify(session.messages)}`);
		return result;
	};
	try {
		await run(session, call, enteredTools);
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "new" });
		session.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
}

for (const name of ["team_spawn", "team_add_teammates"]) test(`${name} exposes teammate fields and conditional requirements through codemode discovery`, async () => {
	await withFauxSession(async (_session, call) => {
		const result = await call("codemode", { code: `text(await describeTool(${JSON.stringify(name)}));` });
		const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		assert.equal(result.isError, false, text);
		for (const field of ["name: string", "systemPrompt: string", "model?: string", "session?: string", "forkContext?: boolean", "thinking?:", "extensionPaths?: Array<string>", "canManageOwnTeams?: boolean", "showOnHerdrPane?: boolean"]) {
			assert.ok(text.includes(field), `Agents must discover ${field} without reading implementation source. Actual discovery: ${text}`);
		}
		assert.match(text, /Required without session/, "Discovery must explain the required model for a new teammate.");
		assert.match(text, /forkContext[\s\S]*Defaults to false|Defaults to false[\s\S]*forkContext/, "Discovery must retain the fresh-context default.");
		assert.match(text, /Defaults to xhigh without session; with session, omission restores Pi's settings/, "Discovery must preserve the distinct new and attachment defaults.");
	});
});

for (const name of ["team_spawn", "team_add_teammates"]) test(`${name} diagnoses a missing new/fork model before executing any teammate request`, async () => {
	await withFauxSession(async (_session, call, enteredTools) => {
		for (const extra of [{ forkContext: true }, {}, { inheritMainContext: true }]) {
			const result = await call(name, { ...(name === "team_spawn" ? { teamName: "invalid", commonPrompt: "Wait." } : {}), teammates: [{ name: "reviewer", systemPrompt: "Wait.", ...extra }] });
			const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			assert.equal(result.isError, true, text);
			const diagnosis = text.split("Received arguments:")[0];
			assert.match(diagnosis, /teammates\.0\.model:/, `A new teammate requires model, not a session attachment. Got: ${diagnosis}`);
			assert.doesNotMatch(diagnosis, /teammates\.0\.session:/, "Do not suggest attaching a session when creating a new teammate.");
			if ("inheritMainContext" in extra) assert.match(diagnosis, /inheritMainContext/, "The unapproved alias must remain rejected.");
		}
		assert.deepEqual(enteredTools, [], "Invalid arguments must never enter tool execution or start teammates.");
		const status = await call("team_status", {});
		assert.equal(status.isError, false);
		assert.deepEqual(status.details, { teams: [] }, "Invalid requests must leave no team state.");
	});
});

for (const name of ["team_spawn", "team_add_teammates"]) test(`${name} preserves accepted new, fork and session inputs through native argument validation`, async () => {
	await withFauxSession(async (session) => {
		const tool = session.getAllTools().find((tool) => tool.name === name)!;
		const validate = (teammate: Record<string, unknown>): unknown => validateToolArguments(tool, fauxToolCall(name, {
			...(name === "team_spawn" ? { teamName: "valid", commonPrompt: "Wait." } : {}), teammates: [teammate],
		}));
		const required = { name: "reviewer", systemPrompt: "Wait." };
		for (const settings of [
			{ model: "faux/faux-1" },
			{ model: "faux/faux-1", forkContext: true },
			{ session: "saved-session" },
			{ session: "/sessions/saved.jsonl", model: "faux/faux-1", thinking: "high", forkContext: false },
			{ model: "faux/faux-1", thinking: "max", forkContext: false, canManageOwnTeams: true, showOnHerdrPane: true, extensionPaths: ["/trusted/extension.ts"] },
		]) {
			const teammate = { ...required, ...settings };
			const validated = validate(teammate) as { teammates: unknown[] };
			assert.deepEqual(validated.teammates, [teammate], "Validation must preserve explicit settings and leave defaults to execution.");
		}
		const normalized = validate({ ...required, model: "faux/faux-1", session: null, thinking: null, forkContext: null }) as { teammates: unknown[] };
		assert.deepEqual(normalized.teammates, [{ ...required, model: "faux/faux-1" }], "Pi's optional-null normalization must still permit new teammates.");
		for (const invalid of [
			{ systemPrompt: "Wait.", model: "faux/faux-1" },
			{ name: "reviewer", model: "faux/faux-1" },
			{ ...required, model: "faux/faux-1", unknown: true },
			{ ...required, session: "saved-session", unknown: true },
			{ ...required, session: "" },
			{ ...required, model: "faux/faux-1", thinking: "off" },
			{ ...required, model: "faux/faux-1", extensionPaths: ["/duplicate", "/duplicate"] },
		]) assert.throws(() => validate(invalid), /Validation failed/, `Invalid teammate must stay rejected: ${JSON.stringify(invalid)}`);
	});
});

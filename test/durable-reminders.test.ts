import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setSystemTime, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const extensionPath = path.resolve(import.meta.dir, "..", "index.ts");

/** Starts a Pi session on `sessionManager` with the extension loaded, as one Pi process of that session. */
async function startSession(directory: string, sessionManager: SessionManager, faux: FauxProviderHandle, errors: unknown[]) {
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey(faux.provider.id, "local-test");
	const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, additionalExtensionPaths: [extensionPath], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: directory, agentDir: directory, model: faux.getModel(), modelRuntime, resourceLoader, sessionManager,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
	});
	// A bound error listener makes the SDK emit session_start on reload too, as interactive Pi does.
	await session.bindExtensions({ onError: (error) => errors.push(error) });
	return session;
}

async function stopSession(session: Awaited<ReturnType<typeof startSession>>): Promise<void> {
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
	assert.ok(predicate(), `Timed out waiting for ${label}`);
}

const reminderMessages = (sessionManager: SessionManager) => sessionManager.getEntries().flatMap((entry) => entry.type === "custom_message" && entry.customType === "pi-simple-team-reminder" ? [String(entry.content)] : []);

test("an armed reminder survives /reload and a restart, fires late once on start, and is never delivered again", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-durable-reminders-"));
	const faux = fauxProvider({ models: [{ id: "faux-reminders" }] });
	const errors: unknown[] = [];
	process.env.TZ = "Asia/Jerusalem";
	setSystemTime(new Date("2026-11-07T08:47:00Z"));
	let session: Awaited<ReturnType<typeof startSession>> | undefined;
	try {
		const firstProcess = SessionManager.create(directory, path.join(directory, "sessions"));
		session = await startSession(directory, firstProcess, faux, errors);
		faux.setResponses([fauxAssistantMessage([fauxToolCall("schedule_reminder", { delayMinutes: 30, message: "Durable." })]), fauxAssistantMessage("Armed.")]);
		await session.prompt("Arm a reminder.");

		await session.reload();
		faux.setResponses([fauxAssistantMessage([fauxToolCall("list_reminders", {})]), fauxAssistantMessage("Listed.")]);
		await session.prompt("List reminders.");
		const listResult = session.messages.findLast((message) => message.role === "toolResult" && message.toolName === "list_reminders");
		const listed = JSON.parse((listResult as { content: Array<{ text: string }> }).content[0]!.text) as { reminders: Array<{ id: string; slug: string }> };
		assert.deepEqual(listed.reminders.map((reminder) => reminder.id), ["reminder-1"], "list_reminders reads the reminder armed before /reload.");
		const slug = listed.reminders[0]!.slug;
		const sessionFile = firstProcess.getSessionFile()!;
		await stopSession(session);
		session = undefined;

		setSystemTime(new Date("2026-11-07T10:47:00Z"));
		faux.setResponses([fauxAssistantMessage("Woke.")]);
		const secondProcess = SessionManager.open(sessionFile);
		session = await startSession(directory, secondProcess, faux, errors);
		await waitFor(() => session!.messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("Woke.")), "the late reminder's turn");
		assert.match(reminderMessages(secondProcess).join("\n---\n"), new RegExp(`^Reminder ${slug} wake up: it's Nov 7, 2026, 12:47pm GMT\\+2 now\\. It is 1h and 30m late: it was due at Nov 7, 2026, 11:17am GMT\\+2\\.\\n\\nDurable\\.$`));
		await stopSession(session);
		session = undefined;

		const thirdProcess = SessionManager.open(sessionFile);
		session = await startSession(directory, thirdProcess, faux, errors);
		await Bun.sleep(300);
		assert.equal(reminderMessages(thirdProcess).length, 1, "A delivered reminder is not delivered again on the next start.");
		assert.deepEqual(errors, []);
	} finally {
		if (session) await stopSession(session);
		setSystemTime();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

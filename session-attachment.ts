import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { latestReminderRecords } from "./reminder-records.ts";
import { canonicalProjectDirectory } from "./team-registry.ts";

export interface SessionAttachment {
	id: string;
	file?: string;
	previousTeam?: string;
}

/** Resolves an exact project ID or existing absolute JSONL without opening a writable session. */
export function resolveSessionAttachment(selector: string, projectDirectory: string): SessionAttachment {
	try {
		const absolute = path.isAbsolute(selector);
		if (!absolute) SessionManager.inMemory(projectDirectory, { id: selector });
		const file = absolute ? selector : SessionManager.findById(projectDirectory, selector);
		if (!file) return { id: selector };
		const entries = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as FileEntry);
		const header = entries[0];
		if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") throw new Error(`Session at ${file} has no valid Pi session header.`);
		if (canonicalProjectDirectory(header.cwd) !== projectDirectory) throw new Error(`Session ${header.id} at ${file} belongs to project ${header.cwd}, not ${projectDirectory}. Cross-project attachment is not supported (#39).`);
		const session = SessionManager.inMemory(projectDirectory, undefined, entries);
		// #19: use the extracted reminder package's records/API when reminders move out.
		const pending = [...latestReminderRecords(session.getEntries(), header.id).values()].filter((record) => record.state === "pending");
		if (pending.length > 0) throw new Error(`Session ${header.id} at ${file} has ${pending.length} pending reminder(s): ${pending.map((record) => `${record.id} (${record.slug})`).join(", ")}. Resolve them in the original session before attaching.`);
		const breadcrumb = session.getEntries().find((entry) => entry.type === "custom" && entry.customType === "pi-simple-team-teammate" && (entry.data as { sessionId?: string })?.sessionId === header.id);
		const provenance = breadcrumb?.type === "custom" ? breadcrumb.data as { teamId: string; parentSessionId: string } : undefined;
		return { id: header.id, file: fs.realpathSync(file), ...(provenance ? { previousTeam: `team ${provenance.teamId}, main ${provenance.parentSessionId}` } : {}) };
	} catch (error) {
		throw new Error(`Cannot attach session ${selector} in project ${projectDirectory}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

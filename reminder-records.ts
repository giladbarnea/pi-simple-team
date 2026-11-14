import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface ReminderRecord {
	sessionId: string;
	id: string;
	slug: string;
	message: string;
	armedAt: string;
	wakeAt: string;
	state: "pending" | "delivered" | "cancelled";
}

export const reminderType = "pi-simple-team-reminder";

/** Select this session’s latest reminder records across all branches. @example latestReminderRecords([], "s").size // 0 */
export function latestReminderRecords(entries: readonly SessionEntry[], sessionId: string | undefined): Map<string, ReminderRecord> {
	return new Map(entries
		.flatMap((entry) => entry.type === "custom" && entry.customType === reminderType && (entry.data as ReminderRecord).sessionId === sessionId ? [entry.data as ReminderRecord] : [])
		.map((record) => [record.id, record]));
}

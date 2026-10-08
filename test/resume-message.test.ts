import assert from "node:assert/strict";
import { test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { composeResumptionMessage, lastRecordedModelActivity } from "../resume-message.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const response: SessionEntry = {
	type: "message", id: "response", parentId: null, timestamp: "2026-02-03T14:05:06.000Z",
	message: { role: "assistant", content: [{ type: "text", text: "Previous work." }], api: "openai-completions", provider: "local-test", model: "probe", stopReason: "stop", usage, timestamp: 1 },
};
const toolResult: SessionEntry = {
	type: "message", id: "tool", parentId: "response", timestamp: "2026-02-03T14:06:07.000Z",
	message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [], isError: false, timestamp: 2 },
};
const tail: SessionEntry[] = [
	{ type: "custom", id: "status", parentId: "tool", timestamp: "2026-02-04T00:00:00.000Z", customType: "status", data: { word: "idle" } },
	{ type: "custom_message", id: "staged", parentId: "status", timestamp: "2026-02-05T00:00:00.000Z", customType: "staged", content: "Not yet consumed.", display: false },
	{ type: "message", id: "user", parentId: "staged", timestamp: "2026-02-06T00:00:00.000Z", message: { role: "user", content: "Input without recorded consumption.", timestamp: 3 } },
	{ type: "usage", id: "warming", parentId: "user", timestamp: "2026-02-07T00:00:00.000Z", kind: "cache_warm", provider: "local-test", model: "probe", usage },
];

test("last activity is recorded model work, not later input, status, or cache warming", () => {
	assert.equal(lastRecordedModelActivity([response, toolResult, ...tail]), toolResult.timestamp, "A tool result is the latest direct activity evidence.");
	assert.equal(lastRecordedModelActivity([response, ...tail]), response.timestamp, "Trailing input and bookkeeping do not prove another model turn.");
	assert.equal(lastRecordedModelActivity(tail), undefined, "Do not invent model activity from staged input and metadata alone.");
	assert.equal(lastRecordedModelActivity([]), undefined, "A never-used session has no previous activity.");
});

test("model-attributed summaries count, while unattributed structural summaries do not", () => {
	const compaction: SessionEntry = { type: "compaction", id: "summary", parentId: "response", timestamp: "2026-02-08T00:00:00.000Z", summary: "Summary", firstKeptEntryId: "response", tokensBefore: 100, usage };
	const branchSummary: SessionEntry = { type: "branch_summary", id: "branch-summary", parentId: "summary", timestamp: "2026-02-09T00:00:00.000Z", summary: "Branch summary", fromId: "response", usage };
	assert.equal(lastRecordedModelActivity([response, compaction]), compaction.timestamp, "Recorded model-generated compaction is activity.");
	assert.equal(lastRecordedModelActivity([response, compaction, branchSummary]), branchSummary.timestamp, "Recorded model-generated branch summarization is activity.");
	const { usage: _usage, ...unattributed } = branchSummary;
	assert.equal(lastRecordedModelActivity([response, unattributed]), response.timestamp, "A structural summary without model evidence must not fabricate activity.");
});

test("resume text grounds identity, readable zoned times, and current team direction before optional instructions", () => {
	const instructions = "Review the current change only.";
	const message = composeResumptionMessage("review", "scout", response.timestamp, instructions, new Date("2026-03-04T12:30:45.000Z"));
	assert.match(message, /^You are teammate "scout" on team "review"\. This session has resumed\./, "A resume must retain its current team and teammate identity.");
	assert.match(message, /Current time: \d{2} [A-Z][a-z]{2} 2026(?: at |, )\d{2}:\d{2}:\d{2} GMT(?:[+-]\d{2}:\d{2})?\./, "Current time must include a readable date, clock, and explicit timezone.");
	assert.match(message, /Your last recorded model activity was \d{2} [A-Z][a-z]{2} 2026(?: at |, )\d{2}:\d{2}:\d{2} GMT(?:[+-]\d{2}:\d{2})?\./, "The previous activity needs the same readable time grammar.");
	assert.match(message, /take precedence over earlier team assignments/, "Precedence must refer to team assignments, not host/system safety instructions.");
	assert.ok(message.endsWith(instructions), "Optional instructions follow the grounding text.");
	assert.doesNotMatch(message, /\d{4}-\d{2}-\d{2}T/, "The briefing should not expose machine-format timestamps.");
});

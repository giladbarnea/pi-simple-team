import { describe, test, expect } from "bun:test";
import { bundledAiToAiSkillInstruction } from "../bundled-skill.ts";
import { composeSystemPrompt } from "../system-prompt.ts";

function prompt(): string {
	return composeSystemPrompt("demo-team", "Team goal.", "Implementer", "Implementer role.", ["Implementer", "Reviewer"]).toLowerCase();
}

function participantPrompt(teammateName: string): string {
	return composeSystemPrompt("demo-team", "Team goal.", teammateName, `${teammateName} role.`, ["Implementer", "Reviewer"]);
}

describe("composeSystemPrompt participant list", () => {
	test("names the same full participant list for every teammate", () => {
		expect(participantPrompt("Implementer")).toContain("Participants: main, Implementer, Reviewer.");
		expect(participantPrompt("Reviewer")).toContain("Participants: main, Implementer, Reviewer.");
	});

	test("instructs every teammate to read the bundled ai-to-ai skill", () => {
		expect(participantPrompt("Implementer")).toContain(bundledAiToAiSkillInstruction);
		expect(participantPrompt("Reviewer")).toContain(bundledAiToAiSkillInstruction);
	});
});

describe("composeSystemPrompt acknowledgement instructions (review issue 2)", () => {
	test("tells the teammate to ack via teamstatus on wake up, before doing substantive work", () => {
		const text = prompt();
		expect(text).toContain("teamstatus");
		expect(text).toMatch(/wake up|start(?:s|ed)?\b.*before|as soon as/s);
	});

	test("tells the teammate to ack via teamstatus before acting on an incoming message", () => {
		const text = prompt();
		expect(text).toMatch(/message.{0,120}teamstatus|teamstatus.{0,120}message/s);
	});
});

describe("composeSystemPrompt proactive handoff instruction (review issue 3)", () => {
	test("tells the teammate to notify the blocking party before setting a waiting status", () => {
		const text = prompt();
		expect(text).toContain("waiting");
		expect(text).toMatch(/teamsend|teammain/);
	});
});

test("does not claim that the current main observed work before a resume", () => {
	const text = prompt();
	expect(text).not.toContain("since the team was created");
	expect(text).toContain("current coordinator");
});

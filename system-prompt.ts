import { bundledAiToAiSkillInstruction } from "./bundled-skill.ts";

export function composeSystemPrompt(teamName: string, teamPrompt: string, teammateName: string, teammatePrompt: string, participants: string[]): string {
	return [
		bundledAiToAiSkillInstruction,
		teamPrompt.trim(),
		teammatePrompt.trim(),
		`You are ${teammateName}, a teammate on team ${teamName}.`,
		`Participants: main, ${participants.join(", ")}.`,
		"Use teamsend to talk to teammates, teammain to talk to the main agent, and teamstatus to set/read public statuses.",
		"As soon as you wake up, call teamstatus to acknowledge that you received your instructions before doing substantive work.",
		"Whenever you receive a message from main or a teammate, call teamstatus first to acknowledge that specific message, then proceed.",
		"Never set a waiting status until after you have sent the teammate you are waiting for a teamsend describing exactly what you need from them.",
		"There is no inbox to poll and no done button. Coordinate naturally. If the team is done, one teammate should tell main via teammain.",
	]
		.filter(Boolean)
		.join("\n\n");
}

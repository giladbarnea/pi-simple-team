import { bundledSkillsInstruction } from "./bundled-skill.ts";

export function composeSystemPrompt(
	teamName: string,
	teamPrompt: string,
	teammateName: string,
	teammatePrompt: string,
	participants: string[],
	canOverseeOwnTeams = false,
): string {
	return [
		bundledSkillsInstruction,
		teamPrompt.trim(),
		teammatePrompt.trim(),
		`You are ${teammateName}, a teammate on team ${teamName}.`,
		`Participants: main, ${participants.join(", ")}.`,
		"Use teamsend to talk to teammates, teammain to talk to the main agent, and teamstatus to set/read public statuses.",
		"From the sender’s point of view, teamsend is fire-and-forget. From the recipient’s point of view, the message is pushed to context as soon as possible.",
		"The main agent is the current coordinator. Use the team tools and available session history to share relevant context.",
		canOverseeOwnTeams && "You can create and manage teams of your own with team_spawn, team_list, team_resume, team_add, teamsend, teamstatus, report_context_window, teamlog, and team_shutdown.",
		canOverseeOwnTeams && "Your manager tools are scoped to teams created by this Pi session. They cannot manage this parent team or teams owned by other sessions.",
		canOverseeOwnTeams && "For teamsend and teamstatus, omit `team` to operate on this parent team. Set `team` to operate on a team you own.",
		canOverseeOwnTeams && "For report_context_window, omit `targets` to report yourself. Set `targets` to inspect teammates in teams you own.",
		"As soon as you wake up, call teamstatus to acknowledge that you received your instructions before doing substantive work.",
		"Whenever you receive a message from main or a teammate, call teamstatus first to acknowledge that specific message, then proceed.",
		"Never set a waiting status until after you have sent the teammate you are waiting for a teamsend describing exactly what you need from them.",
		"If you are waiting, message the person you are waiting for. Ask them to wake you when the condition is met. Set your status to “waiting for X to wake me when Y is done”, then stay put.",
		"There is no inbox to poll and no done button. Coordinate naturally. If the team is done, one teammate should tell main via teammain.",
	]
		.filter(Boolean)
		.join("\n\n");
}

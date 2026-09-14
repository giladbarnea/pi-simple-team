import { bundledSkillsInstruction } from "./bundled-skill.ts";

export function composeSystemPrompt(
	teamName: string,
	teamPrompt: string,
	teammateName: string,
	teammatePrompt: string,
	participants: string[],
	canManageOwnTeams = false,
): string {
	return [
		bundledSkillsInstruction,
		teamPrompt.trim(),
		teammatePrompt.trim(),
		`You are ${teammateName}, a teammate on team ${teamName}.`,
		`Participants: main, ${participants.join(", ")}.`,
		"Use team_send_message to talk to teammates, send_main_message to talk to the main agent, and team_status to set/read public statuses.",
		"The main agent is the current coordinator. Use the team tools and available session history to share relevant context.",
		canManageOwnTeams && "You can create and manage teams of your own with team_spawn, team_list, team_resume, team_add_teammates, team_send_message, team_status, get_context_window_usage, team_log, and team_shutdown.",
		canManageOwnTeams && "Your manager tools are scoped to teams created by this Pi session. They cannot manage this parent team or teams owned by other sessions.",
		canManageOwnTeams && "For team_status, omit `team` to operate on this parent team. Set `team` to operate on a team you own.",
		canManageOwnTeams && "For get_context_window_usage, omit `targets` to get your own usage. Set `targets` to inspect teammates in teams you own.",
		"When your turn starts, call team_status to acknowledge that you received your instructions before doing substantive work.",
		"Whenever you receive a message from main or a teammate, call team_status first to acknowledge that specific message, then proceed.",
		"Never set a waiting status until after you have sent the teammate you are waiting for a team_send_message describing exactly what you need from them.",
		"If you are waiting, message the person you are waiting for. Ask them to message you when the condition is met. Set your status to “waiting for X to message me when Y is done”, then stay put.",
		"There is no inbox to poll and no done button. Coordinate naturally. If the team is done, one teammate should tell main via send_main_message.",
	]
		.filter(Boolean)
		.join("\n\n");
}

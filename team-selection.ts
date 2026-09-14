export interface SelectableTeam {
	teamName: string;
	teamId: string;
	teammates: Array<{ name: string; teammateId: string }>;
}

export interface TeamSelection {
	team: SelectableTeam;
	teammates: SelectableTeam["teammates"];
	wholeTeam: boolean;
}

export const targetDescription = "Team or teammate names or IDs. A team selects all its teammates. Names must be unique in your available teams. Use IDs to resolve duplicate names. Overlapping selections count once.";
export const interruptDescription = "True interrupts all selected recipients. A list uses the same names or IDs as targets and must select only message recipients. False or omitted interrupts none.";

/** @example resolveNamedId([{ name: "scout", id: "session-1" }], "session-1", "teammates").name // "scout" */
function resolveNamedId<Reference extends { name: string; id: string }>(candidates: readonly Reference[], identifier: string, parameter: string): Reference {
	const name = identifier.trim();
	const matches = candidates.filter((candidate) => candidate.id === name || candidate.name === name);
	const choices = (matches.length > 0 ? matches : candidates).map(({ name, id }) => ({ name, id }));
	if (matches.length !== 1) throw new Error(`${matches.length === 0 ? "Unknown" : "Ambiguous"} target ${JSON.stringify(identifier)}. Available choices: ${JSON.stringify(choices)}. Pass the intended ID in ${parameter}.`);
	return matches[0];
}

/** @example resolveTeammates([{ name: "scout", teammateId: "session-1" }], ["scout", "session-1"]).length // 1 */
export function resolveTeammates<Member extends { name: string; teammateId: string }>(teammates: readonly Member[], identifiers: readonly string[]): Member[] {
	const candidates = teammates.map((teammate) => ({ name: teammate.name, id: teammate.teammateId, teammate }));
	return [...new Set(identifiers.map((identifier) => resolveNamedId(candidates, identifier, "teammates").teammate))];
}

/** @example resolveTargets([{ teamName: "review", teamId: "team-1", teammates: [{ name: "scout", teammateId: "session-1" }] }], ["review", "session-1"])[0].teammates.length // 1 */
export function resolveTargets(teams: readonly SelectableTeam[], identifiers: readonly string[]): TeamSelection[] {
	const candidates = teams.flatMap((team) => [
		{ name: team.teamName, id: team.teamId, team, teammate: undefined },
		...team.teammates.map((teammate) => ({ name: teammate.name, id: teammate.teammateId, team, teammate })),
	]);
	const selected = new Map<string, TeamSelection>();
	for (const identifier of identifiers) {
		const match = resolveNamedId(candidates, identifier, "targets");
		const selection = selected.get(match.team.teamId) ?? { team: match.team, teammates: [], wholeTeam: false };
		const additions = match.teammate ? [match.teammate] : match.team.teammates;
		selection.teammates.push(...additions.filter((teammate) => !selection.teammates.some((existing) => existing.teammateId === teammate.teammateId)));
		selection.wholeTeam ||= match.teammate === undefined;
		selected.set(match.team.teamId, selection);
	}
	return [...selected.values()];
}

/** @example interruptedTeammateIds([], [], false).size // 0 */
export function interruptedTeammateIds(teams: readonly SelectableTeam[], recipients: readonly TeamSelection[], interrupt?: boolean | string[]): Set<string> {
	const recipientIds = new Set(recipients.flatMap((selection) => selection.teammates.map((teammate) => teammate.teammateId)));
	if (interrupt === true) return recipientIds;
	const interrupted = resolveTargets(teams, Array.isArray(interrupt) ? interrupt : []).flatMap((selection) => selection.teammates);
	const invalid = interrupted.filter((teammate) => !recipientIds.has(teammate.teammateId));
	if (invalid.length > 0) throw new Error(`interrupt must select only message recipients. Not selected by targets: ${JSON.stringify(invalid)}.`);
	return new Set(interrupted.map((teammate) => teammate.teammateId));
}

/** Main requests one of `low` to `max`. Pi can run a teammate at `off` or `minimal` when the model supports less. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface Teammate {
	name: string;
	systemPrompt: string;
	model: string;
	thinking?: ThinkingLevel;
	forkContext?: boolean;
	canManageOwnTeams?: boolean;
	showOnHerdrPane?: boolean;
	extensionPaths?: string[];
}

export type TeammateRecord = Required<Omit<Teammate, "extensionPaths">> & {
	extensionPaths?: string[];
	teammateId: string;
	sessionFile: string;
	live: boolean;
	active: boolean;
	contextPercent?: number;
};

export type ThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface Teammate {
	name: string;
	systemPrompt: string;
	model: string;
	thinking?: ThinkingLevel;
	inheritMainContext?: boolean;
	canManageOwnTeams?: boolean;
	showOnHerdrPane?: boolean;
}

export type TeammateRecord = Required<Teammate> & {
	teammateId: string;
	sessionFile: string;
	live: boolean;
	active: boolean;
};

export interface ModelReference {
	provider: string;
	id: string;
}

export interface TeammateModelSpec {
	name: string;
	model: string;
}

/** @example formatModelReference({ provider: "anthropic", id: "claude-sonnet-4-6" }) // "anthropic/claude-sonnet-4-6" */
export function formatModelReference(model: ModelReference): string {
	return `${model.provider}/${model.id}`;
}

/** @example formatScopedModelGuidance([{ provider: "anthropic", id: "claude-sonnet-4-6" }]) */
export function formatScopedModelGuidance(scopedModels: readonly ModelReference[]): string {
	const modelReferences = scopedModels.map(formatModelReference);
	return modelReferences.length > 0
		? `You should probably use one of these user-scoped models: ${modelReferences.join(", ")}.`
		: "The user has not defined a list of preferred models explicitly. Figure out which model _you_ are by reading the value of the PI_PROVIDER, PI_MODEL, and PI_REASONING_LEVEL environment variables. That should give you something to start with. Confirm with the user before picking any model id.";
}

export function validateTeammateModels(teammates: readonly TeammateModelSpec[], availableModels: readonly ModelReference[]): void {
	const availableModelReferences = new Set(availableModels.map(formatModelReference));
	const errors = teammates
		.filter((teammate) => !availableModelReferences.has(teammate.model))
		.map((teammate) => `Model ${JSON.stringify(teammate.model)} for teammate ${JSON.stringify(teammate.name)} is not available.`);

	if (errors.length === 0) return;
	throw new Error(`Model preflight failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

type ModelNameSource = Pick<ModelRegistry, "find">;

let modelNameSource: ModelNameSource | undefined;

/** Team screens read model names from the session's Pi model registry, which session_start provides. */
export function useModelNames(registry: ModelNameSource): void {
	modelNameSource = registry;
}

/**
 * Pi's name for a "provider/id" model, for human-facing team screens only: the user's models.json name, else the built-in name.
 * Undefined when Pi does not know the model or no session has started.
 * @example piModelName("anthropic/claude-opus-5-5") // "opus" under a models.json name override
 */
export function piModelName(model: string): string | undefined {
	const slash = model.indexOf("/");
	return modelNameSource?.find(model.slice(0, slash), model.slice(slash + 1))?.name;
}

import { describe, expect, test } from "bun:test";
import { formatModelReference, formatScopedModelGuidance, validateTeammateModels, type ModelReference } from "../model-preflight.ts";

const availableModels: ModelReference[] = [
	{ provider: "openai-codex", id: "gpt-5.6-sol" },
	{ provider: "anthropic", id: "claude-sonnet-4-6" },
];

describe("formatModelReference", () => {
	test("formats a canonical provider/model id", () => {
		expect(formatModelReference(availableModels[0])).toBe("openai-codex/gpt-5.6-sol");
	});
});

describe("formatScopedModelGuidance", () => {
	test("explains how to choose when the session has no scoped models", () => {
		expect(formatScopedModelGuidance([])).toBe(
			"The user has not defined a list of preferred models explicitly. Figure out which model _you_ are by reading the value of the PI_PROVIDER, PI_MODEL, and PI_REASONING_LEVEL environment variables. That should give you something to start with. Confirm with the user before picking any model id.",
		);
	});

	test("lists every scoped model as optional guidance", () => {
		expect(formatScopedModelGuidance(availableModels)).toBe(
			"You should probably use one of these user-scoped models: openai-codex/gpt-5.6-sol, anthropic/claude-sonnet-4-6.",
		);
	});
});

describe("validateTeammateModels", () => {
	test("accepts an available model that is outside the scoped guidance", () => {
		const scopedModels = [availableModels[0]];
		expect(formatScopedModelGuidance(scopedModels)).not.toContain("anthropic/claude-sonnet-4-6");
		expect(() => validateTeammateModels([{ name: "Reviewer", model: "anthropic/claude-sonnet-4-6" }], availableModels)).not.toThrow();
	});

	test("rejects a model absent from all available models", () => {
		expect(() => validateTeammateModels([{ name: "Ghost", model: "openai-codex/missing" }], availableModels)).toThrow(
			'Model "openai-codex/missing" for teammate "Ghost" is not available.',
		);
	});
});

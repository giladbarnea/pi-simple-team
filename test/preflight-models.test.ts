import { describe, test, expect } from "bun:test";
import { stripThinkingSuffix, parseListModelsOutput, validateTeammateModels, type RunListModels } from "../model-preflight.ts";

describe("stripThinkingSuffix", () => {
	test("strips a trailing thinking-level suffix", () => {
		expect(stripThinkingSuffix("sonnet:high")).toBe("sonnet");
	});

	test("leaves a plain model pattern unchanged", () => {
		expect(stripThinkingSuffix("sonnet")).toBe("sonnet");
	});

	test("leaves a provider/model id unchanged", () => {
		expect(stripThinkingSuffix("claude-bridge/claude-sonnet-4-6")).toBe("claude-bridge/claude-sonnet-4-6");
	});

	test("does not strip a colon-suffix that is not a thinking level", () => {
		expect(stripThinkingSuffix("openrouter/qwen/qwen3-coder:free")).toBe("openrouter/qwen/qwen3-coder:free");
	});
});

describe("parseListModelsOutput", () => {
	test("returns true for real `pi --list-models` rows", () => {
		const stdout = [
			"provider       model                            context  max-out  thinking  images",
			"claude-bridge  claude-sonnet-4-6                200K     64K      yes       yes   ",
		].join("\n");
		expect(parseListModelsOutput(stdout)).toBe(true);
	});

	test('returns false for the `No models matching "..."` message', () => {
		expect(parseListModelsOutput('No models matching "azure"\n')).toBe(false);
	});

	test("returns false for warning-only, header-only, or header-plus-no-match output", () => {
		expect(parseListModelsOutput("Some warning")).toBe(false);
		expect(parseListModelsOutput("provider       model                            context  max-out  thinking  images\n")).toBe(false);
		expect(parseListModelsOutput('provider  model\nNo models matching "azure"')).toBe(false);
	});
});

describe("validateTeammateModels", () => {
	function fakeRunListModels(resolvablePatterns: Set<string>): RunListModels {
		return async (pattern) => (resolvablePatterns.has(pattern) ? "provider  model\nclaude-bridge  claude-sonnet-4-6" : `No models matching "${pattern}"`);
	}

	test("resolves without throwing when every teammate model resolves", async () => {
		const runListModels = fakeRunListModels(new Set(["sonnet", "claude-bridge/claude-sonnet-4-6"]));
		await expect(
			validateTeammateModels(
				[
					{ name: "Scout", model: "sonnet" },
					{ name: "Reviewer", model: "claude-bridge/claude-sonnet-4-6" },
				],
				runListModels,
			),
		).resolves.toBeUndefined();
	});

	test("throws naming the teammate and model when one does not resolve", async () => {
		const runListModels = fakeRunListModels(new Set(["sonnet"]));
		await expect(
			validateTeammateModels(
				[
					{ name: "Scout", model: "sonnet" },
					{ name: "Ghost", model: "gpt-5.5" },
				],
				runListModels,
			),
		).rejects.toThrow(/Ghost/);
	});

	test("strips a thinking-level suffix before checking availability", async () => {
		const seenPatterns: string[] = [];
		const runListModels: RunListModels = async (pattern) => {
			seenPatterns.push(pattern);
			return "provider  model\nclaude-bridge  claude-sonnet-4-6";
		};
		await validateTeammateModels([{ name: "Scout", model: "sonnet:high" }], runListModels);
		expect(seenPatterns).toEqual(["sonnet"]);
	});
});

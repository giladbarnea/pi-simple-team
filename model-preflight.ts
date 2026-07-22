import * as childProcess from "node:child_process";

export interface TeammateModelSpec {
	name: string;
	model: string;
}

export type RunListModels = (modelPattern: string) => Promise<string>;

const thinkingSuffixes = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const listModelsTimeoutMilliseconds = 15_000;

export function stripThinkingSuffix(model: string): string {
	const suffixSeparatorIndex = model.lastIndexOf(":");
	if (suffixSeparatorIndex === -1) return model;

	const suffix = model.slice(suffixSeparatorIndex + 1);
	if (!thinkingSuffixes.includes(suffix as (typeof thinkingSuffixes)[number])) return model;

	return model.slice(0, suffixSeparatorIndex);
}

export const modelPatternForListModels = stripThinkingSuffix;

export function parseListModelsOutput(output: string): boolean {
	const lines = output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const headerIndex = lines.findIndex((line) => line.startsWith("provider ") && line.includes(" model"));
	if (headerIndex === -1) return false;

	return lines.slice(headerIndex + 1).some((line) => {
		if (line.startsWith("No models matching ")) return false;
		const columns = line.split(/\s+/);
		return columns.length >= 2 && columns[0] !== "provider" && columns[1] !== "model";
	});
}

export const hasListModelsMatch = parseListModelsOutput;

const runPiListModels: RunListModels = (modelPattern) => {
	return new Promise((resolve, reject) => {
		childProcess.execFile("pi", ["--list-models", modelPattern], { timeout: listModelsTimeoutMilliseconds, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			const output = `${stdout}${stderr}`;
			if (!error) {
				resolve(output);
				return;
			}

			const details = output.trim() ? `\n${output.trim()}` : "";
			reject(new Error(`pi --list-models ${JSON.stringify(modelPattern)} failed: ${error.message}${details}`));
		});
	});
};

async function validateTeammateModel(teammate: TeammateModelSpec, runListModels: RunListModels): Promise<void> {
	const modelPattern = stripThinkingSuffix(teammate.model);
	const output = await runListModels(modelPattern);
	if (parseListModelsOutput(output)) return;

	const details = output.trim() || "(no output)";
	throw new Error(`No configured model matched ${JSON.stringify(teammate.model)} for teammate ${JSON.stringify(teammate.name)}. Checked ${JSON.stringify(modelPattern)} with pi --list-models:\n${details}`);
}

export async function validateTeammateModels(teammates: TeammateModelSpec[], runListModels: RunListModels = runPiListModels): Promise<void> {
	const results = await Promise.allSettled(teammates.map((teammate) => validateTeammateModel(teammate, runListModels)));
	const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []));
	if (errors.length === 0) return;

	throw new Error(`Model preflight failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}

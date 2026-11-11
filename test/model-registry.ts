import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

/** One user name for a built-in model, one custom model with a user name. Every other model keeps its Pi catalog name. */
export const USER_MODEL_NAMES = {
	providers: {
		anthropic: { modelOverrides: { "claude-opus-5-5": { name: "opus" } } },
		fake: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "local-fixture", models: [{ id: "fake-model", name: "fake-alias" }] },
	},
};

/** A real Pi model registry built from this models.json, without network refresh, as Pi hands it to extensions in ctx.modelRegistry. */
export async function piModelRegistry(modelsJson: object = USER_MODEL_NAMES): Promise<ModelRegistry> {
	const directory = mkdtempSync(join(tmpdir(), "pi-simple-team-models-"));
	try {
		writeFileSync(join(directory, "models.json"), JSON.stringify(modelsJson));
		const runtime = await ModelRuntime.create({
			authPath: join(directory, "auth.json"),
			modelsPath: join(directory, "models.json"),
			modelsStorePath: join(directory, "models-store.json"),
		});
		return new ModelRegistry(runtime);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

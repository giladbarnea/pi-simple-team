import { fileURLToPath } from "node:url";

export const bundledAiToAiSkillPath = fileURLToPath(new URL("./skills/ai-to-ai/SKILL.md", import.meta.url));
export const bundledAiToAiSkillInstruction = `Read the bundled ai-to-ai skill at ${bundledAiToAiSkillPath} in full before continuing, then follow its instructions.`;

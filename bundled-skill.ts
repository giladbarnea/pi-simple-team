import { fileURLToPath } from "node:url";

export const bundledAiToLeaderSkillPath = fileURLToPath(new URL("./skills/ai-to-leader/SKILL.md", import.meta.url));
export const bundledAiToDelegatedSkillPath = fileURLToPath(new URL("./skills/ai-to-delegated/SKILL.md", import.meta.url));
export const bundledSkillsInstruction = `Read the bundled ai-to-leader skill at ${bundledAiToLeaderSkillPath} and the bundled ai-to-delegated skill at ${bundledAiToDelegatedSkillPath} in full before continuing, then follow their instructions.`;

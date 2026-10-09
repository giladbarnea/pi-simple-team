import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const realPiEnabled = process.env.PI_SIMPLE_TEAM_TEST_REAL_PI === "1";
const testHome = process.env.HOME;
const suppliedAgentDirectory = process.env.PI_CODING_AGENT_DIR;
const cleanRealPiEnvironment = testHome && suppliedAgentDirectory && isAbsolute(testHome) && isAbsolute(suppliedAgentDirectory) && resolve(testHome) === resolve(suppliedAgentDirectory);
if (realPiEnabled && !cleanRealPiEnvironment) throw new Error("Real-Pi tests require HOME and PI_CODING_AGENT_DIR set to the same explicit sandbox. Use the clean-environment command in DEVELOPMENT.md.");
const agentDirectory = realPiEnabled ? suppliedAgentDirectory! : mkdtempSync(join(tmpdir(), "pi-simple-team-test-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDirectory;
if (!realPiEnabled) process.once("exit", () => rmSync(agentDirectory, { recursive: true, force: true }));

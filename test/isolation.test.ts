import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";

import { describe, test } from "bun:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const realPiEnabled = process.env.PI_SIMPLE_TEAM_TEST_REAL_PI === "1";

describe.skipIf(realPiEnabled)("test-run isolation", () => {
	test("the suite never resolves the user's real ~/.pi agent directory", () => {
		const agentDirectory = getAgentDir();
		const realAgentDirectory = path.join(os.homedir(), ".pi");
		assert.equal(
			agentDirectory.startsWith(realAgentDirectory),
			false,
			`Expected a sandboxed agent directory outside ${realAgentDirectory}. Got: ${agentDirectory}`,
		);
	});
});

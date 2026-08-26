import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fair isolation: the suite must never read or write the user's real ~/.pi/agent
// (registry manifests, settings.json glyph/theme config). The opt-in real-pi
// end-to-end run is the one exception: the real binary needs the real config.
if (process.env.PI_SIMPLE_TEAM_TEST_REAL_PI !== "1") {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-simple-team-test-agent-"));
}

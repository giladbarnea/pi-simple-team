import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { test } from "bun:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { glyphStyle } from "../render-support/glyphs.ts";
import { readVstackConfig } from "../render-support/settings.ts";
import { claimTeamLease, releaseTeamLease } from "../team-registry.ts";

const isolationProbe = process.env.PI_SIMPLE_TEAM_TEST_ISOLATION_PROBE === "1";
const callerSettings = JSON.stringify({ vstack: { extensionManager: { config: { "@vanillagreen/pi-tool-renderer": { glyphStyle: "ascii", isolationMarker: true } } } } });

test.skipIf(isolationProbe).each([false, true])("the suite isolates caller configuration and preserves an explicit real-Pi sandbox (realPi=%s)", (realPiEnabled) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-team-isolation-regression-"));
	const callerAgentDirectory = join(directory, "caller-agent");
	mkdirSync(callerAgentDirectory);
	const settingsPath = join(callerAgentDirectory, "settings.json");
	writeFileSync(settingsPath, callerSettings);

	try {
		const result = spawnSync(process.execPath, ["test", import.meta.path, "--test-name-pattern", "isolation probe"], {
			cwd: dirname(import.meta.dir),
			env: {
				PATH: process.env.PATH,
				HOME: realPiEnabled ? callerAgentDirectory : directory,
				PI_CODING_AGENT_DIR: callerAgentDirectory,
				PI_SIMPLE_TEAM_TEST_REAL_PI: realPiEnabled ? "1" : "0",
				PI_SIMPLE_TEAM_TEST_ISOLATION_PROBE: "1",
				PI_SIMPLE_TEAM_TEST_CALLER_AGENT_DIR: callerAgentDirectory,
			},
			encoding: "utf8",
			timeout: 15_000,
		});
		assert.equal(result.status, 0, `Expected the configured test sandbox to protect caller data.\n${result.stderr}`);
		assert.equal(readFileSync(settingsPath, "utf8"), callerSettings, "The caller's settings must remain unchanged.");
		assert.equal(existsSync(join(callerAgentDirectory, "pi-simple-team")), realPiEnabled, "Only the explicit real-Pi sandbox may receive registry writes.");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test.skipIf(isolationProbe)("real-Pi opt-in rejects mismatched HOME and PI_CODING_AGENT_DIR", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-team-unsafe-real-pi-"));
	writeFileSync(join(directory, "settings.json"), callerSettings);
	try {
		const result = spawnSync(process.execPath, ["test", import.meta.path, "--test-name-pattern", "isolation probe"], {
			cwd: dirname(import.meta.dir),
			env: {
				PATH: process.env.PATH,
				HOME: dirname(directory),
				PI_CODING_AGENT_DIR: directory,
				PI_SIMPLE_TEAM_TEST_REAL_PI: "1",
				PI_SIMPLE_TEAM_TEST_ISOLATION_PROBE: "1",
				PI_SIMPLE_TEAM_TEST_CALLER_AGENT_DIR: directory,
			},
			encoding: "utf8",
			timeout: 15_000,
		});
		assert.notEqual(result.status, 0, "Real-Pi tests must require a clean environment even when an agent directory is supplied.");
		assert.match(result.stderr, /Real-Pi tests require HOME and PI_CODING_AGENT_DIR set to the same explicit sandbox/, "The failure must explain the clean-environment contract.");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test.skipIf(!isolationProbe)("isolation probe resolves settings and registry inside the test sandbox", () => {
	const agentDirectory = getAgentDir();
	const realPiEnabled = process.env.PI_SIMPLE_TEAM_TEST_REAL_PI === "1";
	assert.equal(agentDirectory === process.env.PI_SIMPLE_TEAM_TEST_CALLER_AGENT_DIR, realPiEnabled, "Only the explicit real-Pi sandbox may retain the caller's agent directory.");
	assert.equal(glyphStyle(), realPiEnabled ? "ascii" : "unicode", "Only explicit real-Pi sandbox settings may affect the suite.");
	assert.deepEqual(readVstackConfig(), realPiEnabled ? { glyphStyle: "ascii", isolationMarker: true } : {}, "Only explicit real-Pi sandbox package settings may reach the suite.");
	const lease = claimTeamLease("isolation-probe", "isolation-probe-session");
	try {
		assert.equal(existsSync(join(agentDirectory, "pi-simple-team", "teams-v2", "isolation-probe.lease")), true, "The real registry must write inside the test sandbox.");
	} finally {
		releaseTeamLease(lease);
	}
});

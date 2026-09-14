import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";

const repository = path.resolve(import.meta.dir, "..");
type Workflow = { jobs: { publish: { steps: Array<{ id?: string; run?: string }> } } };

function prepareRelease(localVersion: string, publishedVersion: string): { status: number | null; output: string; version: string; taggedVersion: string } {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-release-"));
	const checkout = path.join(directory, "checkout");
	const remote = path.join(directory, "origin.git");
	const binaries = path.join(directory, "bin");
	const outputFile = path.join(directory, "output");
	fs.mkdirSync(checkout);
	fs.mkdirSync(binaries);
	const run = (command: string, argumentsList: string[], cwd = checkout): string => {
		const result = spawnSync(command, argumentsList, { cwd, encoding: "utf8" });
		assert.equal(result.status, 0, `Fixture command failed: ${command} ${argumentsList.join(" ")}\n${result.stderr}`);
		return result.stdout.trim();
	};
	try {
		run("git", ["init", "--bare", remote], directory);
		run("git", ["init", "-b", "main"]);
		run("git", ["config", "user.name", "Release test"]);
		run("git", ["config", "user.email", "release-test@example.invalid"]);
		run("git", ["config", "core.hooksPath", "/dev/null"]);
		fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "release-fixture", version: localVersion }));
		fs.cpSync(path.join(repository, "scripts"), path.join(checkout, "scripts"), { recursive: true });
		run("git", ["add", "."]);
		run("git", ["commit", "-m", "Fixture"]);
		run("git", ["remote", "add", "origin", remote]);
		run("git", ["push", "-u", "origin", "main"]);
		const npm = Bun.which("npm");
		assert.ok(npm, "The release test needs npm for the real local version/tag operation.");
		fs.writeFileSync(path.join(binaries, "npm"), `#!/bin/sh\nif [ "$1" = view ]; then\n  printf '%s\\n' "$TEST_PUBLISHED_VERSION"\nelse\n  exec '${npm.replaceAll("'", "'\\''")}' "$@"\nfi\n`, { mode: 0o755 });
		const workflow = Bun.YAML.parse(fs.readFileSync(path.join(repository, ".github/workflows/publish.yml"), "utf8")) as Workflow;
		const script = workflow.jobs.publish.steps.find((step) => step.id === "release")?.run;
		assert.ok(script, "The workflow must expose its actual release preparation step.");
		const result = spawnSync("bash", ["-c", script], {
			cwd: checkout, encoding: "utf8",
			env: { ...process.env, PATH: `${binaries}${path.delimiter}${process.env.PATH}`, GITHUB_OUTPUT: outputFile, TEST_PUBLISHED_VERSION: publishedVersion },
		});
		const version = (JSON.parse(fs.readFileSync(path.join(checkout, "package.json"), "utf8")) as { version: string }).version;
		const tag = spawnSync("git", ["--git-dir", remote, "show", `v${version}:package.json`], { encoding: "utf8" });
		return { status: result.status, output: result.stdout + result.stderr, version, taggedVersion: tag.status === 0 ? (JSON.parse(tag.stdout) as { version: string }).version : "" };
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

test("publish workflow preserves an explicit major release and pushes its matching tag", () => {
	const release = prepareRelease("2.0.0", "1.0.46");
	assert.equal(release.status, 0, `An explicit major release must be publishable.\n${release.output}`);
	assert.equal(release.version, "2.0.0", "Release preparation must preserve the chosen major version.");
	assert.equal(release.taggedVersion, "2.0.0", "The remote release tag must contain the package version being published.");
});

test("publish workflow still advances an unchanged version by one patch", () => {
	const release = prepareRelease("2.0.0", "2.0.0");
	assert.equal(release.status, 0, `The normal patch release must remain publishable.\n${release.output}`);
	assert.equal(release.version, "2.0.1", "An unchanged published version must advance by one patch.");
	assert.equal(release.taggedVersion, "2.0.1", "The pushed tag must contain the new patch version.");
});

test("publish workflow rejects a version older than the published release", () => {
	const release = prepareRelease("1.0.46", "2.0.0");
	assert.notEqual(release.status, 0, "A downgrade must fail before publication.");
	assert.match(release.output, /older than published version/, "The failure must explain the version conflict.");
	assert.equal(release.taggedVersion, "", "A rejected version must not create a remote release tag.");
});

import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { useEnvironment } from "./pi-launch.ts";

// Bun runs a timed-out test's `finally` while later tests run. These tests replay that order without a timeout:
// the first test leaves its environment changed and its restore uncalled, and the second calls that restore late.
const leakedName = "PI_SIMPLE_TEAM_TEST_SCOPE_PROBE";
let lateRestore: (() => void) | undefined;
const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const otherTimeZone = localTimeZone === "Pacific/Kiritimati" ? "Pacific/Pago_Pago" : "Pacific/Kiritimati";

describe("a test cannot leak process state into later tests", () => {
	test("a test changes the environment, the time zone, process.argv[1] and process.execPath, and ends without restoring them", () => {
		assert.equal(process.env[leakedName], undefined, "The probe variable must start unset.");
		lateRestore = useEnvironment({ [leakedName]: "first test" });
		process.argv[1] = "/first-test/entry";
		process.execPath = "/first-test/executable";
		process.env.TZ = otherTimeZone;
		assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, otherTimeZone, "The fixture must change Bun's time zone.");
	});

	test("the next test starts with the earlier state, and the late restore cannot overwrite its values", () => {
		assert.equal(process.env[leakedName], undefined, "The environment must be restored when the earlier test ends.");
		assert.notEqual(process.argv[1], "/first-test/entry", "process.argv[1] must be restored when the earlier test ends.");
		assert.notEqual(process.execPath, "/first-test/executable", "process.execPath must be restored when the earlier test ends.");
		assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, localTimeZone, "The time zone must be restored when the earlier test ends.");
		const restore = useEnvironment({ [leakedName]: "second test" });
		lateRestore!();
		assert.equal(process.env[leakedName], "second test", "A restore from a test that has ended must not change a later test's environment.");
		restore();
		assert.equal(process.env[leakedName], undefined, "A test's own restore still works.");
	});
});

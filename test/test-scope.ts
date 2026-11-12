import { afterEach, beforeEach } from "bun:test";

/**
 * Per-test process state. Bun runs afterEach as soon as a test times out but cannot stop its body, which goes on running during
 * later tests. So afterEach puts back the environment, process.execPath and process.argv[1] as they were before the test, and a
 * restore created inside a test does nothing once that test has ended. Otherwise its late `finally` would overwrite a later test's
 * values, and that test's own restore would then keep the timed-out test's values for good.
 */
interface ProcessState {
	environment: Record<string, string | undefined>;
	timeZone: string;
	executable: string;
	entry: string | undefined;
}

let runningTest: number | undefined;
let testCount = 0;
const endedTests = new Set<number>();
let before: ProcessState | undefined;

function captureProcessState(): ProcessState {
	return { environment: { ...process.env }, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, executable: process.execPath, entry: process.argv[1] };
}

function restoreProcessState(state: ProcessState): void {
	for (const name of Object.keys(process.env)) {
		if (!(name in state.environment)) delete process.env[name];
	}
	Object.assign(process.env, state.environment);
	// Bun keeps the last time zone it was given, so a test's TZ is undone by naming the earlier zone, not by deleting TZ.
	if (Intl.DateTimeFormat().resolvedOptions().timeZone !== state.timeZone) process.env.TZ = state.timeZone;
	process.execPath = state.executable;
	process.argv[1] = state.entry!;
}

/** Registers the per-test hooks. The preload calls it once, so it applies to every test file. */
export function scopeProcessStateToEachTest(): void {
	beforeEach(() => {
		testCount += 1;
		runningTest = testCount;
		before = captureProcessState();
	});
	afterEach(() => {
		restoreProcessState(before!);
		endedTests.add(runningTest!);
		runningTest = undefined;
	});
}

/** Wraps a restore so that it does nothing once the test that created it has ended. A restore created outside a test always runs. */
export function scopedRestore(restore: () => void): () => void {
	const owner = runningTest;
	return () => {
		if (owner !== undefined && endedTests.has(owner)) return;
		restore();
	};
}

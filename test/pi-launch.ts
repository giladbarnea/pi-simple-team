import * as fs from "node:fs";
import * as path from "node:path";
import { scopedRestore } from "./test-scope.ts";

/** Makes `directory` the Pi package that loads pi-simple-team, with `cli` as its CLI script. Returns a restore function. */
export function useFakePiPackage(directory: string, cli: string): () => void {
	fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ bin: { pi: cli } }));
	return useEnvironment({ PI_PACKAGE_DIR: directory });
}

/** Runs `load` while `process.execPath` and `process.argv[1]` report `executable` and `entry`. */
export function loadWithProcess<T>(executable: string, entry: string, load: () => T): T {
	const previous = { executable: process.execPath, entry: process.argv[1]! };
	process.execPath = executable;
	process.argv[1] = entry;
	try {
		return load();
	} finally {
		process.execPath = previous.executable;
		process.argv[1] = previous.entry;
	}
}

/** Runs `load` as a Bun standalone Pi: `executable` is the running executable, and argv[1] is its embedded entry. */
export function loadAsBunStandalonePi<T>(executable: string, load: () => T): T {
	return loadWithProcess(executable, "/$bunfs/root/pi", load);
}

/**
 * Sets or, for undefined, removes environment variables, and returns a function that restores them, removing those that were unset.
 * The restore does nothing once the test that called this has ended, because a timed-out test's late `finally` runs during later tests.
 */
export function useEnvironment(values: Record<string, string | undefined>): () => void {
	const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	for (const [name, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	return scopedRestore(() => {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
}

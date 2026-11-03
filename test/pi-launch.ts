import * as fs from "node:fs";
import * as path from "node:path";

/** Makes `directory` the Pi package that loads pi-simple-team, with `cli` as its CLI script. Returns a restore function. */
export function useFakePiPackage(directory: string, cli: string): () => void {
	fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ bin: { pi: cli } }));
	const previous = process.env.PI_PACKAGE_DIR;
	process.env.PI_PACKAGE_DIR = directory;
	return () => {
		if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
		else process.env.PI_PACKAGE_DIR = previous;
	};
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

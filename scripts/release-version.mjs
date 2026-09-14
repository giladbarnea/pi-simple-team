/** @example parseVersion("2.0.0") // [2, 0, 0] */
function parseVersion(version) {
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error(`Expected a stable major.minor.patch version, got ${version}.`);
	return version.split(".").map(Number);
}

const [localVersion, publishedVersion] = process.argv.slice(2);
const local = parseVersion(localVersion);
const published = parseVersion(publishedVersion);
const difference = local.map((part, index) => part - published[index]).find((part) => part !== 0) ?? 0;
if (difference < 0) throw new Error(`Repository version ${localVersion} is older than published version ${publishedVersion}.`);
console.log(difference === 0 ? `${published[0]}.${published[1]}.${published[2] + 1}` : localVersion);

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface TeamManifestMember {
	name: string;
	prompt: string;
	model: string;
	thinking: string;
	inheritContext: boolean;
	transport: "rpc" | "herdr";
	live: boolean;
	sessionId: string;
	sessionFile: string;
	sessionMaterialized: boolean;
}

export interface TeamManifest {
	version: 1;
	id: string;
	name: string;
	originMainSessionId: string;
	projectDirectory: string;
	teamPrompt: string;
	showOnHerdrPanes: boolean;
	members: TeamManifestMember[];
	state: "active" | "dormant";
	createdAt: string;
	updatedAt: string;
	shutdownAt?: string;
	expiresAt?: string;
}

export interface TeamLease {
	version: 1;
	teamId: string;
	mainSessionId: string;
	processId: number;
	token: string;
	claimedAt: string;
}

export const dormantManifestRetentionMilliseconds = 30 * 24 * 60 * 60 * 1_000;

function manifestsDirectory(): string {
	return path.join(getAgentDir(), "pi-simple-team", "teams");
}

/** @example canonicalProjectDirectory(".") // absolute real path */
export function canonicalProjectDirectory(projectDirectory: string): string {
	return fs.realpathSync(path.resolve(projectDirectory));
}

function encodedTeamPath(teamId: string, suffix: string): string {
	return path.join(manifestsDirectory(), `${encodeURIComponent(teamId)}${suffix}`);
}

function manifestPath(teamId: string): string {
	return encodedTeamPath(teamId, ".json");
}

function leasePath(teamId: string): string {
	return encodedTeamPath(teamId, ".lease");
}

function leaseClaimLockPath(teamId: string): string {
	return encodedTeamPath(teamId, ".lease-claim-lock");
}

function isManifestMember(value: unknown): value is TeamManifestMember {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const member = value as Record<string, unknown>;
	return (
		typeof member.name === "string" &&
		typeof member.prompt === "string" &&
		typeof member.model === "string" &&
		typeof member.thinking === "string" &&
		typeof member.inheritContext === "boolean" &&
		(member.transport === "rpc" || member.transport === "herdr") &&
		typeof member.live === "boolean" &&
		typeof member.sessionId === "string" &&
		typeof member.sessionFile === "string" &&
		typeof member.sessionMaterialized === "boolean"
	);
}

function parseManifest(filePath: string): TeamManifest {
	const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid team manifest: ${filePath}`);
	}

	const manifest = parsed as Record<string, unknown>;
	const validState = manifest.state === "active" || manifest.state === "dormant";
	if (
		manifest.version !== 1 ||
		typeof manifest.id !== "string" ||
		typeof manifest.name !== "string" ||
		typeof manifest.originMainSessionId !== "string" ||
		typeof manifest.projectDirectory !== "string" ||
		typeof manifest.teamPrompt !== "string" ||
		typeof manifest.showOnHerdrPanes !== "boolean" ||
		!Array.isArray(manifest.members) ||
		!manifest.members.every(isManifestMember) ||
		!validState ||
		typeof manifest.createdAt !== "string" ||
		typeof manifest.updatedAt !== "string" ||
		(manifest.shutdownAt !== undefined && typeof manifest.shutdownAt !== "string") ||
		(manifest.expiresAt !== undefined && typeof manifest.expiresAt !== "string")
	) {
		throw new Error(`Invalid team manifest: ${filePath}`);
	}

	return manifest as unknown as TeamManifest;
}

function parseLease(filePath: string): TeamLease {
	const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid team lease: ${filePath}`);
	}
	const lease = parsed as Record<string, unknown>;
	if (
		lease.version !== 1 ||
		typeof lease.teamId !== "string" ||
		typeof lease.mainSessionId !== "string" ||
		typeof lease.processId !== "number" ||
		typeof lease.token !== "string" ||
		typeof lease.claimedAt !== "string"
	) {
		throw new Error(`Invalid team lease: ${filePath}`);
	}
	return lease as unknown as TeamLease;
}

function processIsAlive(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

export function writeTeamManifest(manifest: TeamManifest): void {
	const directory = manifestsDirectory();
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const filePath = manifestPath(manifest.id);
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(temporaryPath, filePath);
}

export function listTeamManifests(projectDirectory: string): TeamManifest[] {
	const directory = manifestsDirectory();
	if (!fs.existsSync(directory)) return [];

	const resolvedProjectDirectory = canonicalProjectDirectory(projectDirectory);
	const now = Date.now();
	return fs
		.readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => ({ filePath: path.join(directory, entry.name), manifest: parseManifest(path.join(directory, entry.name)) }))
		.filter(({ filePath, manifest }) => {
			const expiresAt = Date.parse(manifest.expiresAt ?? "");
			const shutdownAt = Date.parse(manifest.shutdownAt ?? "");
			const expired = manifest.state === "dormant" && (
				Number.isFinite(expiresAt)
					? now >= expiresAt
					: now - shutdownAt >= dormantManifestRetentionMilliseconds
			);
			if (!expired) return true;
			fs.rmSync(leasePath(manifest.id), { force: true });
			fs.rmSync(filePath);
			return false;
		})
		.map(({ manifest }) => manifest)
		.filter((manifest) => manifest.projectDirectory === resolvedProjectDirectory)
		.sort((left, right) => left.id.localeCompare(right.id));
}

export function readTeamLeaseState(teamId: string): { state: "unclaimed" | "claimed" | "stale"; mainSessionId?: string } {
	let lease: TeamLease;
	try {
		lease = parseLease(leasePath(teamId));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "unclaimed" };
		throw error;
	}
	return {
		state: processIsAlive(lease.processId) ? "claimed" : "stale",
		mainSessionId: lease.mainSessionId,
	};
}

function markAbandonedTeamDormant(teamId: string): void {
	let manifest: TeamManifest;
	try {
		manifest = parseManifest(manifestPath(teamId));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (manifest.state !== "active") return;

	const shutdownAt = new Date().toISOString();
	writeTeamManifest({
		...manifest,
		members: manifest.members.map((member) => ({ ...member, live: false })),
		state: "dormant",
		updatedAt: shutdownAt,
		shutdownAt,
		expiresAt: new Date(Date.parse(shutdownAt) + dormantManifestRetentionMilliseconds).toISOString(),
	});
}

function claimTeamLeaseUnderLock(teamId: string, mainSessionId: string): TeamLease {
	const filePath = leasePath(teamId);
	const lease: TeamLease = {
		version: 1,
		teamId,
		mainSessionId,
		processId: process.pid,
		token: randomUUID(),
		claimedAt: new Date().toISOString(),
	};

	let recoveredStaleLease = false;
	while (true) {
		try {
			fs.writeFileSync(filePath, `${JSON.stringify(lease, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
			if (recoveredStaleLease) {
				try {
					markAbandonedTeamDormant(teamId);
				} catch (error) {
					releaseTeamLease(lease);
					throw error;
				}
			}
			return lease;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}

		let existingLease: TeamLease;
		try {
			existingLease = parseLease(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (processIsAlive(existingLease.processId)) {
			throw new Error(`Team ${teamId} is already owned by main session ${existingLease.mainSessionId}`);
		}

		let currentLease: TeamLease;
		try {
			currentLease = parseLease(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (currentLease.token !== existingLease.token) continue;

		recoveredStaleLease = true;
		fs.unlinkSync(filePath);
	}
}

export function claimTeamLease(teamId: string, mainSessionId: string): TeamLease {
	fs.mkdirSync(manifestsDirectory(), { recursive: true, mode: 0o700 });
	const lockPath = leaseClaimLockPath(teamId);
	try {
		fs.mkdirSync(lockPath, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		throw new Error(`Team ${teamId} lease claim is already in progress`);
	}

	try {
		return claimTeamLeaseUnderLock(teamId, mainSessionId);
	} finally {
		fs.rmdirSync(lockPath);
	}
}

export function releaseTeamLease(lease: TeamLease): void {
	const filePath = leasePath(lease.teamId);
	let currentLease: TeamLease;
	try {
		currentLease = parseLease(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (currentLease.token !== lease.token) return;
	fs.unlinkSync(filePath);
}

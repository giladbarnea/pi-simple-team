import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SessionAttachment } from "./session-attachment.ts";
import type { TeammateRecord } from "./teammate.ts";

export interface TeamManifestMember extends TeammateRecord {
	sessionMaterialized: boolean;
	importPending?: boolean;
	needsBriefing?: boolean;
}

export interface TeamManifest {
	version: 2;
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
	/** The main session that was running this team when its quit or reload stopped it, and the teammates then running and working. That main's next start reattaches them. */
	interrupted?: { mainSessionId: string; teammates: string[]; working: string[] };
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
	return path.join(getAgentDir(), "pi-simple-team", "teams-v2");
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
		typeof member.systemPrompt === "string" &&
		typeof member.model === "string" &&
		typeof member.thinking === "string" &&
		typeof member.forkContext === "boolean" &&
		typeof member.canManageOwnTeams === "boolean" &&
		typeof member.showOnHerdrPane === "boolean" &&
		typeof member.live === "boolean" &&
		typeof member.active === "boolean" &&
		typeof member.teammateId === "string" &&
		typeof member.sessionFile === "string" &&
		typeof member.sessionMaterialized === "boolean" &&
		(member.importPending === undefined || typeof member.importPending === "boolean") &&
		(member.needsBriefing === undefined || typeof member.needsBriefing === "boolean") &&
		(member.session === undefined || typeof member.session === "string") &&
		(member.contextPercent === undefined || typeof member.contextPercent === "number") &&
		(member.extensionPaths === undefined || (Array.isArray(member.extensionPaths) && member.extensionPaths.every((value) => typeof value === "string" && path.isAbsolute(value))))
	);
}

function isInterruption(value: unknown): value is TeamManifest["interrupted"] {
	const names = (list: unknown) => Array.isArray(list) && list.every((name) => typeof name === "string");
	return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).mainSessionId === "string" && names((value as Record<string, unknown>).teammates) && names((value as Record<string, unknown>).working);
}

function parseManifest(filePath: string): TeamManifest {
	const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid team manifest: ${filePath}`);
	}

	const manifest = parsed as Record<string, unknown>;
	const validState = manifest.state === "active" || manifest.state === "dormant";
	if (
		manifest.version !== 2 ||
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
		(manifest.expiresAt !== undefined && typeof manifest.expiresAt !== "string") ||
		(manifest.interrupted !== undefined && !isInterruption(manifest.interrupted))
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

/** Removes a new import reservation only after its creating runtime has stopped every child. */
export function discardTeamImportReservation(teamId: string): void {
	fs.rmSync(manifestPath(teamId));
}

/** Whether a saved attachment file holds this team ID, readable or not. */
export function teamManifestExists(teamId: string): boolean {
	return fs.existsSync(manifestPath(teamId));
}

export interface UnreadableManifest {
	filePath: string;
	error: string;
}

/** The project an unreadable manifest names, when its JSON still says. */
function claimedProjectDirectory(filePath: string): string | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { projectDirectory?: unknown };
		return typeof parsed.projectDirectory === "string" ? parsed.projectDirectory : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The current project's readable manifests, plus the unreadable ones that may belong to it.
 * A manifest from another Pi Simple Team version or another project never blocks this project.
 */
export function listTeamManifests(projectDirectory: string): { manifests: TeamManifest[]; unreadable: UnreadableManifest[] } {
	const directory = manifestsDirectory();
	if (!fs.existsSync(directory)) return { manifests: [], unreadable: [] };

	const resolvedProjectDirectory = canonicalProjectDirectory(projectDirectory);
	const now = Date.now();
	const manifests: TeamManifest[] = [];
	const unreadable: UnreadableManifest[] = [];
	const filePaths = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => path.join(directory, entry.name));
	for (const filePath of filePaths) {
		let manifest: TeamManifest;
		try {
			manifest = parseManifest(filePath);
		} catch (error) {
			if ((claimedProjectDirectory(filePath) ?? resolvedProjectDirectory) === resolvedProjectDirectory) unreadable.push({ filePath, error: error instanceof Error ? error.message : String(error) });
			continue;
		}
		if (manifest.state === "dormant" && !manifest.members.some((member) => member.importPending) && now >= Date.parse(manifest.expiresAt ?? "")) {
			fs.rmSync(leasePath(manifest.id), { force: true });
			fs.rmSync(filePath);
			continue;
		}
		if (manifest.projectDirectory === resolvedProjectDirectory) manifests.push(manifest);
	}
	return { manifests: manifests.sort((left, right) => left.id.localeCompare(right.id)), unreadable };
}

/** Checks retained ownership and reserves the import batch before any child can load its session. */
export function reserveSessionImports(destination: TeamManifest, attachments: readonly SessionAttachment[], managing = false): void {
	const directory = manifestsDirectory();
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const lock = path.join(directory, ".session-import-lock");
	try {
		fs.mkdirSync(lock, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		throw new Error(`Session import reservation is already in progress at ${lock}; sessions ${attachments.map((attachment) => attachment.id).join(", ")} remain unclaimed by team ${destination.id}.`);
	}
	try {
		const manifests = fs.readdirSync(directory).filter((file) => file.endsWith(".json")).map((file) => parseManifest(path.join(directory, file)));
		const liveLeases = fs.readdirSync(directory).filter((file) => file.endsWith(".lease")).map((file) => parseLease(path.join(directory, file))).filter((lease) => processIsAlive(lease.processId));
		const canonicalFile = (file: string): string => fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
		const seen = new Set<string>();
		for (const attachment of attachments) {
			if (seen.has(attachment.id)) throw new Error(`Session ${attachment.id} at ${attachment.file ?? destination.projectDirectory} is selected twice for team ${destination.id}.`);
			seen.add(attachment.id);
			for (const manifest of manifests) {
				const member = manifest.members.find((member) => (manifest.projectDirectory === destination.projectDirectory && member.teammateId === attachment.id) || (attachment.file && canonicalFile(member.sessionFile) === attachment.file));
				const lease = readTeamLeaseState(manifest.id);
				if (member && managing && manifest.originMainSessionId !== destination.originMainSessionId) throw new Error(`Session ${attachment.id} at ${attachment.file ?? member.sessionFile} is registered outside your management scope. Ask main to handle this session.`);
				if (member) throw new Error(`Session ${attachment.id} at ${attachment.file ?? member.sessionFile} is ${member.importPending ? "reserved (import pending)" : "listed"} in team ${manifest.id}, main ${lease.mainSessionId ?? manifest.originMainSessionId}, project ${manifest.projectDirectory}${member.showOnHerdrPane && member.live ? "; may still be live in its Herdr pane" : ""}. Use team_resume for registered teammates; attachment does not transfer them.`);
			}
			const mainLease = liveLeases.find((lease) => lease.mainSessionId === attachment.id);
			if (mainLease && managing) throw new Error(`Session ${attachment.id} at ${attachment.file ?? destination.projectDirectory} is live outside your management scope. Ask main to handle this session.`);
			if (mainLease) throw new Error(`Session ${attachment.id} at ${attachment.file ?? destination.projectDirectory} is live as main of team ${mainLease.teamId} (lease in ${directory}).`);
			if (attachment.previousTeam) throw new Error(`Session ${attachment.id} at ${attachment.file} was previously a teammate in ${attachment.previousTeam}. This first version only attaches never-teamed sessions.`);
		}
		writeTeamManifest(destination);
	} finally {
		fs.rmdirSync(lock);
	}
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
		members: manifest.members.map((member) => ({ ...member, live: false, active: false })),
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

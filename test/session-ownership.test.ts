import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import { registerChildTools } from "../child-tools.ts";
import teamExtension from "../index.ts";

type JsonRecord = Record<string, unknown>;

type ToolResult = {
	content: Array<{ type: string; text: string }>;
	details?: JsonRecord;
};

type RenderedToolResult = {
	render: (width: number) => string[];
};

type RegisteredTool = {
	name: string;
	description: string;
	promptSnippet?: string;
	parameters: TSchema;
	renderResult?: (
		result: ToolResult,
		options: { expanded: boolean },
		theme: { bold: (text: string) => string; fg: (token: string, text: string) => string },
		context: { args: JsonRecord },
	) => RenderedToolResult;
	execute: (
		toolCallId: string,
		params: JsonRecord,
		signal: AbortSignal,
		onUpdate: undefined,
		context: unknown,
	) => Promise<ToolResult>;
};

describe("teamlog input schema", () => {
	test("accepts only a non-empty kind list containing non-empty strings", async () => {
		const host = new ExtensionHost();
		const schema = host.tools.get("teamlog")?.parameters;
		assert.ok(schema, "Expected the extension to register the teamlog input schema.");

		assert.equal(Value.Check(schema, { kind: ["send", "error"] }), true, "Expected teamlog to accept multiple kinds.");
		assert.equal(Value.Check(schema, { kind: [] }), false, "Expected teamlog to reject an empty kind list.");
		assert.equal(Value.Check(schema, { kind: [""] }), false, "Expected teamlog to reject an empty kind value.");
		assert.equal(Value.Check(schema, { kind: "send" }), false, "Expected teamlog to reject the old string kind value.");

		await host.shutdown();
	});

	test("adds scoped models to team_spawn guidance", async () => {
		const host = new ExtensionHost(() => undefined, [
			{ model: { provider: "openai-codex", id: "gpt-5.6-sol" } },
			{ model: { provider: "anthropic", id: "claude-sonnet-4-6" } },
		]);
		const tool = host.tools.get("team_spawn");
		assert.ok(tool);
		const guidance = "You should probably use one of these user-scoped models: openai-codex/gpt-5.6-sol, anthropic/claude-sonnet-4-6.";
		assert.match(tool.description, new RegExp(guidance.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(tool.promptSnippet ?? "", new RegExp(guidance.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		await host.shutdown();
	});

	test("adds environment-based model guidance when the scope is empty", async () => {
		const host = new ExtensionHost();
		const tool = host.tools.get("team_spawn");
		assert.ok(tool);
		const prose = `${tool.description} ${tool.promptSnippet ?? ""}`;
		assert.match(prose, /PI_PROVIDER, PI_MODEL, and PI_REASONING_LEVEL/);
		assert.match(prose, /Confirm with the user before picking any model id/);
		await host.shutdown();
	});

	test("keeps showOnHerdrPanes guidance only in the team_spawn description", async () => {
		const host = new ExtensionHost();
		const tool = host.tools.get("team_spawn");
		assert.ok(tool);
		assert.match(tool.description, /If the user is interested, set `showOnHerdrPanes` to run each teammate in a visible Herdr pane\./);
		assert.doesNotMatch(tool.promptSnippet ?? "", /showOnHerdrPanes/);
		const properties = tool.parameters.properties as Record<string, { description?: string }>;
		assert.equal(properties.showOnHerdrPanes?.description, undefined);
		await host.shutdown();
	});
});

type ExtensionEventHandler = (event: JsonRecord, context: unknown) => Promise<unknown> | unknown;

type ScopedModel = {
	model: {
		provider: string;
		id: string;
	};
};

const fakeAvailableModels = [{ provider: "fake", id: "fake-model" }];

type RecordedMessage = {
	details?: {
		team?: string;
		from?: string;
	};
};

class ExtensionHost {
	readonly messages: RecordedMessage[] = [];
	readonly shutdownHandlers: ExtensionEventHandler[] = [];
	readonly tools = new Map<string, RegisteredTool>();
	readonly context: ExtensionContext;

	constructor(onMessage: () => void = () => undefined, scopedModels: ScopedModel[] = []) {
		this.context = {
			scopedModels,
			modelRegistry: { getAvailable: () => fakeAvailableModels },
		} as unknown as ExtensionContext;
		const api = {
			on: (event: string, handler: ExtensionEventHandler) => {
				if (event === "session_shutdown") this.shutdownHandlers.push(handler);
				if (event === "session_start") handler({ reason: "startup" }, this.context);
			},
			registerMessageRenderer: () => undefined,
			registerTool: (tool: RegisteredTool) => this.tools.set(tool.name, tool),
			sendMessage: (message: RecordedMessage) => {
				this.messages.push(message);
				onMessage();
			},
		} as unknown as ExtensionAPI;

		teamExtension(api);
	}

	async execute<T extends JsonRecord>(toolName: string, params: JsonRecord): Promise<T> {
		const result = await this.executeResult(toolName, params);
		assert.ok(result.details, `Expected ${toolName} to return structured result details.`);
		return result.details as T;
	}

	async executeResult(toolName: string, params: JsonRecord, context: unknown = this.context): Promise<ToolResult> {
		const tool = this.tools.get(toolName);
		assert.ok(tool, `Expected extension host to register tool ${JSON.stringify(toolName)}.`);
		return tool.execute("test-call", params, new AbortController().signal, undefined, context);
	}

	renderResult(toolName: string, result: ToolResult, args: JsonRecord): string[] {
		const tool = this.tools.get(toolName);
		assert.ok(tool?.renderResult, `Expected ${toolName} to register a result renderer.`);
		const theme = {
			bold: (text: string) => text,
			fg: (token: string, text: string) => `«${token}:${text}»`,
		};
		return tool.renderResult(result, { expanded: false }, theme, { args }).render(300);
	}

	async shutdown(): Promise<void> {
		for (const handler of this.shutdownHandlers) {
			await handler({ type: "session_shutdown", reason: "quit" }, {});
		}
	}
}

async function spawnEmptyTeam(host: ExtensionHost, team: string): Promise<void> {
	await host.execute("team_spawn", { team, teamPrompt: "Ownership regression test.", teammates: [] });
}

async function shutdownHosts(...hosts: ExtensionHost[]): Promise<void> {
	for (const host of hosts) {
		await host.shutdown();
	}
}

function messageReceipt(expectedCount: number): { record: () => void; wait: () => Promise<void> } {
	let count = 0;
	let resolveWaiter: (() => void) | undefined;

	return {
		record: () => {
			count += 1;
			if (count >= expectedCount) resolveWaiter?.();
		},
		wait: () => {
			if (count >= expectedCount) return Promise.resolve();
			return new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error(`Expected ${expectedCount} teammate messages, but received ${count}.`)),
					2_000,
				);
				resolveWaiter = () => {
					clearTimeout(timeout);
					resolve();
				};
			});
		},
	};
}

const fakePiScript = String.raw`#!/usr/bin/env node
const http = require("node:http");

if (process.argv[2] === "--list-models") {
	process.stdout.write("provider  model  context  max-out  thinking  images\nfake  fake-model  1K  1K  yes  no\n");
	process.exit(0);
}

setTimeout(() => {
	const body = JSON.stringify({
		token: process.env.PI_SIMPLE_TEAM_CALLBACK_TOKEN,
		team: process.env.PI_SIMPLE_TEAM_TEAM,
		from: process.env.PI_SIMPLE_TEAM_MEMBER,
		tool: "teammain",
		args: { message: "callback ownership test" },
	});
	const request = http.request(process.env.PI_SIMPLE_TEAM_CALLBACK_URL, {
		method: "POST",
		headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
	}, (response) => response.resume());
	request.on("error", (error) => process.stderr.write(String(error)));
	request.end(body);
}, 50);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	input += chunk;
	while (input.includes("\n")) {
		const newline = input.indexOf("\n");
		const line = input.slice(0, newline);
		input = input.slice(newline + 1);
		if (!line.trim()) continue;
		const command = JSON.parse(line);
		const response = {
			type: "response",
			id: command.id,
			command: command.type,
			success: true,
			...(command.type === "get_state" ? { data: { isStreaming: false } } : {}),
			...(command.type === "get_session_stats" ? { data: { contextUsage: { tokens: 87_000, contextWindow: 272_000, percent: 31.985 } } } : {}),
		};
		process.stdout.write(JSON.stringify(response) + "\n");
	}
});
process.stdin.resume();
`;

function installFakePi(): { restore: () => void } {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-team-test-"));
	const executable = path.join(directory, "pi");
	fs.writeFileSync(executable, fakePiScript, { mode: 0o755 });
	const previousPath = process.env.PATH;
	process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`;

	return {
		restore: () => {
			process.env.PATH = previousPath;
			fs.rmSync(directory, { recursive: true, force: true });
		},
	};
}

describe("team ownership across in-process AgentSessions", () => {
	test("the session roster keeps teammate colors consistent across tool renderers", async () => {
		const fakePi = installFakePi();
		const host = new ExtensionHost();
		const team = "color-roster-team";

		try {
			await host.execute("team_spawn", {
				team,
				teamPrompt: "Color roster test.",
				teammates: [
					{ name: "implementer", prompt: "Wait.", model: "fake/fake-model", thinking: "low" },
					{ name: "reviewer", prompt: "Wait.", model: "fake/fake-model", thinking: "low" },
				],
			});
			const statusResult = await host.executeResult("teamstatus", { team });
			const logResult = await host.executeResult("teamlog", { team });

			assert.match(
				host.renderResult("teamstatus", statusResult, { team }).join("\n"),
				/«customMessageLabel:reviewer/,
				"Expected Team Status to use the reviewer color from the session roster.",
			);
			assert.match(
				host.renderResult("teamlog", logResult, { team }).join("\n"),
				/«customMessageLabel:reviewer/,
				"Expected Team Log to use the same reviewer color from the session roster.",
			);
		} finally {
			await host.shutdown();
			fakePi.restore();
		}
	});

	test("shutting down another session leaves the owner's team available", async () => {
		const owner = new ExtensionHost();
		const foreignSession = new ExtensionHost();
		const team = "shutdown-owner-team";

		try {
			await spawnEmptyTeam(owner, team);
			await foreignSession.shutdown();

			let status: { team: string } | undefined;
			await assert.doesNotReject(async () => {
				status = await owner.execute<{ team: string }>("teamstatus", { team });
			}, "Expected a foreign AgentSession shutdown to leave the owner's team available.");
			assert.equal(status?.team, team, `Expected owner to retain ${JSON.stringify(team)} after the foreign session shut down.`);
		} finally {
			await shutdownHosts(owner, foreignSession);
		}
	});

	test("a session lists only teams it owns", async () => {
		const owner = new ExtensionHost();
		const foreignSession = new ExtensionHost();
		const team = "status-owner-team";

		try {
			await spawnEmptyTeam(owner, team);
			const ownerStatus = await owner.execute<{ teams: Record<string, JsonRecord> }>("teamstatus", {});
			const foreignStatus = await foreignSession.execute<{ teams: Record<string, JsonRecord> }>("teamstatus", {});

			assert.deepEqual(
				{
					owner: Object.keys(ownerStatus.teams),
					foreign: Object.keys(foreignStatus.teams),
				},
				{ owner: [team], foreign: [] },
				"Expected each AgentSession to see only teams created through its own extension instance.",
			);
		} finally {
			await shutdownHosts(owner, foreignSession);
		}
	});

	test("a session cannot explicitly shut down another session's team", async () => {
		const owner = new ExtensionHost();
		const foreignSession = new ExtensionHost();
		const team = "explicit-owner-team";

		try {
			await spawnEmptyTeam(owner, team);
			await assert.rejects(
				() => foreignSession.execute("team_shutdown", { team }),
				/Unknown team/,
				"Expected team_shutdown to reject a team owned by another AgentSession.",
			);

			const status = await owner.execute<{ team: string }>("teamstatus", { team });
			assert.equal(status.team, team, `Expected rejected foreign shutdown to leave ${JSON.stringify(team)} available to its owner.`);
		} finally {
			await shutdownHosts(owner, foreignSession);
		}
	});

	test("teammain callbacks are delivered to the AgentSession that owns the team", async () => {
		const fakePi = installFakePi();
		const receipt = messageReceipt(2);
		const firstOwner = new ExtensionHost(receipt.record);
		const secondOwner = new ExtensionHost(receipt.record);

		try {
			await firstOwner.execute("team_spawn", {
				team: "callback-owner-a",
				teamPrompt: "Callback ownership test.",
				teammates: [{ name: "teammate-a", prompt: "Wait.", model: "fake/fake-model", thinking: "low" }],
			});
			await secondOwner.execute("team_spawn", {
				team: "callback-owner-b",
				teamPrompt: "Callback ownership test.",
				teammates: [{ name: "teammate-b", prompt: "Wait.", model: "fake/fake-model", thinking: "low" }],
			});
			await receipt.wait();

			assert.deepEqual(
				{
					firstOwner: firstOwner.messages.map((message) => message.details?.team).sort(),
					secondOwner: secondOwner.messages.map((message) => message.details?.team).sort(),
				},
				{ firstOwner: ["callback-owner-a"], secondOwner: ["callback-owner-b"] },
				"Expected each teammate callback to use the Pi API belonging to its team's owning AgentSession.",
			);
		} finally {
			await shutdownHosts(firstOwner, secondOwner);
			fakePi.restore();
		}
	});
});

describe("context-window reports", () => {
	test("a teammate reports its own context window with no arguments", async () => {
		const tools = new Map<string, RegisteredTool>();
		const api = {
			registerMessageRenderer: () => undefined,
			registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		} as unknown as ExtensionAPI;
		registerChildTools(api, {
			callbackUrl: "http://127.0.0.1:1/callback",
			callbackToken: "unused",
			teamName: "context-team",
			teammateName: "product-head",
			visible: false,
			participants: ["product-head"],
		});
		const tool = tools.get("report_context_window");
		assert.ok(tool, "Expected teammates to register report_context_window.");
		const context = {
			getContextUsage: () => ({ tokens: 87_000, contextWindow: 272_000, percent: 31.985 }),
		} as ExtensionContext;

		const result = await tool.execute("test-call", {}, new AbortController().signal, undefined, context);

		assert.equal(
			result.content[0]?.text,
			"You have used 87k tokens out of 272k available (32%).",
			"Expected the no-argument teammate tool to identify its own report as You.",
		);
	});

	test("main removes repeated self targets, preserves teammate order, then reports itself once", async () => {
		const fakePi = installFakePi();
		const host = new ExtensionHost();
		const context = {
			getContextUsage: () => ({ tokens: 43_210, contextWindow: 200_000, percent: 21.605 }),
		} as ExtensionContext;

		try {
			await host.execute("team_spawn", {
				team: "context-team",
				teamPrompt: "Context-window report test.",
				teammates: [
					{ name: "product-head", prompt: "Wait.", model: "fake/fake-model", thinking: "low" },
					{ name: "reviewer", prompt: "Wait.", model: "fake/fake-model", thinking: "low" },
				],
			});

			const result = await host.executeResult("report_context_window", { targets: ["main", "reviewer", "main", "product-head"] }, context);

			assert.equal(
				result.content[0]?.text,
				"Teammate reviewer has used 87k tokens out of 272k available (32%).\nTeammate product-head has used 87k tokens out of 272k available (32%).\nYou have used 43k tokens out of 200k available (22%).",
				"Expected one string in target order with main's report last.",
			);
		} finally {
			await host.shutdown();
			fakePi.restore();
		}
	});
});

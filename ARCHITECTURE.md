---
updated: 2026-07-22
status: partial
audience: AI agents and maintainers
---

# Architecture

This document follows one narrow path through `pi-simple-team`: from the main agent deciding to create a team until that agent can decide to send the first `teamsend`.

The most important distinction is that **spawning a teammate creates an idle Pi RPC process; it does not prompt the teammate model.** The common and individual teammate prompts are installed as the child session's system prompt, but no child-provider request occurs during `team_spawn`.

## `team_spawn` creates idle sessions before any teammate inference

There are three different actors in this flow:

1. The **main agent** is the LLM participating in the parent Pi session.
2. The **parent extension runtime** is `pi-simple-team` executing inside that parent Pi process.
3. Each **teammate runtime** is a separate persistent `pi --mode rpc` child process. That process eventually calls its configured model provider, but only after it receives an RPC `prompt` command.

A configured system prompt is therefore not the same thing as a submitted prompt. It shapes a future inference; it does not initiate one.

## The spawn path, step by step

### Step 0: the main agent chooses a team configuration in its model response

The main agent decides, in its head, to spawn a team. It chooses the parameter values required by the `team_spawn` tool input schema:

- a team name;
- a shared team prompt;
- teammate names;
- an individual prompt for each teammate;
- a model string for each teammate; and
- optionally, a requested thinking level for each teammate.

2026-07-22, pre Pi [0.81.1 update](https://github.com/earendil-works/pi/releases/tag/v0.81.0)::Its knowledge of model-specific thinking level support is not provided by `pi-simple-team` first class. It is whatever was already available in its context or weights (e.g., has a miss rate). The aforementioned update introduces first class function(s) to get the available thinking levels, and is probably our best option.
### Step 1: the main agent emits a `team_spawn` tool call

The main model's makes a `team_spawn` tool request in that shape:

```json
{
  "team": "implementation",
  "teamPrompt": "Work together on the requested change.",
  "teammates": [
    {
      "name": "implementer",
      "prompt": "Implement the change.",
      "model": "openai/gpt-5.6-sol",
      "thinking": "max"
    }
  ]
}
```

Pi validates the call against the registered TypeBox schema and invokes the `team_spawn` implementation.

At this point:

- the main agent is waiting for its tool result;
- the parent extension is executing ordinary TypeScript; and
- no teammate process exists yet.

### Step 2: the extension validates team and teammate names

Inside `team_spawn.execute()`, the extension normalizes the team name and teammate names, then rejects:

- an already-existing team name;
- duplicate teammate names; and
- the reserved teammate name `main`.

A rejection here throws a tool error. No callback server or teammate process has been created.

### Step 3: the extension validates model resolution, not thinking support

Note::this step is relatively smelly. It works, but making bash commands and parsing their outputs rather than using Pi sdk first class equivalent means, plus not covering supported thinking levels in the first place, is error-prone. 

`validateTeammateModels()` in `model-preflight.ts` runs one child command per teammate:

```sh
pi --list-models <model-pattern>
```

These checks run concurrently. They answer whether each model pattern resolves <!-- resolves as in 100% match? pick a more specific word --> to at least one model available under the user's current Pi configuration and authentication.

These checks do **not** determine which thinking levels the resolved model supports. `--list-models` exposes only whether the model supports thinking at all.

If preflight fails, no teammate process is spawned.

### Step 4: the extension ensures that its callback server exists

The parent extension starts, or reuses, a localhost HTTP server bound to `127.0.0.1` on an ephemeral port. Child-only tools use this server to reach parent-owned team state.

The callback channel is protected by a random process-local token. Its URL and token will be passed to every teammate through environment variables.

No model provider is involved.

### Step 5: the extension creates parent-owned team state

The extension creates a `TeamState` and places it in the module-level `teams` map before spawning children. This state owns:

- the team name and shared prompt;
- the parent `ExtensionAPI` instance;
- the teammate process map;
- public statuses;
- the event log; and
- the symbol identifying the parent session that owns the team.

Only `main` has a status at this instant: `available / Main agent`.

### Step 6: the extension starts each teammate as a separate Pi RPC process

For each teammate, `startTeammate()` selects the requested thinking level or the extension's current default, `xhigh`, and spawns approximately:

```sh
pi \
  --mode rpc \
  -e <path-to-pi-simple-team/index.ts> \
  --no-prompt-templates \
  --no-themes \
  --model <requested-model> \
  --thinking <requested-level> \
  --system-prompt <composed-system-prompt>
```

`composeSystemPrompt()` combines:

1. the shared team prompt;
2. the individual teammate prompt;
3. the teammate's identity and participant list; and
4. the coordination instructions for `teamsend`, `teammain`, and `teamstatus`.

The child receives environment variables identifying its team and teammate, along with the parent callback URL and token. `PI_SIMPLE_TEAM_CHILD=1` causes the same extension entrypoint to register only child-facing callback tools instead of recursively registering another parent team runtime.

Normal extension discovery remains enabled in the child. The explicit `-e` ensures that `pi-simple-team` itself is loaded.

### Step 7: each child initializes a session, but receives no RPC prompt

The operating-system child process now exists and Pi begins initializing RPC mode. Pi resolves the selected model, constructs the session, installs the composed system prompt, loads extensions, and applies the requested thinking level. This child-side initialization proceeds concurrently with the parent-side bookkeeping in Step 8; the parent does not wait for it to finish.

Model-specific thinking support is enforced inside child Pi. If the requested level is unavailable, Pi silently clamps it to a supported level. For example, a request for `max` can become `high`, while a request for `xhigh` can become `max` when the model exposes `max` but has an `xhigh` hole.

This clamping happens during child initialization. It does **not** affect a model request because no RPC `prompt` command has been sent. Consequently:

- no child `agent_start` event has occurred;
- no child model-provider request is in flight; and
- no child response can already be streaming or completed.

The words supplied through `teamPrompt` and `teammate.prompt` are present only inside the configured system prompt. Instructions such as “as soon as you wake up, call `teamstatus`” cannot execute until the teammate receives its first actual message and the model is invoked.

### Step 8: the parent registers process plumbing without waiting for readiness

Immediately after `child_process.spawn()` returns, the extension creates a `TeammateState`, attaches:

- the JSONL stdout reader;
- stderr collection;
- RPC response correlation;
- process-exit handling; and
- the serialized delivery queue.

It records the teammate's `spawn` log entry and parent-owned `idle / Spawned` status.

The current implementation stores and logs the **requested** thinking level. It does not ask the child which level Pi actually selected after clamping.

`startTeammate()` then returns the `TeammateState` synchronously. There is no startup-ready RPC handshake, so the parent can finish `team_spawn` while a child is still completing Pi initialization. <!-- are you pointing out a potential flaw in the architecture, or a strength? --> this The process exists and its stdin can buffer subsequent RPC commands, but successful OS process creation is not proof that child initialization has completed.

### Step 9: `team_spawn` returns acceptance to the main agent

After initiating every child process, the extension returns a tool result containing:

- `accepted: true`;
- the team name;
- the teammate names; and
- the parent-owned public status map.

Here, “accepted” means that model preflight passed and the child processes were spawned. In the current implementation, it does not mean that each child completed a readiness handshake or that its requested thinking level was preserved.

Pi adds this tool result to the parent conversation and starts the main agent's next inference. The main LLM can now inspect the accepted team and decide whether to call `teamsend`.

That is the first point at which the main agent can make an informed post-spawn decision based on the tool result. The teammate sessions exist, but they remain idle until a message is delivered.

## Provider traffic at the `team_spawn` boundary

| Provider interaction | State when `team_spawn` returns |
|---|---|
| Main provider request that chose `team_spawn` | Finished before tool execution began |
| Main provider request that sees the `team_spawn` result | Begins after tool execution returns |
| Any teammate provider request | Not started |
| Any teammate streamed response | Impossible yet |

The first teammate provider request occurs only after the parent runtime sends that child an RPC `prompt` command. A later `teamsend` initiates that delivery path; `team_spawn` itself never does.

## Thinking state is currently requested state, not authoritative state

The current extension has three different notions that should not be conflated:

1. **Requested level:** the value chosen by the main agent, or the extension default `xhigh`.
2. **Supported levels:** the model-specific set known by child Pi.
3. **Actual level:** the supported level child Pi selected after applying or clamping the request.

`pi-simple-team` currently retains only the requested value in `TeammateState.thinking`. Child Pi owns the actual value. Although later `get_state` calls return the actual `thinkingLevel`, the extension's busy-state polling reads only `isStreaming` and discards that field.

The practical current policy is therefore: ask Pi for a level, accept whatever Pi selects, and neither verify nor expose whether it changed the request.

## The new RPC query can make spawn authoritative without racing inference

Pi 0.81.1 added this child RPC command:

```json
{"type":"get_available_thinking_levels"}
```

`pi-simple-team` does not currently use it. If adopted, it belongs inside `team_spawn`, between child initialization and the successful tool result—not as another main-agent tool call.

The strengthened initialization sequence would be:

1. Start the child RPC process.
2. Send `get_available_thinking_levels` through the child's stdin and await its correlated response.
3. Decide how an unsupported explicit request should be handled, or choose a supported default when no level was supplied.
4. If needed, send the already-existing RPC command:

   ```json
   {"type":"set_thinking_level","level":"high"}
   ```

5. Store and log the resulting actual level.
6. Only then return `team_spawn` success.

Pi would still perform its initial clamp before the query because a model and initial thinking level are needed to construct the child session. That clamp is harmless at this stage: the child is idle and has made no provider request. The extension can query and update the session before exposing the completed team to the main agent.

This handshake would require no extra tool call or reasoning step from the main agent. The main agent would remain suspended inside its original `team_spawn` tool call until initialization became authoritative.

## Relevant implementation entrypoints

- `index.ts`: parent team state, RPC transport, `startTeammate()`, and `team_spawn`
- `model-preflight.ts`: model-pattern availability checks
- `system-prompt.ts`: teammate system-prompt composition
- `child-tools.ts`: tools registered inside teammate RPC processes

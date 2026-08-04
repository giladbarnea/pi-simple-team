---
updated: 2026-08-04
status: partial
audience: AI agents and maintainers
---

# Architecture

`pi-simple-team` runs one parent extension runtime and one persistent `pi --mode rpc` child process per teammate. `team_spawn` configures idle child sessions. A teammate model runs only after the parent delivers its first message.

## Runtime actors and ownership

The **main agent** is the LLM in the parent Pi session. It chooses when to create a team and use its tools.

The **parent extension runtime** owns every team created by its Pi session. Its `TeamState` contains members, statuses, the event log, and the session owner symbol.

Each **teammate runtime** is a separate Pi RPC process with its own context. Child tools reach parent-owned state through an authenticated localhost callback server.

## The spawn path has six phases

### 1. Validate the request

Pi first validates the `team_spawn` call against its TypeBox schema. The extension then rejects an existing team name, duplicate teammate names, and the reserved name `main`.

`validateTeammateModels()` checks all model patterns concurrently through `pi --list-models`. These checks confirm that each pattern resolves, but do not inspect model-specific thinking levels.

If validation fails, the extension creates no team state or child process.

### 2. Create parent-owned state

The extension starts or reuses a callback server on `127.0.0.1` with an ephemeral port and random process-local token.

It then creates `TeamState` and stores it in the module-level team map. Only `main` has a status at this point: `available / Main agent`.

### 3. Start each child process

`startTeammate()` uses the requested thinking level or the default `xhigh`. It spawns approximately:

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

The system prompt combines the team prompt, teammate prompt, identity, participant list, and coordination instructions.

Environment variables carry the team identity, callback URL, and callback token. `PI_SIMPLE_TEAM_CHILD=1` makes the extension register only child-facing tools in that process.

Normal extension discovery remains enabled. The explicit `-e` flag makes sure `pi-simple-team` also loads in the child.

### 4. Attach process plumbing

After `child_process.spawn()` returns, the parent attaches the JSONL reader, stderr collection, RPC response correlation, exit handling, and serialized delivery queue.

The parent records a `spawn` log entry and an `idle / Spawned` status. It does not wait for a child readiness signal.

### 5. Return acceptance

`team_spawn` returns `accepted: true`, the team name, teammate names, and the current status map.

Acceptance means that preflight passed and child processes were started. It does not confirm child initialization or the actual thinking level selected by Pi.

### 6. Deliver the first message

A later `teamsend` enters the recipient's delivery queue. The parent sends an RPC `prompt`, `steer`, or abort-then-prompt sequence based on the recipient state.

## Current limitations

- Model preflight accepts any `pi --list-models` match. A fuzzy pattern can resolve to more than one model.
- `team_spawn` has no readiness handshake. A child can still be initializing when the tool returns.
- The parent stores the requested thinking level. Child Pi can clamp it to a supported level without reporting that change to the parent.

The extension's `get_state` polling reads `isStreaming` and ignores the returned `thinkingLevel`. Its practical policy is to request a level, accept Pi's choice, and expose only the request.

## An RPC query could make spawn authoritative without racing inference

Pi exposes this child RPC command:

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

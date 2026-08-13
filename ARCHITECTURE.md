---
updated: 2026-08-13
status: partial
audience: AI agents and maintainers
---

# Architecture

`pi-simple-team` runs one parent extension runtime and one persistent Pi child session per teammate. Default teammates run as `pi --mode rpc` child processes. With `showOnHerdrPanes`, they run in Herdr panes. `team_spawn` configures idle child sessions. A teammate model runs when it receives a prompt.

## Runtime actors and ownership

The **main agent** is the LLM in the parent Pi session. It chooses when to create a team and use its tools.

The **parent extension runtime** owns every team created by its Pi session. Its `TeamState` contains members, statuses, the event log, and the session owner symbol.

Each **teammate runtime** is a separate Pi process with its own context. Child tools reach parent-owned state through an authenticated localhost callback server.

## `/team` reads owner-bound snapshots without owning team state

`index.ts` registers `/team` only in the parent runtime. Its handler passes `openTeamOverview()` a source bound to that extension runtime's private owner symbol.

`ownedTeamSnapshots(owner)` is the view/data boundary. It filters the module-level team map by owner, then copies each owned team's name, metadata, roster, statuses, and log into a `TeamSnapshot`. This ownership check prevents one Pi session's dashboard from exposing another session's teams.

`team-ui.ts` owns the read-only presentation layer. It defines `TeamSnapshot`, accepts only a `TeamSnapshotSource`, and never imports or mutates `TeamState`. The view cannot send messages, change statuses, or reach teammate processes.

The overlay calls its snapshot source on every render. A 500 ms timer requests a new render while the overlay is open, so live data comes from fresh parent-owned snapshots rather than view-side state. Closing the overlay clears that timer.

With no snapshots, the command renders an empty state. One snapshot opens directly. Multiple snapshots render a selector before the dashboard.

The 90% overlay has one outer frame and fixed bordered regions for metadata, status, messages, and the non-message log. Region heights depend on the terminal height, not incoming data, so updates cannot move the boundaries. The view has no scrolling path.

The status region shows at most the five most recently updated participants. It aligns the name, status word, and phrase columns, then right-aligns timestamps.

The message region turns `send` and `main_message` entries into message views. It chooses the newest message groups that fit and keeps those groups in chronological order. If one message exceeds its region, the view retains its outer lines around an omission marker.

The log region excludes messages and their delivery entries: `send`, `deliver`, `ack`, and `main_message`. This separation prevents message activity from duplicating the message view. The region considers at most the latest 20 non-message entries, then shows the newest rows that fit in chronological order.

Every region uses middle truncation for horizontal overflow. This preserves both ends of names, status phrases, messages, and event rows without changing the fixed layout.

## The spawn path has six phases

### 1. Validate the request

Pi first validates the `team_spawn` call against its TypeBox schema. The extension then rejects an existing team name, duplicate teammate names, and the reserved name `main`.

`validateTeammateModels()` confirms that each requested canonical provider/model ID is in Pi's available-model registry. It does not inspect model-specific thinking levels.

If validation fails, the extension creates no team state or child process.

### 2. Create parent-owned state

The extension starts or reuses a callback server on `127.0.0.1` with an ephemeral port and random process-local token.

It then creates `TeamState` and stores it in the module-level team map. Only `main` has a status at this point: `available / Main agent`.

### 3. Start each teammate session

`startTeammate()` uses the requested thinking level or the default `xhigh`. For an RPC teammate, it spawns approximately:

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

For a Herdr teammate, `startTeammate()` runs `herdr agent start ... -- pi ...` and waits for its local registration callback.

### 4. Attach process plumbing

After `child_process.spawn()` returns for an RPC teammate, the parent attaches the JSONL reader, stderr collection, RPC response correlation, exit handling, and serialized delivery queue.

For an RPC teammate, the parent records a `spawn` log entry and an `idle / Spawned` status. It does not wait for a child readiness signal.

### 5. Return acceptance

`team_spawn` returns `accepted: true`, the team name, teammate names, and the current status map.

Acceptance means that preflight passed, RPC child processes were started, and Herdr teammates registered successfully. For RPC teammates, it does not confirm child initialization or the actual thinking level selected by Pi.

### 6. Deliver the first message

A later `teamsend` enters the recipient's delivery queue. For an RPC teammate, the parent sends a `prompt`, `steer`, or abort-then-prompt sequence based on the recipient state. For a Herdr teammate, it calls the local delivery endpoint.

## Current limitations

- RPC teammates have no readiness handshake. A child can still be initializing when the tool returns.
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

- `team-ui.ts`: `/team` overlay, selector, snapshot refresh, and bounded dashboard rendering
- `index.ts`: parent team state, owner-scoped snapshot adapter, `/team` registration, teammate transport, `startTeammate()`, and `team_spawn`
- `model-preflight.ts`: available-model validation
- `system-prompt.ts`: teammate system-prompt composition
- `child-tools.ts`: tools registered inside teammate child processes

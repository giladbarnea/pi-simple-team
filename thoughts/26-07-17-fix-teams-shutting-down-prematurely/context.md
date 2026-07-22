---
date: 2026-07-17
status: ready-for-implementation
purpose: handoff + implementation plan + behavioral pseudocode
---

# Stop one in-process Pi session from shutting down another session’s teams

## The bug is cross-session ownership, not idle expiry

The user wants `pi-simple-team` teams to remain alive while the main agent and teammates are idle. No polling, heartbeat, busy-wait, or artificial sleep should be necessary. A team should stop only through its owning session’s legitimate teardown or an explicit `team_shutdown`.

The observed failure looked like an idle timeout: after the main agent stopped polling `teamstatus` for roughly nine minutes, `teamstatus` returned `Unknown team` and then `teams: {}`. The actual trigger was a background `/agent` run from `agent/extensions/pi-user-agents/`, not idleness.

The chosen solution is stronger than merely protecting shutdown cleanup. Every in-process `AgentSession` must own, see, control, and receive callbacks from only its own teams, while the process-wide callback server remains available as long as any owner still has a team.

Success means:

1. Shutting down an in-process `/agent` session cannot delete, kill, message, inspect, or otherwise affect a team created by the main TUI session.
2. Each session’s `teamstatus`, `teamsend`, `teamlog`, and `team_shutdown` operate only on teams that session created.
3. A teammate’s `teammain` callback is delivered through the `ExtensionAPI` belonging to that teammate’s team owner—not whichever session happened to start the shared callback server first.
4. The shared callback server remains open while any team exists and can be cleanly reopened after the final team is stopped.
5. Existing child-process behavior, TUI rendering, payloads, and teammate-facing tools remain unchanged.

## The root cause is proven

`/agent` is a separate SDK `AgentSession`, but it is not a separate OS process or module universe:

```text
Pi process
│
├─ one cached pi-simple-team module
│    ├─ shared teams Map
│    ├─ shared callbackServer
│    └─ shared callbackUrl/token
│
├─ main TUI AgentSession
│    └─ pi-simple-team factory invocation + shutdown handler
│
└─ background /agent AgentSession
     └─ another pi-simple-team factory invocation + shutdown handler
```

`agent/extensions/pi-user-agents/runner.ts` calls `createAgentSessionServices()` with the normal agent directory. That loads the full global extension suite, including `pi-simple-team`, into the background SDK session. Node’s module cache means both factory invocations share `pi-simple-team/index.ts` module globals.

When the background agent finishes, `runner.ts:287` emits:

```text
session_shutdown(reason = quit)
```

The background session’s `pi-simple-team` handler currently iterates over the process-wide `teams` map, shuts down every team, and closes the process-wide callback server. It therefore destroys teams created by the main TUI session.

The experiment timeline confirms the causal sequence:

```text
10:25:50  /agent documentation research starts
10:25:54  main agent stops polling teamstatus
10:28:23  /agent finishes and emits session_shutdown("quit")
           current pi-simple-team handler kills every shared team
10:34:24  a second /agent finishes; the shared map is already empty
10:34:52  teamstatus reports Unknown team
```

The parent Pi process itself did not restart: PID 24004 had been alive since 09:33:59. RPC mode also has no idle garbage collection; it deliberately remains alive until stdin closes, it receives a terminating signal, or an extension requests shutdown.

A crucial diagnostic fact is that `teamstatus` never contacts a teammate process. It only reads the parent extension’s cached map. Polling appeared protective solely because the user was not dispatching `/agent` work while occupied with the polling experiment.

## Current code has process-wide state but no owner boundary

The affected implementation is `agent/extensions/pi-simple-team/index.ts`.

Current module-level state:

- `teams: Map<string, TeamState>`
- `callbackServer`
- `callbackUrl`
- `callbackToken`

Current ownership gaps:

1. `TeamState` has no session owner or owning `ExtensionAPI`.
2. `resolveTeam()` and `allStatuses()` expose every process-wide team to every factory invocation.
3. `session_shutdown` shuts down every process-wide team.
4. `ensureCallbackServer(pi)` captures the first caller’s `pi` API in the HTTP handler. A team created by another in-process session would therefore send `teammain` to the wrong session.
5. `team_shutdown` and spawn-failure cleanup do not centrally decide whether the now-unused callback server should close.

The teammate RPC children are separate Pi processes marked with `PI_TEAM_LITE_CHILD=1`. They take the early `registerChildTools()` path and are not the source of this collision.

## The fix makes ownership explicit at every boundary

Each non-child invocation of the extension factory gets an opaque owner identity. Every created `TeamState` records that owner and the factory invocation’s `ExtensionAPI`.

The process-wide map and HTTP listener remain shared because teammate callback requests currently identify a team by its globally unique team name. Team names therefore remain globally unique across in-process owners; allowing duplicate visible names would require a new callback identity protocol and is out of scope.

The resulting invariants are:

```text
A main-facing tool resolves teams only within its factory owner.
A session shutdown stops only teams belonging to that owner.
A teammate callback resolves the team globally by name,
then delivers through that TeamState’s owning ExtensionAPI.
The callback server closes only when the global teams map is empty.
```

Behavioral pseudocode:

> Give every extension factory invocation a private owner identity. When it creates a team, attach that identity and its Pi API to the team. Resolve all main-facing team operations against only teams carrying the caller’s identity. On session shutdown, stop only those owned teams. For a teammate callback, locate the globally named team and route the message through the Pi API stored on that team. After any cleanup, close the shared callback server only if no teams owned by any session remain.

## The route to done is four vertical slices

1. Reproduce the original cross-session shutdown through the extension’s public lifecycle and tools.
2. Make team lifecycle and main-facing tool lookup owner-scoped.
3. Route teammate callbacks to the owning Pi API and preserve the shared server across foreign shutdowns.
4. Run the full automated suite, then repeat the original incident manually with a real team and `/agent`.

Do not write all tests and then all implementation. Complete each red-to-green slice before starting the next.

```text
A. Deterministic extension host and fake RPC boundary
                │
                v
B. Foreign shutdown regression ──► owner-scoped lifecycle
                │
                v
C. Cross-owner tool isolation ───► owner-scoped resolution
                │
                v
D. Callback routing regression ──► TeamState-owned Pi API
                │
                v
E. Full suite + real /agent acceptance test
```

| Node | Complexity / risk | Rough diff | Reversibility | Needs the user |
|---|---|---:|---|---|
| A. Test host | Medium, low production risk | Small fixture | Easy | No |
| B. Lifecycle ownership | Low–medium, high correctness value | Small | Easy | No; direction approved |
| C. Tool isolation | Medium, moderate behavior risk | Small–medium | Easy | No; stronger isolation approved |
| D. Callback ownership | Medium, highest concurrency risk | Small–medium | Easy | No |
| E. Verification | Low implementation risk | Tests only | N/A | Manual `/agent` smoke test is easiest with the user present |

No parallel implementation is useful here: each slice teaches the exact shape required by the next.

## Slice 1 — prove a foreign session cannot kill an owned team

Test through public extension behavior. Invoke the default extension factory twice in one test process with two small `ExtensionAPI` host fixtures. The hosts capture registered tools, lifecycle handlers, and delivered custom messages. Use a deterministic fake `pi` executable (or an equivalently narrow process-boundary fixture) for model preflight and RPC responses; do not mock the ownership logic itself.

The test flow:

```text
Register session A and session B from the same cached module.
Session A calls team_spawn with a fake RPC teammate.
Session B emits session_shutdown("quit").
Session A calls teamstatus and teamsend.
The fake teammate answers through the callback path.
Observe that A’s team still exists and its child was not killed.
Always clean up A in a finally/afterEach path.
```

Definition of done:

- The test fails on current code because B’s shutdown removes A’s team.
- After the minimal lifecycle ownership change, A can still resolve and contact its team.
- The test has a bounded event/timeout wait, not polling or `sleep`.
- Teammate processes are cleaned up even when an assertion fails.

Failure criteria:

- The test only inspects a new owner field or calls private helpers.
- The fake replaces the registry or shutdown behavior being tested.
- The test passes without proving the teammate remains reachable.
- It relies on a configured real model or an external API request.

Pseudocode:

> Create two realistic extension hosts in one process, let the first create and contact a team, shut down the second host, then prove through the first host’s public tools and callback result that its team survived intact.

Out of scope for this slice: cross-owner access controls, callbacks for teams owned by both sessions, and callback-server final closure.

## Slice 2 — scope lifecycle and every main-facing tool to its owner

Add the owner identity to `TeamState` and bind one identity inside each non-child factory invocation. Change resolution so explicit names, implicit single-team resolution, and all-team status listing consider only the caller’s owned teams.

Apply owner-scoped resolution consistently to:

- `teamsend`
- `teamstatus`
- `teamlog`
- `team_shutdown`
- the owner’s `session_shutdown` handler

`team_spawn` records the factory owner and owning Pi API. Global duplicate team-name rejection remains unchanged because callbacks still use team name as their global key.

Add the next behavior test only after Slice 1 is green:

```text
Session A creates team-a.
Session B creates team-b.
Each session lists only its own team.
Each session receives Unknown team for the other owner’s explicit name.
B shuts down: team-b stops, team-a remains reachable.
A explicitly shuts down team-a.
```

Definition of done:

- No main-facing tool can inspect, send to, log, update, or stop a foreign-owned team.
- Implicit resolution reports zero/one/multiple teams based on owned teams only.
- Shutting down one owner leaves every other owner’s teams and statuses intact.
- Existing single-session behavior and response payloads are unchanged.

Failure criteria:

- Only `session_shutdown` is owner-aware while tools still see foreign teams.
- Ownership is tracked in a parallel name set that can drift from `TeamState`.
- Missing ownership silently falls back to global access.

Pseudocode:

> Treat the factory owner as part of team identity for every main-facing operation: filter before listing, require ownership before resolving an explicit name, and stop only the teams selected by that same rule.

Out of scope: changing teammate-to-teammate addressing inside a team, changing globally unique team names, or persisting ownership across a full Pi process restart.

## Slice 3 — route callbacks through the team owner

The shared callback server must not capture one factory invocation’s `pi` API. Start it without a session-specific API dependency. When a callback arrives, resolve the globally named team, then use the owning API stored on that `TeamState` for `teammain` delivery.

A deterministic fake RPC teammate can exercise the actual loopback boundary: after receiving a parent prompt, it posts `teammain` using the callback URL and token passed through its environment. The test host resolves a promise when `sendMessage` is called, avoiding sleeps and busy-waiting.

The test flow:

```text
A owns team-a; B owns team-b.
A teammate calls teammain: only A records the message.
B teammate calls teammain: only B records the message.
B shuts down.
A teammate calls teammain again: A still receives it.
A shuts down its last team.
A later spawn can recreate the listener and receive another callback.
```

Definition of done:

- `teammain` always enters the owning session.
- A foreign session shutdown cannot close the server while another team exists.
- Removing the final team leaves no stale listener state and a later spawn reopens it successfully.
- Existing callback-token authorization behavior remains unchanged.

Failure criteria:

- The callback handler still closes over the first factory’s `pi` API.
- A callback can be delivered to both owners or the wrong owner.
- Server lifetime is tied to a session rather than the global team count.

Pseudocode:

> Keep one process-wide authenticated callback listener, but make delivery team-scoped: use the request’s team name to find its owner and send through that team’s Pi API. After any team cleanup, retain the listener while at least one team remains; otherwise close it and clear its reusable state.

Out of scope: separate servers or tokens per owner, changing the HTTP protocol, network exposure beyond loopback, or reconnecting teams after process replacement.

## Slice 4 — prove the original user workflow

Run the focused and full test suites from `~/.pi/agent`:

```text
bun test extensions/pi-simple-team/test
bun test
```

Then reload Pi so the changed extension is active and repeat the real acceptance flow:

```text
Spawn a real two-teammate team.
Confirm teamstatus.
Run /agent -i with a trivial task and wait for its completion.
Confirm teamstatus still finds the original team.
Send a teammate a request to reply through teammain.
Observe the reply in the main TUI.
Shut down the team explicitly.
```

Definition of done:

- All existing tests remain green.
- The new regression tests are green and would fail if ownership filtering or callback routing were removed.
- The real `/agent` completion no longer affects the main team.
- `team_shutdown` still kills both teammate RPC processes.

Failure criteria:

- Only cached status survives while the teammate processes or callback path are dead.
- Verification requires periodic polling to keep anything alive.
- Fixing this regression changes renderer output or user-facing payloads unexpectedly.

Pseudocode:

> Recreate the incident with real Pi processes: let a background SDK session finish while a main-owned team waits, then prove both control traffic and teammate-to-main traffic still work before explicitly shutting the team down.

## The test harness should fake only system boundaries

Create `agent/extensions/pi-simple-team/test/runtime-ownership.test.ts` plus the smallest fixture needed for a deterministic fake `pi` executable or process adapter.

The host fixture may fake `ExtensionAPI` because Pi itself is the framework boundary. It should only:

- collect tool definitions registered by the extension;
- collect lifecycle handlers and emit them;
- record `sendMessage` deliveries;
- satisfy renderer registration calls.

The fake RPC boundary may:

- make `--list-models` report a deterministic model;
- answer `get_state`, `prompt`, `steer`, and `abort` JSONL commands;
- post an authenticated `teammain` callback when directed;
- expose exit/kill observably for cleanup assertions.

Do not mock `resolveTeam`, team ownership filtering, shutdown selection, callback dispatch, or callback-server lifetime. Those are the behavior under test.

Use informative assertion messages. Protect cleanup with `try/finally` or test hooks so a red test cannot leave child processes running.

## Files and state to preserve

Primary implementation files:

- `agent/extensions/pi-simple-team/index.ts` — ownership, tool registration, process lifecycle, callback server.
- `agent/extensions/pi-simple-team/child-tools.ts` — teammate tools; no ownership change expected.
- `agent/extensions/pi-simple-team/test/runtime-ownership.test.ts` — planned regression coverage.
- Existing tests under `agent/extensions/pi-simple-team/test/`.

Root-cause evidence:

- `agent/extensions/pi-user-agents/index.ts`
- `agent/extensions/pi-user-agents/runner.ts`, especially `runUserAgent()` around lines 243–288.
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js`

Existing uncommitted `pi-simple-team` edits are intentional and unrelated to the ownership fix:

- `index.ts`: `team_spawn` now tells the main agent that `main` is included automatically.
- `child-tools.ts`: teammate `teamsend` now directs messages for the main agent to `teammain`.

The working tree also contains unrelated changes under `pi-user-agents`, `settings.json`, and session/compaction artifacts. Do not modify, revert, stage, or include them while implementing this fix.

## Keep the resolution minimal

Explicitly out of scope:

- heartbeats, polling loops, keepalive timers, or idle timeouts;
- changing `pi-user-agents` extension loading;
- preserving teams across explicit owner-session `reload`, `new`, `resume`, `fork`, or full process exit;
- a daemon, broker process, detached-team persistence, or crash recovery;
- duplicate visible team names across in-process owners;
- renderer or payload redesign;
- teammate session-storage changes;
- cleanup of unrelated dirty-tree files.

The final deliverable is complete as soon as owner isolation, owner-correct callback delivery, deterministic regression coverage, and the real `/agent` acceptance flow are green. Do not add generalized lifecycle infrastructure beyond what those behaviors require.

## Immediate continuation point

No ownership implementation has started. Begin with Slice 1 only: build the narrow host/process fixture, write the exact foreign-shutdown regression, and run it red against the current code. Then make only the lifecycle change required to turn that one test green before proceeding to Slice 2.

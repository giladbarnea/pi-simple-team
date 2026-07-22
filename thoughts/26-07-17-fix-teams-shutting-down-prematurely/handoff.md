---
date: 2026-07-19
status: implementation-green-awaiting-manual-acceptance
purpose: continuation handoff
---

# Finish team ownership isolation across in-process Pi sessions

## Task overview

`pi-simple-team` teams must remain alive while agents are idle. They should require no polling, heartbeat, or artificial sleep. A team should stop only through an explicit `team_shutdown` or the legitimate teardown of the in-process `AgentSession` that created it.

The user chose full session ownership isolation rather than the narrower shutdown-only patch. Every main-facing team tool must see and control only teams created by its own extension-factory invocation, and teammate callbacks must return to that owning session.

## The bug was cross-session cleanup, not idle expiry

The `/agent` command in `agent/extensions/pi-user-agents/` creates a second SDK `AgentSession` inside the main Pi process. It uses the normal agent directory, so it loads the complete extension suite, including `pi-simple-team`.

Both sessions invoke the cached `pi-simple-team` module factory. Their handlers are session-specific, but the module-level `teams` map and callback-server variables are process-wide. When a background `/agent` finished, `pi-user-agents/runner.ts` emitted `session_shutdown(reason = "quit")`. The background session's old `pi-simple-team` shutdown handler iterated over the shared map and killed the main TUI session's teams.

The original experiment proved the timing:

```text
10:25:50  /agent documentation research started
10:25:54  main stopped polling teamstatus
10:28:23  /agent finished and emitted session_shutdown("quit")
           old pi-simple-team handler killed all shared teams
10:34:52  teamstatus returned Unknown team
```

The parent Pi process never restarted, and RPC mode has no idle garbage collector. `teamstatus` also never contacts teammate processes; it only reads parent memory. Polling appeared protective because the user was not dispatching `/agent` work while polling.

## Current implementation

Only `agent/extensions/pi-simple-team/index.ts` is modified in the working tree at handoff time.

The implementation now establishes these invariants:

1. Every non-child extension-factory invocation creates a private `owner` symbol.
2. Every `TeamState` stores both that `owner` and its `ownerPi: ExtensionAPI`.
3. `resolveTeam(owner, ...)` filters explicit and implicit main-facing lookups by owner.
4. `teamstatus`, `teamsend`, `teamlog`, and `team_shutdown` all use owner-scoped resolution.
5. `allStatuses(owner)` lists only the caller's teams.
6. `session_shutdown` stops only teams carrying that factory invocation's owner.
7. The shared callback server no longer captures the first session's Pi API.
8. `teammain` resolves the globally unique team name, then delivers through `team.ownerPi`.
9. The callback server closes only when the process-wide teams map becomes empty. Spawn-failure cleanup and explicit `team_shutdown` use the same final-team check.

Public tool signatures and payloads are unchanged. Team names remain globally unique across in-process owners because the callback protocol identifies teams by name.

## Tests and evidence

Regression tests were committed before implementation in:

- `agent/extensions/pi-simple-team/test/session-ownership.test.ts`
- Commit: `cdbae88 pi-simple-team: test team ownership across AgentSessions`

They exercise the default extension factory through a small `ExtensionAPI` host and fake only the Pi/RPC system boundary. The ownership logic, tools, lifecycle handlers, loopback callback server, and callback dispatch are real.

The tests were run red before each corresponding implementation slice:

```text
foreign session shutdown       -> Unknown team
foreign status listing         -> exposed owner's team
callback routing               -> both callbacks reached first Pi API
```

They are now green:

```text
bun test extensions/pi-simple-team/test/session-ownership.test.ts
4 passed, 0 failed

bun test extensions/pi-simple-team/test
89 passed, 0 failed

bun test
204 passed, 0 failed
```

The final diff was inspected with `gsd`. No files outside `agent/extensions/pi-simple-team/index.ts` were changed by the implementation.

## Necessary next step: real acceptance test

The automated implementation is complete, but do not call the task fully done until the original workflow succeeds with real Pi processes.

The active TUI must first run `/reload`; the current in-memory extension instance does not contain the new code. Then perform:

```text
1. Spawn a real team with two teammates.
2. Confirm teamstatus sees it.
3. Run a trivial /agent -i task and let it finish.
4. Confirm teamstatus still sees the original team.
5. Send one teammate a request to reply through teammain.
6. Observe the reply in the owning main TUI session.
7. Explicitly shut down the team.
```

This must work without polling. It proves the cached status, teammate processes, shared callback server, and owner-correct `teammain` path all survived the foreign `/agent` shutdown.

After acceptance, inspect `git status` and `gsd` again. Commit only `agent/extensions/pi-simple-team/index.ts` unless the user explicitly requests otherwise. This handoff document itself is newly created and should be included only if the user wants the diagnostic record committed.

## Constraints and scope boundaries

Preserve the existing intentional behavior and avoid expanding the task:

- No heartbeats, polling loops, timers, daemons, or detached persistence.
- Do not change `pi-user-agents` extension loading.
- Teams do not survive their own owner's explicit `reload`, `new`, `resume`, `fork`, or process exit.
- Do not allow duplicate visible team names across owners without redesigning callback identity.
- Do not change renderers, payload design, teammate tools, or public tool schemas.
- Do not touch unrelated working-tree files.

`agent/extensions/pi-simple-team/thoughts/26-07-17-fix-teams-shutting-down-prematurely/context.md` contains the full root-cause investigation and original vertical-slice plan. Treat this handoff as the canonical current-state update.

## Baseline files already studied

- `agent/extensions/pi-simple-team/index.ts`
- `agent/extensions/pi-simple-team/child-tools.ts`
- `agent/extensions/pi-simple-team/test/session-ownership.test.ts`
- `agent/extensions/pi-simple-team/thoughts/26-07-17-fix-teams-shutting-down-prematurely/context.md`
- `agent/extensions/pi-user-agents/index.ts`
- `agent/extensions/pi-user-agents/runner.ts`
- Pi extension lifecycle documentation and RPC-mode implementation under `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`

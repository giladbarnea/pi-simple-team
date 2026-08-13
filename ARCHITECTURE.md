---
updated: 2026-08-13
status: current
audience: AI agents and maintainers
---

# Architecture

A teammate is first a durable Pi session. A team attachment and an optional live runtime make that session a teammate.

```text
Team attachment
└─ Member
   ├─ Pi session identity and JSONL file
   ├─ Team prompt, teammate prompt, and roster
   └─ Optional RPC process or Herdr pane
```

The Pi session owns the conversation. The attachment owns team membership and configuration. The runtime owns only the current process or pane.

**One Pi session can have at most one live runtime.** Pi does not lock session files against concurrent writers.

## The registry persists attachments, not conversations

Persistent team manifests live under:

```text
~/.pi/agent/pi-simple-team/teams/
```

A team ID has this form:

```text
{origin-main-session-id}-{team-name}
```

The manifest stores the team ID, display name, canonical project directory, prompts, transport settings, and member session identities. It also stores lifecycle timestamps and whether each session file has ever materialized.

`team_list` reads only manifests whose canonical project directory matches the current project. Symlinked paths resolve to the same project.

Pi session JSONL files are the canonical conversation history for main and teammates. The registry stores no messages or tool results.

The in-memory `teamlog` records events only for the current parent runtime. The extension persists no separate parent-runtime log or durable `teamlog`.

## A lease prevents two parent runtimes from owning one team

An active team has an atomic lease beside its manifest. The lease identifies the main session, process, and random ownership token.

A second parent runtime cannot claim a live lease. This keeps the extension from starting two runtimes for the same teammate sessions.

A dead lease owner makes the lease stale. The next claim replaces the stale lease and marks an abandoned active manifest dormant.

The lease protects extension-managed runtimes. Users must still avoid opening a live teammate session through another Pi process.

## Team lifecycle operations change attachments and runtimes

### `team_spawn` creates sessions and a live attachment

`team_spawn` validates the roster and model patterns, claims the team lease, then starts each teammate.

RPC is the default transport. `showOnHerdrPanes` starts teammates in visible Herdr panes instead.

RPC teammates start with `pi --mode rpc`. Children disable discovered extensions and load only the explicit child side of `pi-simple-team`.

Each RPC child receives a `get_state` readiness query. A visible child reports the same identity during callback registration.

The parent records every teammate session ID and absolute session file path before it writes the active manifest. The tool result returns these identities.

### `team_add` grows only a running owned team

`team_add` requires an active team lease owned by the current main session. It creates one or more new RPC Pi sessions.

The operation does not attach an existing Pi session. Existing teammates stay asleep while the roster grows.

Before every teammate turn, the child asks the parent for the current roster. The system prompt therefore reflects additions without waking all members.

### `team_shutdown` makes the team dormant

`team_shutdown` waits for every RPC process to exit and closes every Herdr pane. It then marks the manifest dormant and releases the lease.

Shutdown preserves each Pi session and its team attachment. The parent also follows this path when its Pi session shuts down.

A dormant manifest expires 30 days after shutdown. The next registry access removes the expired manifest and lease only.

Expiration never removes or changes a Pi session JSONL file.

### `team_resume` starts all or selected stopped members

`team_resume` discovers the team through the current project registry. It resumes all stopped members unless the caller names a selection.

Resume uses RPC by default. The caller must explicitly request Herdr panes.

A persisted member starts with `pi --session <stored-session-file>`. The extension does not pass the original model or thinking level because Pi restores current session state.

Selective resume creates a valid partially running team. A later resume can start the remaining stopped members.

## Session materialization controls resume behavior

Pi assigns an idle child a session ID and session file path before it creates the JSONL file. Pi creates that file only after the first assistant response.

If the file exists, resume uses it. If the file once materialized but is now missing, resume fails instead of replacing conversation history.

If the teammate never produced an assistant response, its provisional file does not exist. Resume starts a new empty session and replaces the provisional identity.

## Runtime communication remains parent coordinated

The parent extension runtime owns live team state, status maps, delivery queues, and the process-local event log.

Child tools call an authenticated localhost callback server. The callback supplies messaging, statuses, current roster data, and visible-child lifecycle events.

Teammate messages are pushed into recipient sessions. Idle teammates wake immediately, while busy teammates receive queued delivery after their current work settles.

## Relevant implementation entrypoints

- `index.ts`: team lifecycle tools, live state, transport startup, and message delivery
- `team-registry.ts`: manifests, project discovery, expiry, and leases
- `child-tools.ts`: child callbacks, current-roster injection, and teammate tools
- `system-prompt.ts`: teammate attachment instructions
- `model-preflight.ts`: model-pattern availability checks

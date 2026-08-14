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
   ├─ Team prompt, teammate prompt, roster, and recursive-team capability
   ├─ Optional teams owned by this member's Pi session
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

The manifest stores the team ID, display name, canonical project directory, prompts, transport settings, member session identities, and each member's `canOverseeOwnTeams` capability. It also stores lifecycle timestamps and whether each session file has ever materialized.

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

RPC teammates start with `pi --mode rpc`. Children disable discovered extensions and load only the explicit `pi-simple-team` extension path.

A normal child registers only parent-team member tools. A child with `canOverseeOwnTeams: true` also registers manager tools in the same runtime.

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

## Recursive management stays session-scoped

An overseeing teammate has two roles in one Pi session. It remains a member of its parent team and acts as main for teams it creates.

The existing private owner symbol confines all live operations to teams created through that extension runtime. This covers sends, statuses, context reports, logs, additions, and shutdowns.

Durable discovery needs an extra boundary because the registry is project-wide. In an overseeing teammate, `team_list` and `team_resume` filter manifests by `originMainSessionId` equal to that teammate's Pi session ID. The teammate therefore cannot discover or resume its parent team, sibling teams, or teams owned by unrelated sessions.

Three tool names serve both roles. `teamsend` and `teamstatus` use the parent callback when `team` is omitted and require `team` for an owned team. `report_context_window` reports the overseeing teammate when `targets` is omitted and inspects only live teammates behind its private owner symbol when `targets` is set.

The capability is part of the durable member attachment and returns on resume. Old manifests without the field load it as `false`.

When a parent stops an overseeing RPC teammate, it gives that session a longer grace period. This lets the teammate's `session_shutdown` handler stop descendant teams and release their leases before exit.

## Runtime communication remains parent coordinated

The parent extension runtime owns live team state, status maps, delivery queues, and the process-local event log.

Child tools call an authenticated localhost callback server. The callback supplies messaging, statuses, current roster data, and visible-child lifecycle events.

Teammate messages are pushed into recipient sessions. Idle teammates wake immediately, while busy teammates receive queued delivery after their current work settles.

## The `/team` dashboard reads owner-bound live snapshots

`index.ts` registers `/team` only in the parent runtime. Its handler passes `openTeamOverview()` a source bound to that extension runtime's private owner symbol.

`ownedTeamSnapshots(owner)` is the view and data boundary. It filters the module-level team map by owner, then copies each owned team's metadata, roster, statuses, and log into a `TeamSnapshot`. This ownership check prevents one Pi session's dashboard from exposing another session's teams.

`team-ui.ts` owns the read-only presentation layer. It defines `TeamSnapshot`, accepts only a `TeamSnapshotSource`, and never imports or changes `TeamState`. The view cannot send messages, change statuses, or reach teammate processes.

The overlay calls its snapshot source on every render. A 500 ms timer requests a new render while the overlay is open. Live data therefore comes from fresh parent-owned snapshots instead of view-side state. Closing the overlay clears that timer.

With no snapshots, the command renders an empty state. One snapshot opens directly. Multiple snapshots render a selector before the dashboard.

The 90% overlay has one outer frame and fixed bordered regions for metadata, status, messages, and the non-message log. Region heights depend on the terminal height, not incoming data, so updates cannot move the boundaries. The view has no scrolling path.

The status region shows at most the five most recently updated participants. It aligns the name, status word, and phrase columns, then right-aligns timestamps.

The message region turns `send` and `main_message` entries into message views. It chooses the newest message groups that fit and keeps those groups in chronological order. If one message exceeds its region, the view retains its outer lines around an omission marker.

The log region excludes messages and their delivery entries: `send`, `deliver`, `ack`, and `main_message`. This separation prevents message activity from duplicating the message view. The region considers at most the latest 20 non-message entries, then shows the newest rows that fit in chronological order.

Every region uses middle truncation for horizontal overflow. This preserves both ends of names, status phrases, messages, and event rows without changing the fixed layout.

The dashboard shows only live teams owned by the current parent runtime. Dormant attachments become visible after `team_resume` restores them into that runtime.

## Relevant implementation entrypoints

- `index.ts`: team lifecycle tools, live state, owner-scoped dashboard snapshots, transport startup, and message delivery
- `team-ui.ts`: `/team` selection, live refresh, and bounded dashboard rendering
- `team-registry.ts`: manifests, project discovery, expiry, and leases
- `child-tools.ts`: child callbacks, current-roster injection, and teammate tools
- `system-prompt.ts`: teammate attachment instructions
- `model-preflight.ts`: model-pattern availability checks

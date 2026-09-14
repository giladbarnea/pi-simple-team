---
updated: 2026-09-14
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
~/.pi/agent/pi-simple-team/teams-v2/
```

A team ID has this form:

```text
{origin-main-session-id}-{team-name}
```

The manifest stores the team ID, display name, canonical project directory, prompts, transport settings, member session identities, and each member's team-management capability. It also stores lifecycle timestamps and whether each session file has ever materialized.

Version-2 manifests store the current teammate fields directly: `systemPrompt`, `inheritMainContext`, `canManageOwnTeams`, and `teammateId`. The new directory separates the current format from old manifests. There are no old-name aliases or storage adapters. Pi session files remain untouched. A `teammateId` is the Pi session ID.

`team_list` reads only manifests whose canonical project directory matches the current project. Symlinked paths resolve to the same project.

Pi session JSONL files are the canonical conversation history for main and teammates. The registry stores no messages or tool results.

The in-memory `team_log` records events only for the current parent runtime. The extension persists no separate parent-runtime log or durable `team_log`.

## A lease prevents two parent runtimes from owning one team

An active team has an atomic lease beside its manifest. The lease identifies the main session, process, and random ownership token.

A second parent runtime cannot claim a live lease. This keeps the extension from starting two runtimes for the same teammate sessions.

A dead lease owner makes the lease stale. The next claim replaces the stale lease and marks an abandoned active manifest dormant.

The lease protects extension-managed runtimes. Users must still avoid opening a live teammate session through another Pi process.

## Team lifecycle operations change attachments and runtimes

### `team_spawn` creates sessions and a live attachment

`team_spawn` validates the roster and model patterns, claims the team lease, then starts each teammate.

RPC is the default transport. Each teammate can request `showOnHerdrPane`. An explicitly supplied team-wide `showOnHerdrPanes` value overrides individual choices; omission preserves them.

RPC teammates start with `pi --mode rpc`. Children disable discovered extensions and load only the explicit `pi-simple-team` extension path.

A normal child registers only parent-team member tools. A child with `canManageOwnTeams: true` also registers manager tools in the same runtime.

Every child runs the same runtime regardless of transport: it starts a local delivery server, then registers that server and its session identity through the parent callback. Startup completes only after registration.

The parent records every teammate session ID and absolute session file path before it writes the active manifest. After every teammate registers, the parent publishes kickoff messages through their delivery queues. `startIdle: true` suppresses kickoff. A partial kickoff failure reports which teammates started and keeps the team available for inspection.

The spawn result returns `teamName`, `teamId`, `started`, the complete roster with full teammate records, and post-call instructions. Spawn, list, and resume share those records. Each includes resolved configuration, `name`, `teammateId`, `sessionFile`, `live`, and `active`.

`live` identifies a running runtime. `active` identifies running or queued work. Runtime events and pending delivery counts determine activity independently of teammate-written status prose. `started` is true when any teammate has active work. Idle or no-op lifecycle calls therefore still report existing active work. Lifecycle results and instructions describe the resulting team.

Kickoff restates the recipient's identity and individual assignment. This prevents an inheriting teammate from continuing main's coordination workflow. Cancellation during startup stops prepared members before automatic kickoff. Concurrent creators await the same parent callback-server readiness promise.

### `team_add_teammates` grows only a running owned team

`team_add_teammates` requires an active team lease owned by the current main session. The team selector can be omitted when exactly one owned active team exists. New teammates can use RPC or individual Herdr panes.

The operation does not attach an existing Pi session. Existing teammates continue their work. New teammates start as one ready batch unless `startIdle` is true. The result includes the complete roster as lightweight name/ID/live/active records and the whole team's statuses.

Before every teammate turn, the child asks the parent for the current roster. The system prompt therefore reflects additions without starting another turn for existing members.

### `team_shutdown` makes the team dormant

`team_shutdown` waits for every RPC process to exit and closes every Herdr pane. It then marks the manifest dormant and releases the lease.

Shutdown preserves each Pi session and its team attachment. The parent also follows this path when its Pi session shuts down.

A dormant manifest expires 30 days after shutdown. The next registry access removes the expired manifest and lease only.

Expiration never removes or changes a Pi session JSONL file.

### `team_resume` starts all or selected stopped members

`team_resume` discovers the team through the current project registry. It resumes all stopped members unless the caller selects teammates by name or Pi session ID.

Resume uses RPC by default. The caller must explicitly request Herdr panes.

A persisted member starts with `pi --session <stored-session-file>`. The extension does not pass the original model or thinking level because Pi restores current session state.

Selective resume creates a valid partially running team. A later resume can start the remaining stopped members.

Resumed teammates start work by default. `resumptionPrompt` supplies one conversation message, leaving common and individual system prompts unchanged. With `startIdle: true`, the runtime records it through `pi.sendMessage` with `triggerTurn: false`. A later ordinary message starts work using that context. Already-running members receive neither the resumption message nor another kickoff.

Resume returns full records for every teammate, including already-live and still-stopped teammates, plus whole-team status. Only actually resumed teammates have `contextRestored`. `alreadyActiveTeammates` identifies pre-existing live teammates that have work at return time, including when `startIdle` is true.

## Session materialization controls resume behavior

Pi assigns an idle child a session ID and session file path before it creates the JSONL file. Pi creates that file only after the first assistant response.

If the file exists, resume uses it. If the file once materialized but is now missing, resume fails instead of replacing conversation history.

If the teammate never produced an assistant response, its provisional file does not exist. Resume starts a new empty session and replaces the provisional identity.

## Recursive management stays session-scoped

An managing teammate has two roles in one Pi session. It remains a member of its parent team and acts as main for teams it creates.

```text
main session ownership
├─ Team A
│  └─ A1, an managing teammate
├─ Team B
└─ Team C

A1 session ownership
├─ Team A1.1
├─ Team A1.2
└─ Team A1.3
```

The existing private owner symbol confines all live operations to teams created through that extension runtime. This covers sends, statuses, context reports, logs, additions, and shutdowns.

Durable discovery needs an extra boundary because the registry is project-wide. In an managing teammate, `team_list` and `team_resume` filter manifests by `originMainSessionId` equal to that teammate's Pi session ID. The teammate therefore cannot discover or resume its parent team, sibling teams, or teams owned by unrelated sessions.

`team_send_message` resolves targets across the parent team and owned teams, then routes each selection through its corresponding runtime. Parent-team metadata comes from the existing `team_context` callback. `team_status` uses the parent callback when `team` is omitted and an owned team when `team` is set. `get_context_window_usage` reports the managing teammate when `targets` is omitted and inspects owned teammates when targets are set.

The capability is part of the durable member attachment and returns on resume.

When a parent stops an overseeing RPC teammate, it waits for that process to exit without a force-kill deadline. Process exit confirms that the teammate's `session_shutdown` handler stopped descendant teams and released their leases.

## Runtime communication remains parent coordinated

The parent extension runtime owns live team state, status maps, delivery queues, and the process-local event log.

All parent-child IPC is authenticated localhost HTTP. Child tools and lifecycle events call the parent callback server. The parent sends messages and context-window queries to each child's registered delivery server.

The transport decides only how a child process starts and stops: `pi --mode rpc` plus SIGTERM, or a Herdr pane plus pane close. Herdr startup uses `pane split`, then `pane rename` and `pane run` with a safely quoted Pi command. The pane is tracked before launch so startup failures can close it. Message delivery, events, and queries are identical across transports.

Teammate messages are pushed into recipient sessions. An ordinary message starts an idle teammate's turn. The child handles interrupt deliveries itself: it aborts its active turn, waits to settle, then takes the message. `interrupt` can select all recipients or a subset using the same names and IDs as `targets`.

Message tools return `published: true`, whole-team status, and post-call instructions. `team_send_message` groups status under each selected team's name and ID. `send_main_message` identifies the one parent team directly. Publication does not promise completed delivery. A later failure is pushed to the original sender. If that notification also fails, it is logged without recursively generating another notification.

Kickoff, resumption instructions, and ordinary messages share the publication log and per-recipient queues. This preserves complete messages and prevents peer messages from overtaking a queued kickoff.

## Team and teammate selection follows one rule

`team-selection.ts` resolves names and IDs for messaging, context usage, logs, resume subsets, and interruption subsets. An ambiguous name reports usable IDs. Callers replace the name in the same field. Selection never grants access to another runtime's teams.

Messages, context usage, and logs share `targets`. A team selects its teammates. A teammate selects itself. Lists can cross permitted teams, and overlaps count once. Messaging validates the whole target list and interrupt subset before publishing anything.

`team_log` applies one global row limit across selected teams. Its opaque cursor contains the timestamp, team ID, and local sequence. This preserves pagination when different teams have the same sequence numbers. The result groups tables by team name and ID.

## The `/team` dashboard reads owner-bound live snapshots

`index.ts` registers `/team` only in the parent runtime. Its handler passes `openTeamOverview()` a source bound to that extension runtime's private owner symbol.

`ownedTeamSnapshots(owner)` is the view and data boundary. It filters the module-level team map by owner, then copies each owned team's metadata, roster, statuses, and log into a `TeamSnapshot`. This ownership check prevents one Pi session's dashboard from exposing another session's teams.

The snapshot derives transports from live members, so the header can show `RPC + Herdr` for a mixed team.

`team-ui.ts` owns the read-only presentation layer. It defines `TeamSnapshot`, accepts only a `TeamSnapshotSource`, and never imports or changes `TeamState`. The view cannot send messages, change statuses, or reach teammate processes.

The overlay calls its snapshot source on every render. A 500 ms timer requests a new render while the overlay is open. Live data therefore comes from fresh parent-owned snapshots instead of view-side state. Closing the overlay clears that timer.

With no snapshots, the command renders an empty state. One snapshot opens directly. Multiple snapshots render a selector before the dashboard.

The 90% overlay has one outer frame and fixed bordered regions for metadata, status, messages, and the non-message log. Region heights depend on the terminal height, not incoming data, so updates cannot move the boundaries. The view has no scrolling path.

The message and log widgets are zoomable. Up and Down move a focus marker between them, Enter expands the focused widget to the full overlay under the metadata header, and Esc returns to the dashboard. From the dashboard, Esc closes the overlay. A zoomed view keeps the user oriented three ways: the header title becomes a breadcrumb (`Team: <name> ❯ Messages`), the expanded widget keeps its focused styling, and the hint reads `Esc back to team view`. The dashboard resolves these keys through the `tui.select.*` keybindings, the same ids the team selector uses, so user rebinds apply everywhere. The overlay keeps two intent fields for this: the focused widget and the zoomed widget. Every render still derives the visible screen from those fields plus a fresh snapshot, so a vanished team drops both the selection and the zoom.

The status region shows at most the five most recently updated participants. It aligns the name, status word, and phrase columns, then right-aligns timestamps.

The message region turns `send` and `main_message` entries into message views. It chooses the newest message groups that fit and keeps those groups in chronological order. If one message exceeds its region, the view retains its outer lines around an omission marker.

The log region excludes messages and their delivery entries: `send`, `deliver`, `ack`, and `main_message`. This separation prevents message activity from duplicating the message view. The region folds all retained non-message entries, then shows the newest rows that fit in chronological order. The log's own 1000-entry retention is the only cap.

Every region uses middle truncation for horizontal overflow. This preserves both ends of names, status phrases, messages, and event rows without changing the fixed layout.

The dashboard shows only live teams owned by the current parent runtime. Dormant attachments become visible after `team_resume` restores them into that runtime.

## Relevant implementation entrypoints

- `index.ts`: team lifecycle tools, live state, owner-scoped dashboard snapshots, transport startup, and message delivery
- `team-ui.ts`: `/team` selection, live refresh, and bounded dashboard rendering
- `team-registry.ts`: manifests, project discovery, expiry, and leases
- `child-tools.ts`: child callbacks, current-roster injection, and teammate tools
- `system-prompt.ts`: teammate attachment instructions
- `model-preflight.ts`: model-pattern availability checks
- `team-selection.ts`: shared name/ID resolution and selection
- `teammate.ts`: shared teammate configuration and result records

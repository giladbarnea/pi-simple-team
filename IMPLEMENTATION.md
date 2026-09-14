---
updated: 2026-09-14
status: working
---

# pi-simple-team implementation notes

`pi-simple-team` treats each teammate as a normal Pi session with a durable team attachment. A child RPC process or Herdr pane supplies its temporary live runtime.

The social model stays flat inside each team. Normal teammates get communication, status, and context-window tools. Main gets team lifecycle, communication, status, log, and context-window tools.

A teammate with `canManageOwnTeams: true` keeps its parent-team tools and also gets the main tool set. It acts as main only for teams created by its own Pi session.

There is no inbox, polling loop, explicit done primitive, or message broker. The only extra IPC is authenticated localhost HTTP: one parent callback server, plus one delivery server per child.

The implementation uses child CLI processes rather than Pi SDK sessions. Children stay alive while idle. Ordinary delivery uses `pi.sendMessage` with `deliverAs: "steer"` and `triggerTurn: true`. Idle resumption instructions use `triggerTurn: false` to record context without starting work. Interrupt delivery aborts the active turn before the message lands.

Spawn, resume, and add start the affected batch after all members register and the manifest is saved. `kickoffTeammates` shares the ordinary publication queue and waits for all delivery outcomes. It reports partial starts without tearing down work that already started. `startIdle` suppresses execution for all three lifecycle tools.

`teammateId` is the Pi session ID. Every input identifying an existing teammate accepts its name or ID in the same field. Messages, context usage, and logs use one `targets` list that also accepts whole teams. The shared resolver handles ambiguity and overlapping selections.

Lifecycle results return complete rosters. Spawn, list, and resume share full teammate records. Add returns lightweight name/ID/live/active records. `live` identifies a running runtime, while `active` identifies running or queued work. Runtime events and delivery counts determine activity. `started` reflects the whole team's activity, including pre-existing work during idle or no-op resume.

Message results acknowledge publication and push later failures to the original sender. Descriptions explain invocation; lifecycle and message results carry post-call instructions.

## Durable team attachments

A team ID is `{origin-main-session-id}-{team-name}`. Version-2 manifests store current teammate fields under `pi-simple-team/teams-v2` in the Pi agent directory. The extension does not read old manifests or translate old field names. Pi session files remain unchanged.

Each active team holds an atomic lease. This lease enforces one extension-managed live runtime per teammate session.

Every child reports its session identity when it registers its delivery server. Spawn, add, and resume complete only after that registration.

Pi can report a session file before creating it. The file appears after the first assistant response.

Resume uses an existing session file without overriding its stored model state. A missing materialized file fails, while a never-materialized session restarts empty.

`team_shutdown` stops runtimes, releases the lease, and leaves a dormant manifest. Registry access removes dormant manifests 30 days after shutdown.

Manifest expiry never deletes Pi session files. Pi session JSONL files remain the canonical conversation history.

The process-local `team_log` is not durable. The extension persists no separate parent-runtime log.

`team_add_teammates` creates new sessions for a running team owned by the current main session. Individual teammates can request Herdr panes. It does not attach existing Pi sessions.

Herdr creates a pane through `pane split`, labels it, then starts the exact parent Pi executable through `pane run`. Command arguments are shell-quoted independently. This matches Herdr's current separation between pane creation and agent startup.

Child Pi processes use `--no-extensions` and explicitly load `pi-simple-team`. This prevents unrelated discovered extensions from conflicting with the team runtime.

A normal child stops registration after the parent-team tools. An managing child continues through manager registration in the same extension runtime.

Teammate sessions remain in Pi's normal session storage for their project directory. The extension stores their reported IDs and absolute file paths without moving them.

Teammate model names should use explicit provider/model IDs. Fuzzy model strings can resolve differently in child processes than intended.

## Recursive team ownership

Live management uses the extension runtime's private owner symbol. An managing teammate therefore cannot send to, inspect, add to, log, or stop teams owned by its parent or a sibling runtime.

The manifest registry is project-wide, so durable discovery adds a second boundary. In an managing runtime, `team_list` and `team_resume` accept only manifests whose `originMainSessionId` matches the managing teammate's Pi session ID.

`team_send_message` resolves names and IDs across parent-team peers and owned teams, then routes each selection through its runtime. `team_status` uses the parent callback when `team` is omitted and an owned team when `team` is set. `get_context_window_usage` reports the managing session when `targets` is omitted and owned teammates when targets are present.

The capability travels through the child environment and persists on `TeamManifestMember`.

RPC shutdown does not force-kill an managing teammate. The parent waits for process exit, which occurs after the managing session stops descendant teams, marks their manifests dormant, and releases their leases.

## Rendering

Tool-specific TUI logic lives in `render.ts`; reusable display primitives live in `render-support/`. `index.ts` only wires `renderShell: "self"` + `renderCall`/`renderResult` per tool and one `registerMessageRenderer`. The team tools share one visual grammar:

- **Header stat-line**: `● <Label> <target> · stat · stat` — bullet, bold label, accent target, dim-dot-separated semantically colored stats. Errors render as `● <call> · <error>` with the error in red.
- **Tree body**: `├─`/`└─` rows with padded columns — teammate names accent, status words colored via `statusWordToken` (working→success, waiting→warning, free-form activity words→accent), timestamps dim. `team_log` rows add a per-kind glyph (`✓`/`✗`/`→`/`◆`/`▲`/`○`) and rebuild tool_start/tool_end summaries from entry details instead of the LLM-facing prose.
- **Timestamps**: one grammar per column. Status `updated`, list `updated`/`expires`, message `sentAt`, and dashboard `Created` render as elapsed relative time through `relativeTime`/`futureTime` in `teamlog.ts`. Storage is ISO and `relativeTimeText` converts at render time. `team_log` rows use absolute `HH:MM:SS`, with day dividers.
- **Speech = quote bar**: any message payload renders behind a `▌` bar — muted for outgoing `team_send_message` previews (3 lines collapsed), accent for incoming teammate→main messages.
- **Compression**: collapsed views clip each row at the render width; ctrl+o (expanded) switches to wrapping, and prefixed lines re-apply their quote bar to wrapped continuations (`TeamLine`).

Teammate→main messages no longer go through `pi.sendUserMessage` (which disguised them as user-typed messages). They are `pi.sendMessage` custom messages (`customType: "pi-simple-team"`, `deliverAs: "steer"` + `triggerTurn: true` preserves the old busy/idle delivery semantics) rendered as a `◆ from → main · team · time` header over the quoted body. The LLM-facing content string is unchanged.

Renderers only shape the TUI. Most tools return JSON text to the LLM; `team_log` returns a formatted text page with structured details. `test/render.test.ts` covers the builders.

Resume renders the complete roster, including pre-existing active work and still-stopped teammates. Logs group selected teams by name and ID. One global limit and a timestamp/team-ID/sequence cursor keep cross-team pages complete.

Useful Pi docs consulted:

- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/structured-output.ts`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/send-user-message.ts`

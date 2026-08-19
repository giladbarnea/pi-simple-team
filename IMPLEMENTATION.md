---
updated: 2026-08-19
status: working
---

# pi-simple-team implementation notes

`pi-simple-team` treats each teammate as a normal Pi session with a durable team attachment. A child RPC process or Herdr pane supplies its temporary live runtime.

The social model stays flat inside each team. Normal teammates get communication, status, and context-window tools. Main gets team lifecycle, communication, status, log, and context-window tools.

A teammate with `canOverseeOwnTeams: true` keeps its parent-team tools and also gets the main tool set. It acts as main only for teams created by its own Pi session.

There is no inbox, polling loop, explicit done primitive, or message broker. The only extra IPC is authenticated localhost HTTP: one parent callback server, plus one delivery server per child.

The implementation uses child CLI processes rather than Pi SDK sessions. Children stay alive while idle. A delivered message becomes an in-session `pi.sendMessage` (`deliverAs: "steer"`, `triggerTurn: true`), so Pi itself resolves busy/idle delivery. An interrupt delivery aborts the child's active turn in-process before the message lands.

## Durable team attachments

A team ID is `{origin-main-session-id}-{team-name}`. The registry stores same-project attachments under the Pi agent directory.

Each active team holds an atomic lease. This lease enforces one extension-managed live runtime per teammate session.

Every child reports its session identity when it registers its delivery server. Spawn, add, and resume complete only after that registration.

Pi can report a session file before creating it. The file appears after the first assistant response.

Resume uses an existing session file without overriding its stored model state. A missing materialized file fails, while a never-materialized session restarts empty.

`team_shutdown` stops runtimes, releases the lease, and leaves a dormant manifest. Registry access removes dormant manifests 30 days after shutdown.

Manifest expiry never deletes Pi session files. Pi session JSONL files remain the canonical conversation history.

The process-local `teamlog` is not durable. The extension persists no separate parent-runtime log.

`team_add` creates new RPC sessions only for a running team owned by the current main session. It does not attach existing Pi sessions.

Child Pi processes use `--no-extensions` and explicitly load `pi-simple-team`. This prevents unrelated discovered extensions from conflicting with the team runtime.

A normal child stops registration after the parent-team tools. An overseeing child continues through manager registration in the same extension runtime.

Teammate sessions remain in Pi's normal session storage for their project directory. The extension stores their reported IDs and absolute file paths without moving them.

Teammate model names should use explicit provider/model IDs. Fuzzy model strings can resolve differently in child processes than intended.

## Recursive team ownership

Live management uses the extension runtime's private owner symbol. An overseeing teammate therefore cannot send to, inspect, add to, log, or stop teams owned by its parent or a sibling runtime.

The manifest registry is project-wide, so durable discovery adds a second boundary. In an overseeing runtime, `team_list` and `team_resume` accept only manifests whose `originMainSessionId` matches the overseeing teammate's Pi session ID.

The three overlapping tools keep both roles available. `teamsend` and `teamstatus` use the parent callback when `team` is omitted and an owned team when `team` is set. `report_context_window` reports the overseeing session when `targets` is omitted and owned teammates when targets are present.

The capability travels through the child environment and persists on `TeamManifestMember`. Old manifests default it to `false`.

RPC shutdown does not force-kill an overseeing teammate. The parent waits for process exit, which occurs after the overseeing session stops descendant teams, marks their manifests dormant, and releases their leases.

## Rendering

Tool-specific TUI logic lives in `render.ts`; reusable display primitives live in `render-support/`. `index.ts` only wires `renderShell: "self"` + `renderCall`/`renderResult` per tool and one `registerMessageRenderer`. The team tools share one visual grammar:

- **Header stat-line**: `● <Label> <target> · stat · stat` — bullet, bold label, accent target, dim-dot-separated semantically colored stats. Errors render as `● <call> · <error>` with the error in red.
- **Tree body**: `├─`/`└─` rows with padded columns — teammate names accent, status words colored via `statusWordToken` (working→success, waiting→warning, free-form activity words→accent), timestamps dim. `teamlog` rows add a per-kind glyph (`✓`/`✗`/`→`/`◆`/`▲`/`○`) and rebuild tool_start/tool_end summaries from entry details instead of the LLM-facing prose.
- **Timestamps**: one grammar per column. Status `updated`, list `updated`/`expires`, message `sentAt`, and dashboard `Created` render as elapsed relative time (`just now`, `12m ago`, `1h 04m ago`, `4h ago`, `1d 9h ago`, `5d ago`, `3w ago`, `2mo ago`; future: `in 3w`) via `relativeTime`/`futureTime` in `teamlog.ts`. Storage is ISO; `relativeTimeText` converts at render time and passes pre-ISO legacy strings through raw. `teamlog` rows are the exception: absolute `HH:MM:SS`, no tree connectors, with a dim `── <Month DD> ──` divider row whenever a row's local day differs from the previous row's (or from today, for the first row).
- **Speech = quote bar**: any message payload renders behind a `▌` bar — muted for outgoing `teamsend` previews (3 lines collapsed), accent for incoming teammate→main messages.
- **Compression**: collapsed views clip each row at the render width; ctrl+o (expanded) switches to wrapping, and prefixed lines re-apply their quote bar to wrapped continuations (`TeamLine`).

Teammate→main messages no longer go through `pi.sendUserMessage` (which disguised them as user-typed messages). They are `pi.sendMessage` custom messages (`customType: "pi-simple-team"`, `deliverAs: "steer"` + `triggerTurn: true` preserves the old busy/idle delivery semantics) rendered as a `◆ from → main · team · time` header over the quoted body. The LLM-facing content string is unchanged.

Renderers only shape the TUI. Most tools return JSON text to the LLM; `teamlog` returns a formatted text page with structured details. `test/render.test.ts` covers the builders.

Useful Pi docs consulted:

- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/structured-output.ts`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/send-user-message.ts`

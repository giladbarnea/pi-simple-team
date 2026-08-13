---
updated: 2026-08-13
status: working
---

# pi-simple-team implementation notes

`pi-simple-team` treats each teammate as a normal Pi session with a durable team attachment. A child RPC process or Herdr pane supplies its temporary live runtime.

The social model stays flat. Teammates get communication, status, and context-window tools. Main gets team lifecycle, communication, status, log, and context-window tools.

There is no inbox, polling loop, explicit done primitive, or message broker. The only extra IPC is an authenticated localhost callback server.

The implementation uses child CLI processes rather than Pi SDK sessions. RPC children stay alive while idle and accept pushed prompts, steering, interrupts, and state queries.

## Durable team attachments

A team ID is `{origin-main-session-id}-{team-name}`. The registry stores same-project attachments under the Pi agent directory.

Each active team holds an atomic lease. This lease enforces one extension-managed live runtime per teammate session.

`team_spawn` and `team_add` query each RPC child with `get_state`. Visible children report their session identity when they register their callback.

Pi can report a session file before creating it. The file appears after the first assistant response.

Resume uses an existing session file without overriding its stored model state. A missing materialized file fails, while a never-materialized session restarts empty.

`team_shutdown` stops runtimes, releases the lease, and leaves a dormant manifest. Registry access removes dormant manifests 30 days after shutdown.

Manifest expiry never deletes Pi session files. Pi session JSONL files remain the canonical conversation history.

The process-local `teamlog` is not durable. The extension persists no separate parent-runtime log.

`team_add` creates new RPC sessions only for a running team owned by the current main session. It does not attach existing Pi sessions.

Child Pi processes use `--no-extensions` and explicitly load the child side of `pi-simple-team`. This prevents unrelated discovered extensions from conflicting or recursively exposing parent tools.

Teammate sessions remain in Pi's normal session storage for their project directory. The extension stores their reported IDs and absolute file paths without moving them.

Teammate model names should use explicit provider/model IDs. Fuzzy model strings can resolve differently in child processes than intended.

## Rendering

Tool-specific TUI logic lives in `render.ts`; reusable display primitives live in `render-support/`. `index.ts` only wires `renderShell: "self"` + `renderCall`/`renderResult` per tool and one `registerMessageRenderer`. The team tools share one visual grammar:

- **Header stat-line**: `● <Label> <target> · stat · stat` — bullet, bold label, accent target, dim-dot-separated semantically colored stats. Errors render as `● <call> · <error>` with the error in red.
- **Tree body**: `├─`/`└─` rows with padded columns — teammate names accent, status words colored via `statusWordToken` (working→success, waiting→warning, free-form activity words→accent), timestamps dim. `teamlog` rows add a per-kind glyph (`✓`/`✗`/`→`/`◆`/`▲`/`○`) and rebuild tool_start/tool_end summaries from entry details instead of the LLM-facing prose.
- **Speech = quote bar**: any message payload renders behind a `▌` bar — muted for outgoing `teamsend` previews (3 lines collapsed), accent for incoming teammate→main messages.
- **Compression**: collapsed views clip each row at the render width; ctrl+o (expanded) switches to wrapping, and prefixed lines re-apply their quote bar to wrapped continuations (`TeamLine`).

Teammate→main messages no longer go through `pi.sendUserMessage` (which disguised them as user-typed messages). They are `pi.sendMessage` custom messages (`customType: "pi-simple-team"`, `deliverAs: "steer"` + `triggerTurn: true` preserves the old busy/idle delivery semantics) rendered as a `◆ from → main · team · time` header over the quoted body. The LLM-facing content string is unchanged.

Renderers only shape the TUI. Most tools return JSON text to the LLM; `teamlog` returns a formatted text page with structured details. `test/render.test.ts` covers the builders.

Useful Pi docs consulted:

- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/structured-output.ts`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/send-user-message.ts`

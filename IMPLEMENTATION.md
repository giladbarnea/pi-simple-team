---
updated: 2026-08-04
status: working
---

# pi-simple-team implementation notes

`pi-simple-team` was built as the smallest viable team runtime: the main Pi session owns a parent orchestrator, and each teammate is a persistent child `pi --mode rpc` process with its own fresh context window.

The key design choice was to keep the social model flat. Teammates get only `teamsend`, `teammain`, and `teamstatus`; the main session gets `team_spawn`, `teamsend`, `teamstatus`, `teamlog`, and `team_shutdown`. There is no inbox, no polling loop, no explicit done primitive, and no message broker.

The only extra IPC is a localhost HTTP callback server with a random token. Child tools call it so `teamstatus` can synchronously return the parent-owned status map, while `teamsend` and `teammain` remain fire-and-forget.

The implementation deliberately uses child CLI/RPC processes rather than Pi SDK sessions. Before implementation, small proofs verified that RPC children stay alive while idle, preserve context, can be interrupted during model-driven tool work, can load custom tools, and can call back into the parent runtime.

The biggest practical finding was that teammate model names should be explicit provider/model ids. Fuzzy model strings can resolve differently in child processes than intended.

Current persistence behavior uses Pi's default session storage for teammate child processes. The extension does not set a custom session directory or session name, so teammate sessions land wherever normal Pi sessions for that working directory land and can be named by the user's existing auto-session naming extension.

Child processes now load normal extension discovery. `pi-simple-team` marks them with `PI_SIMPLE_TEAM_CHILD=1`, so the same extension registers only the child callback tools (`teamsend`, `teammain`, `teamstatus`) inside teammate processes instead of recursively exposing the parent orchestration tools.

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

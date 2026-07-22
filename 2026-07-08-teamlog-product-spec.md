---
updated: 2026-07-08
status: implemented
scope: pi-simple-team supervisor event log
implemented_in: 63cb674
---

# pi-simple-team teamlog product spec

## Implementation status

This spec has been implemented in `agent/extensions/pi-simple-team`.

Implemented files:

- `index.ts` registers the main-only `teamlog` tool and records parent-observed team events.
- `teamlog.ts` contains the pure log helpers, pagination/filtering/search, rendering, truncation, and child RPC event normalization.
- `test/teamlog.test.ts` covers the MVP behavior alongside the existing pi-simple-team tests.

Verified after reload with a smoke `teamlog` call against a one-member team: the tool returned a compact timestamped `spawn` event. Full validation before commit: `bun test extensions/pi-simple-team/test/` passed with 58 tests, and `bun build extensions/pi-simple-team/index.ts --target=node` built cleanly.

## Product goal

`teamlog` gives the supervising agent just enough proof to understand what happened inside a team without dumping the team’s whole transcript into the supervising context window.

This is a supervisory triage tool, not a replay console. A naïve call must be safe: bounded, compact, timestamped to the second, and easy to scan. Deeper inspection must be deliberate through paging, filtering, and search.

Success criterion: when a teammate claims “I wrote the file,” “I sent Reviewer the handoff,” “I hit an error,” or “I am waiting,” the lead can quickly verify the relevant event trail without asking the teammate to restate it and without pulling hundreds of raw event objects into context.

## Design principles

1. **Peek-safe by default.** The default call should never produce a wall of text.
2. **Proof, not transcript.** Show lifecycle events, routing events, tool calls, status changes, and explicit messages. Do not stream assistant text deltas.
3. **Narrow before deep.** Filtering and search should happen before paging and rendering.
4. **Chronological within a page.** The page should read naturally from older to newer events, even when it represents the latest slice.
5. **Stable cursors over pretty timestamps.** Use sequence numbers for paging; timestamps are for humans.
6. **One screen first.** The top-level rendered content should be compact enough for a lead agent to inspect without contaminating its context window.

## Non-goals

1. No always-on transcript dump.
2. No LLM summarization in this pass.
3. No authoritative/async status rewriter.
4. No persistence across Pi reloads or process restarts.
5. No hidden model chain-of-thought exposure.
6. No unbounded “give me everything” mode.

## Tool surface

Add one main-session-only tool:

`teamlog`

Description: “Inspect a compact, paged, filterable event log for a pi-simple-team team.”

Suggested parameters:

```ts
{
  team?: string;
  teammate?: string;
  kind?: string;
  search?: string;
  since?: string;
  limit?: number;
  cursor?: string;
}
```

Semantics:

- `team`: optional only when exactly one team exists, matching existing `teamstatus` ergonomics.
- `teammate`: filters to one teammate name.
- `kind`: filters to one normalized event kind.
- `search`: case-insensitive substring search over `summary`, teammate name, direction, kind, and compact details.
- `since`: optional timestamp filter. Accept ISO timestamps or the existing display timestamp if implementation keeps only display strings. This is secondary; paging should use sequence cursors.
- `limit`: default 20, maximum 100. Values below 1 should fail clearly or clamp to 1; prefer fail clearly if simpler.
- `cursor`: opaque-ish cursor from a previous response. Minimal format may be `before:<sequence>`.

Default behavior:

```ts
teamlog({ team?: "..." })
```

Return the latest matching page, rendered in chronological order, with at most 20 rows.

## Event model

Keep a parent-owned, in-memory log on `TeamState`:

```ts
interface TeamLogEntry {
  sequence: number;
  timestamp: string; // to the second, same style as nowText()
  epochMilliseconds: number;
  team: string;
  teammate?: string;
  direction?: "main->teammate" | "teammate->main" | "teammate->teammate" | "runtime";
  kind: TeamLogKind;
  summary: string;
  details?: Record<string, unknown>;
}
```

Add to `TeamState`:

```ts
log: TeamLogEntry[];
nextLogSequence: number;
```

Cap retained entries per team. Use 1000 as the MVP cap. Drop oldest entries when the cap is exceeded.

Recommended `TeamLogKind` values:

- `spawn`
- `send`
- `deliver`
- `ack`
- `status`
- `agent_start`
- `agent_end`
- `tool_start`
- `tool_end`
- `main_message`
- `stderr`
- `exit`
- `error`

## What to record

Record only events the parent runtime already observes.

Useful sources in `index.ts`:

- `team_spawn`: initialize `log` and `nextLogSequence`.
- `startTeammate`: log `spawn`; stderr chunks as `stderr`; process exit as `exit`.
- `enqueueDelivery`: log `send`.
- `deliverToTeammate`: log `deliver`; failed delivery as `error`.
- `promptTeammate` / `steerTeammate`: log accepted child prompt/steer as `ack`; rejected response as `error`.
- `handleTeammateEvent`: normalize child RPC events already flowing through `recentEvents`:
  - `agent_start` → `agent_start`
  - `agent_end` → `agent_end`
  - `tool_execution_start` → `tool_start`
  - `tool_execution_end` → `tool_end`
  - optionally `extension_error` / retry events → `error`
- `handleCallbackRequest`:
  - child `teamsend` callback → `send`
  - child `teammain` callback → `main_message`
  - child `teamstatus` callback → `status`
- main `teamstatus` tool → `status`
- `team_shutdown` need not emit final log because the team is deleted immediately.

Do not log `message_update` deltas in MVP. They are too noisy.

## Summary and truncation rules

Every row must have a one-line `summary`. Summaries should be useful but short.

Guidelines:

- Message previews: first 160 characters after whitespace normalization.
- Tool args preview: first 160 characters of compact JSON.
- Tool result/error preview: first 160 characters of compact JSON/text.
- stderr preview: first 160 characters.
- Show original character count when truncating, e.g. `(truncated, 842 chars)`.

A helper like `preview(value: unknown, max = 160): string` is enough.

Never include full tool outputs or full assistant text in rendered content. Structured `details` may include compact fields, but should not carry huge raw blobs.

## Rendering

Return both text content and structured details.

Rendered text should look like this:

```text
Team pi-simple-team-teamlog-spec — latest 20 of 73 matching events
seq  time       teammate  kind         dir                 summary
054  20:51:44   SpecA     main_message teammate->main     reported spec path: /Users/...
055  20:51:47   main      error        runtime            verified reported path missing
056  20:52:33   SpecB     status       runtime            syncing — no spec exists yet
Showing 20 of 73 matching events. nextCursor="before:54"
```

Use date + time if compact enough; time-only is acceptable if the structured details carry full timestamp. Since the user explicitly asked timestamped to the second, every entry in details must include the full second-level timestamp.

Text rows should be bounded and aligned enough to scan. Do not over-invest in fancy table formatting.

Structured details:

```ts
{
  team: string;
  entries: TeamLogEntry[];
  totalMatched: number;
  returned: number;
  nextCursor?: string;
  filters: {
    teammate?: string;
    kind?: string;
    search?: string;
    since?: string;
    limit: number;
    cursor?: string;
  };
}
```

## Paging

Filtering order:

1. resolve team
2. apply `teammate`, `kind`, `search`, `since`
3. apply cursor/page selection
4. take `limit`
5. render chronological order

Default page is the latest `limit` entries after filters. If older matching entries exist, return `nextCursor: "before:<oldest-sequence-in-page>"`.

A follow-up call with that cursor returns the previous older page.

No need for forward pagination in MVP.

## Search

Search should be simple substring matching, case-insensitive. Search across:

- `summary`
- `teammate`
- `direction`
- `kind`
- compact stringified `details`

No regex in MVP.

## Failure behavior

- Unknown team: match existing `resolveTeam` behavior.
- Unknown teammate filter: return zero rows rather than error. This keeps search/filter exploratory.
- Unknown kind: return zero rows rather than error.
- Invalid cursor: fail clearly.
- Invalid `limit`: fail clearly or clamp; pick one behavior and test it.

## MVP acceptance criteria — completed

1. [x] Main has a `teamlog` tool; children do not.
2. [x] Default `teamlog` returns at most 20 compact rows.
3. [x] `limit` is bounded to max 100.
4. [x] Rows identify sequence, second-level timestamp/time, teammate, kind, direction, and summary.
5. [x] Details include full `TeamLogEntry` objects with `timestamp` and `epochMilliseconds`.
6. [x] Filters work for teammate, kind, search, and since.
7. [x] Cursor pagination works backward through older matching events.
8. [x] Logs include spawn, send/deliver/ack, status, main_message, child agent lifecycle, child tool lifecycle, stderr, exit, and error where parent runtime observes them.
9. [x] Rendered output truncates long previews.
10. [x] Tests cover bounded default, max limit, filtering, search, pagination, truncation, and child-main/tool lifecycle event normalization.

## Implementation posture

Keep this as a small observability layer. Do not introduce a broker or persistence. A few pure helpers are the right shape:

- `appendTeamLog(team, partialEntry)`
- `preview(value, maxLength)`
- `filterTeamLog(entries, params)`
- `pageTeamLog(entries, params)`
- `renderTeamLogPage(page)`

Prefer testing these pure helpers directly, then lightly wire them into `index.ts`.

## References

- `agent/extensions/pi-simple-team/index.ts`
- `agent/extensions/pi-simple-team/child-tools.ts`
- `agent/extensions/pi-simple-team/system-prompt.ts`
- `agent/extensions/pi-simple-team/model-preflight.ts`
- `agent/extensions/pi-simple-team/IMPLEMENTATION.md`
- `agent/extensions/pi-simple-team/26-07-08-usage-report.md`
- `agent/extensions/pi-simple-team/2026-07-08-scout-plan.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`

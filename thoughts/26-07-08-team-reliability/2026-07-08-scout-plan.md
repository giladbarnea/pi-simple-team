---
updated: 2026-07-08
status: agreed (ScoutA + ScoutB)
source: 26-07-06-usage-review.md
---

# pi-simple-team scout-and-plan: agreed fixes

Scope is the three issues the usage review marked "should fix." Issue 4 (status not authoritative) is explicitly postponed by the review itself — the real fix needs an async watcher reading each teammate's transcript, which is a much bigger change. Issue 5 (no transcript inspection) is marked not high priority and trades off against context hygiene. Neither is addressed here.

## 1. Spawn accepted an unusable model (review issue 1)

**Problem:** `team_spawn` starts a child `pi --mode rpc` process for each teammate without checking whether the requested model actually resolves to a configured/authenticated provider. A pattern like `gpt-5.5` spawns "accepted," and the missing-API-key failure (`No API key found for azure-openai-responses`) only surfaces later, once a message is actually sent to that teammate.

**Fix:** validate every teammate's `model` string before spawning *any* process for the team. In `team_spawn`'s `execute` (`index.ts:485`, teammate loop at `index.ts:514`), before calling `startTeammate` (`index.ts:296`, which does the actual `childProcess.spawn` at `index.ts:315`), run a preflight check per teammate model. If any model fails, throw immediately with a clear per-teammate error and spawn nothing — this matches the existing all-or-nothing error handling already in that loop (`index.ts:517-520`, which tears down the whole team on any spawn error).

**Mechanism:** shell out to `pi --list-models "<pattern>"` (array-args `child_process`, not a shell string — avoid injection since `model` is model-controlled input) and check the output. This is the same fuzzy-search resolution `--model` itself uses, and it's already auth-filtered: providers with no configured key never appear in the list. Verified empirically in this environment:
- `pi --list-models sonnet` → real rows (`claude-bridge`, `openrouter`, etc.)
- `pi --list-models azure` → `No models matching "azure"` (azure has no key configured here)
- `pi --list-models "claude-bridge/claude-sonnet-4-6"` → resolves correctly (provider/id form works)
- `pi --list-models "sonnet:high"` → `No models matching` (the `:thinking` suffix is **not** accepted by `--list-models`, even though `--model` accepts it) — strip any `:thinking` suffix from `teammateSpec.model` before passing to `--list-models`, do not pass it through as-is
- Runtime: ~1s per call; run all teammates' checks in parallel (`Promise.all`) to keep total preflight latency bounded to roughly one call's worth of time regardless of team size

No unresolved rows for a given teammate → reject that model, abort the whole spawn, report which teammate/model failed. This needs no new dependency and no re-implementation of model/auth resolution — it reuses the CLI's own logic.

(Alternative considered and rejected: importing `ModelRegistry` directly from `@earendil-works/pi-coding-agent` — it's a public export (`dist/index.d.ts:11`) with a `getAvailable()` method that does the auth-filtered listing in-process, avoiding subprocess cost. Rejected for this pass because it requires constructing an `AuthStorage` and re-implementing the fuzzy pattern-matching that `--list-models`'s CLI path already does; the ~1s subprocess cost is a one-time, parallelizable cost at spawn time and not worth the extra coupling to core internals.)

## 2. Ambiguous progress after first message (review issue 2)

**Problem:** After the first `teamsend`, teammates still show `idle` until explicitly nudged to acknowledge. The supervisor can't tell if the message was queued, ignored, delayed, or silently failed.

**Fix:** prompt-only change in `composeSystemPrompt()` (`index.ts:283-292`). Add an explicit instruction line: as soon as a teammate starts (i.e., as soon as it reads its spawn instructions), it must set its `teamstatus` to acknowledge before doing any substantive work. Add a second instruction: whenever a message arrives from main or any teammate (via `teamsend`/`teammain` delivery), acknowledge via `teamstatus` first, then proceed. This directly matches the review's own prescribed fix ("upon wake up, set status to ack instructions. upon receiving a message from anyone, nod first, then proceed").

## 3. Turn-taking needed manual nudging (review issue 3)

**Problem:** A teammate reaches a natural handoff point (e.g., "waiting for reviewer") but the other party's status stays `ready`/unaware until the supervisor manually pings them. Passive waiting is invisible to the other side.

**Fix:** prompt-only change in the same `composeSystemPrompt()` block. Add an instruction establishing ownership: a teammate must never set a "waiting for X" status without first sending X a `teamsend` describing exactly what's needed from them. The blocked party is responsible for driving the handoff by notifying, not just parking itself in a waiting state and hoping to be noticed. Matches the review's prescribed themes directly: "ownership, proactivity... not standalone 'waiting for reviewer'; instead, message the reviewer then set 'waiting for reviewer' status."

## Deferred (not in this plan)

- **Issue 4 — status not authoritative.** Review's own assessment: the real fix is a small async watcher (e.g. a lightweight LLM or heuristic) reading each teammate's transcript/messages and setting status independently of the teammate's own self-reporting. Nontrivial scope increase; postponed.
- **Issue 5 — no transcript/conversation inspection for the supervisor.** Legitimate need but trades off against context hygiene (dumping raw inter-agent chatter into main's context defeats the purpose of giving teammates fresh windows). Needs its own design pass; not high priority per the review.

## References

- `agent/extensions/pi-simple-team/index.ts` — `composeSystemPrompt` (`:283`), `startTeammate` (`:296`), `childProcess.spawn` (`:315`), `team_spawn` tool + teammate loop (`:485`, `:514`, error teardown `:517-520`)
- `thoughts/26-07-08-team-reliability/26-07-06-usage-review.md` — source of the five issues and their priorities
- `agent/extensions/pi-simple-team/IMPLEMENTATION.md` — existing design notes and rationale
- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`, `docs/extensions.md` — RPC protocol and extension API surface consulted while scouting
- `@earendil-works/pi-coding-agent` public export `ModelRegistry` (`dist/core/model-registry.d.ts`, re-exported at `dist/index.d.ts:11`) — considered as an in-process alternative to shelling out to `--list-models`, documented above as the rejected alternative
- Empirical checks run against this environment: `pi --list-models [pattern]` behavior for matching/non-matching/provider-qualified/thinking-suffix patterns, and timing (`~1s` per call)

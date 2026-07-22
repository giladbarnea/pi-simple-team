Short version: **the core idea worked, but lead observability is the bottleneck.** The team was useful, yet I spent too much effort verifying whether teammates had actually done what they claimed.

The hardest parts:

1. **“Accepted” did not mean “received and acting.”**  
   `teamsend` returned accepted, but teammates sometimes stayed `idle` until nudged. I wanted delivery state: queued, delivered to child RPC, accepted as prompt/steer, agent started.

2. **Manual status was not trustworthy enough.**  
   Status helped, but it lagged or lied by omission. I wanted automatic runtime status alongside self-reported status: busy/idle, last message received, last tool call, last error, pending handoff.

3. **No supervisor event log was painful.**  
   This was the biggest one. Teammates claimed files were written when they were not visible. If I had a `teamlog` or `team_events` tool exposing recent child events/tool calls/stdout/stderr, I could have diagnosed this immediately. The extension already stores `recentEvents`; exposing them with filters and limits would be high leverage.

4. **The first teammate may not know all participants.**  
   `startTeammate()` currently builds `participants` from `team.members` as it spawns sequentially, so the first child can get an incomplete participant list. That may contribute to weak coordination. `team_spawn` should compute all names upfront and pass the full list to every child.

5. **30-second waits are too short for team workflows.**  
   We hit a timeout/status error while interrupting ScoutA. For teams, delivery/idle waits should probably use the 20-minute assumption or at least a much longer timeout.

6. **No structured “done” handshake.**  
   Teammates used `teammain`, but I wanted a structured final payload: changed files, validation run, known untested parts, reviewer approval. A `team_done` or `teamreport` tool would reduce ambiguity without forcing transcript dumps.

Best next DX improvements, in priority order:

1. Add `team_events` / `teamlog` for recent messages, tool calls, errors, and stderr.
2. Make `teamstatus` include automatic runtime fields, not only self-reported text.
3. Fix participant list construction.
4. Add delivery/ack state for `teamsend`.
5. Add structured final report / done tool.
6. Increase team delivery/interrupt timeouts.

The promising part: push messages from teammates to main were genuinely useful. The missing piece is **supervisor-grade proof**, not more autonomy.

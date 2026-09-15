# Team API implementation decision trail

Source of truth: [review.md](review.md). Workflow: [playbook.md](playbook.md).

## Before implementation

| Unit/check | Hypothesis or decision | Observation | Verdict | Evidence |
| --- | --- | --- | --- | --- |
| Existing suite | Current behavior has a green baseline before feature changes | 224 pass, 2 skip, 0 fail in 19.90 seconds | VERIFIED for enabled suite; skipped checks not counted as passed | [baseline-tests.log](evidence/baseline-tests.log) |
| Real-Pi environment | The installed Pi process can receive HTTP delivery and retain conversation across model turns | The existing local-provider test passed in 871 ms, with no paid model request | VERIFIED | [baseline-real-pi.log](evidence/baseline-real-pi.log) |
| Verification boundary | Fake subprocesses cannot prove Pi's context insertion and turn semantics | Use a real Pi process with a local provider for the first tracer bullet | Selected workflow | `test/stderr-lifecycle.test.ts` and `test/child-transport.test.ts` |
| Storage compatibility | Public names should change without erasing previously saved teams | Preserve storage fields where migration is unnecessary; translate at public boundaries | Selected workflow | `team-registry.ts` |
| Prior modifications | Existing user work must remain distinguishable from this implementation | Three requested TODO comments in index.ts; unrelated screenshot/design edits; review artifacts | Recorded | Baseline HEAD `028d66d9d7c318969bf1db7f538ca0dd3b9fdf8b` |

The user approved implementation and bounded manual LLM checks with `openai-codex/gpt-5.6-luna`, thinking `low`.

## Per-experiment record

Append one row when each experiment completes. Include the exact test command and saved output. A fixture exception is an invalid red. An inconclusive or skipped observation never becomes a green verdict.

| Unit | Hypothesis | Intended red | Actual red and evidence | Smallest change | Green evidence | Verdict / next action |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Real Pi can record instructions without executing and use them once later | Staged instructions must not issue a model request | 1 request instead of 0: [red](evidence/01-idle-red.log) | Allow delivery to specify `triggerTurn: false` | Both idle-context and existing conversation tests pass: [green](evidence/01-idle-green.log) | VERIFIED |
| 2 | Spawn starts the complete ready batch; idle opt-out prevents work | Default spawn never delivers; startIdle is ignored after adding default kickoff | [barrier/default red](evidence/02-kickoff-red.log), [idle red](evidence/02-idle-red.log) | Kickoff after registration/manifest; explicit idle control | [green](evidence/02-idle-green.log) | VERIFIED behavior; public contract migrated later in unit 6 |
| 3 | Resume records separate instructions without changing prompts; default resume/add start only affected members | No resumption message and no default work | [instructions red](evidence/03-resumption-red.log), [resume red](evidence/03-resume-default-red.log), [add red](evidence/03-add-red.log) | Use context-only delivery for idle resume; add/resume kickoff and optional add selector | [green](evidence/03-add-green.log) | VERIFIED at HTTP/process boundary; full real-Pi flow remains in final verification |
| 4 | Individual pane choices work and explicit team flags override them | No pane opens for the selected individual | [red](evidence/04-panes-red.log) | Resolve transport per teammate, including additions | [green](evidence/04-panes-green.log) | VERIFIED at Herdr command boundary |
| 5a | An interruption array affects only selected recipients | Both recipients receive interrupt=true | [red](evidence/05-interrupt-red.log) | Shared target validation and per-recipient flag | [green](evidence/05-interrupt-green.log) | VERIFIED |
| 5b | Deferred errors reach the original sender | No pushed error after rejected delivery | [red](evidence/05-main-error-red.log) | Notify main or the original teammate; log failed notifications without recursion | [green, both sender roles](evidence/05-delivery-green.log) | VERIFIED |
| 5c | Partial kickoff errors describe actual effects | Raw rejection omits the successful teammate | [red](evidence/05-partial-red.log) | Shared queued kickoff operation waits for all outcomes and preserves inspectable team | [all behavior checks green](evidence/05-all-behaviors-green.log) | VERIFIED |
| 6a | Spawn accepts agreed field names and returns one durable identity per teammate | Reviewed inputs rejected by schema | [red](evidence/06-spawn-contract-red.log) | Public input mapping, compact identity result, post-call instructions | [green](evidence/06-spawn-contract-green.log) | VERIFIED |
| 6b | Resume/add expose affected identities and whole-team status consistently | Add has no started field | [red](evidence/06-lifecycle-contract-red.log) | Shared lifecycle result with per-resume contextRestored | [green](evidence/06-lifecycle-contract-green.log) | VERIFIED |
| 6c | List returns full teammate records without parallel identity arrays | List uses old team keys and members layout | [red](evidence/06-list-red.log) | Translate stored configuration at the public boundary | [green](evidence/06-list-green.log) | VERIFIED |
| 6d | Messages acknowledge publication and shutdown returns recovery identities | Old accepted field omits publication semantics | [red](evidence/06-message-contract-red.log) | Consistent message/shutdown results and updated consumers | [green](evidence/06-message-contract-green.log) | VERIFIED |
| 6e | New result shapes render the same useful information | Resume renders zero members and an undefined team name | [red](evidence/06-render-red.log) | Update result adapters and input-driven send rendering | [green](evidence/06-render-green.log) | VERIFIED |
| 6f | Ambiguous selectors expose name-to-ID choices | Error omits the actual candidate IDs | [red](evidence/06-errors-red.log) | Shared candidate map and corrective parameter guidance | [green](evidence/06-errors-green.log) | VERIFIED |
| 7a | Herdr's installed CLI can launch visible teammates | Real CLI rejects the old --tab option | [real CLI red](evidence/07-herdr-cli-red.log), [fixture red](evidence/07-herdr-fixture-red.log) | Use pane split/rename/run and quote each Pi argument | [transport suite](evidence/07-transport-regression.log), [live observation](evidence/07-herdr-observation.json) | VERIFIED |
| 7b | Real Pi preserves context through idle resume, normal resume, and add | Existing fixture coverage did not prove the full real process flow | Extended the local-provider real-Pi journey | Exercise current tool APIs and actual model request bodies | [real lifecycle](evidence/07-real-lifecycle.log) | VERIFIED |
| 7c | Model errors provide usable replacement IDs | Missing-model error contains no choices | [red](evidence/07-model-error-red.log) | Append available canonical IDs and the field to correct | [green](evidence/07-model-error-green.log) | VERIFIED |
| 7d | Resumption messages retain their full text in the ordinary log | Tail text cannot be found in the log | [red](evidence/07-resumption-log-red.log) | Share the publication queue between kickoff and ordinary sends | [green](evidence/07-resumption-log-green.log) | VERIFIED |
| 7e | Empty teams do not prompt main to wait for nonexistent progress | Empty spawn returns teammate-progress instructions | [red](evidence/07-empty-result-red.log) | Keep only the bundled instruction when no members are affected | [green](evidence/07-empty-result-green.log) | VERIFIED |
| 7f | The real dashboard boundary reports mixed transport | It labels a mixed team as RPC only | [red](evidence/07-dashboard-red.log) | Derive snapshot transports from actual live members | [green](evidence/07-dashboard-green.log) | VERIFIED |
| Audit: concurrent startup | Both concurrent spawns wait for the callback server address | Second child gets an empty URL and exits | [red with exact registration error](evidence/08-concurrent-red.log) | Share the callback readiness promise | [green](evidence/08-concurrent-green.log) | VERIFIED |
| Audit: cancellation | Cancelling preparation prevents automatic kickoff | Cancelled spawn completes and starts work | [red](evidence/08-cancel-red.log) | Propagate cancellation through registration and check the barrier | [green](evidence/08-startup-green.log) | VERIFIED |
| Audit: inherited role | A fork executes its own assignment rather than main's coordination steps | Real copier waits for itself to create a file despite having the token in context | [initial manual trace](evidence/08-inherit-smoke.jsonl), [deterministic red](evidence/10-fork-assignment-red.log) | Kickoff names the recipient and restates its individual assignment | [deterministic green](evidence/10-fork-assignment-green.log), [real trace observation](evidence/10-inherit-observation.json) | VERIFIED |
| Audit: obsolete flags | Old optional input names cannot silently select defaults | inheritContext is accepted and ignored | [red](evidence/10-old-fields-red.log) | Forbid undeclared teammate input properties | [final suite](evidence/12-final-tests.log) | VERIFIED |

## Whole-product result

VERIFIED. The approved implementation is complete.

| Check | Observation | Verdict |
| --- | --- | --- |
| `PI_SIMPLE_TEAM_TEST_REAL_PI=1 bun test` | 250 passed, zero failures, zero skips in 26.50 seconds | VERIFIED — [final suite](evidence/12-final-tests.log) |
| Luna CLI workflow | Default spawn, statuses/context, idle add, explicit message, idle resumption instructions, file evidence, and shutdown | VERIFIED — [observations](evidence/07-luna-observation.json) |
| Live Herdr workflow | Individual visible pane, automatic task execution, completion message, and exact pane shutdown | VERIFIED — [observations](evidence/07-herdr-observation.json) |
| Actual `/team` TUI | Dashboard, messages zoom, and log zoom render in the live Pi process | VERIFIED — [dashboard](evidence/07-team-dashboard.txt), [messages](evidence/07-team-messages-zoom.txt), [log](evidence/07-team-log-zoom.txt) |
| Inherited-context retry | The child writes ORCHID-82 from inherited history. The token is absent from its configuration; no session-file search or current-run tool errors | VERIFIED — [observations](evidence/10-inherit-observation.json) |
| API reference | All 11 tools and role variants exported from current registration, plus success behavior and complete error templates | VERIFIED — [reference](review.md), [registered definitions](registered-tools.json) |
| Final metadata cleanup | Removed the remaining redundant status snippet under the MECE rule; all 97 metadata/renderer checks pass | VERIFIED — [metadata checks](evidence/13-final-metadata.log) |

## Decisions and verification limits

The first inherited-context smoke was a real failure, not lost context. Its native child session contained the token. The child followed main's inherited wait loop. Repeating the individual assignment in the latest kickoff costs some prompt tokens but fixes the observed role confusion. A deterministic delivery test now protects that instruction, and the real retry succeeded.

The successful model-written inheritance summary placed the teammate ID in its teamId field. The API returned the correct fields. The observation file therefore uses actual tool results, not the model-written summary. Historical failed tool results copied into the fork are excluded from current-run error counts by the new kickoff entry boundary.

Herdr's agent wait command reported `agent_prompt_stalled` despite the actual Pi task running and completing. The live pane content, marker, native tool trace, and pane removal independently verified the extension. The waiter's status alone was not treated as evidence of either success or failure.

Existing ownership and persistence fixtures now explicitly select idle startup where their subject is not kickoff. Assertions were migrated to the agreed public results without dropping the original ownership, expiry, identity, rollback, or layout checks. Earlier regression logs remain available to audit that migration.

The test Herdr tab and its teammate pane were closed, and focus returned to the original tab. Manual teams were shut down. Their sessions remain durable test evidence. No push or publication occurred. Unrelated screenshot and design-note changes were left intact.

No required acceptance condition remains open or inconclusive. The explicitly deferred API additions remain deferred as agreed.

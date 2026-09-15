# Implement the revised team API with vertical TDD

## Frame

The agreed API is in [review.md](review.md). The submitted feedback and its original page are preserved beside it. This playbook changes runtime behavior, not just the review document.

**Done is a falsifiable predicate:** every acceptance condition below passes through the public tool boundary and the relevant real Pi paths; the full regression suite passes; active documentation and renderers match the revised API; no required verification is inconclusive.

**Scope:** 11 public tools, about 8 runtime/support modules, up to 10 existing test files, and 4 active root documents. Expect roughly 20–25 affected files and 2–4 hours. Historical thoughts, submitted feedback, and unrelated screenshot changes remain untouched.

**Rigor: high for lifecycle, persistence, and message delivery; normal for prose and display changes.** Starting work by default can cause filesystem actions. Losing saved context or sending a failure to the wrong team would violate core product behavior. Those paths require deterministic integration evidence and a real-Pi check. Text edits do not need individual tests for every sentence.

No current external blocker. The installed Pi binary, dependencies, fake Herdr boundary, and local model endpoint work. The riskiest unknown is whether resumption context can be recorded without a model turn and survive later work. The first unit tests that before the broader migration.

The supplied figure-it-out process calls for one checkpoint before a long run. The TDD skill also calls for plan approval. This is that checkpoint; interface decisions already made will not be reopened.

## Baseline evidence

| Check | Result | Evidence |
| --- | --- | --- |
| `bun test` | VERIFIED: 224 pass, 2 skip, 0 fail; 19.90 seconds | [baseline-tests.log](evidence/baseline-tests.log) |
| `PI_SIMPLE_TEAM_TEST_REAL_PI=1 bun test test/stderr-lifecycle.test.ts` | VERIFIED: 1 pass, 0 fail; actual Pi process and local model endpoint | [baseline-real-pi.log](evidence/baseline-real-pi.log) |

Baseline HEAD: `028d66d9d7c318969bf1db7f538ca0dd3b9fdf8b`. Bun: `1.3.14`. Pi: `0.85.1`.

The default suite skips two real-Pi checks. The separately executed stderr/conversation check uses a local provider and no paid inference. Its success proves the test environment can launch Pi, deliver a message, preserve conversation across two turns, and shut it down.

Existing local modifications before implementation: the three requested TODO comments in `index.ts`; unrelated screenshots and visual-design notes; this API review folder. The decision trail records them so later diffs are not mistaken for this change.

## Coupling map

| Boundary | Current responsibilities | Required change and downstream proof |
| --- | --- | --- |
| `index.ts` | Public tools, team ownership, startup, message queue, results, shutdown | Default kickoff, barrier, new signatures/results, selected interrupts, sender error notification |
| `child-tools.ts` | HTTP delivery, Pi messages, lifecycle callbacks, member tools | Record context without starting a turn; renamed member tools; published results and status |
| Pi `AgentSession` and session manager | Message insertion, turn execution, conversation persistence | Real process/local provider proves no-turn insertion and later model-visible context |
| `system-prompt.ts`, `bundled-skill.ts`, `model-preflight.ts` | Agent instructions, capability names, model guidance/errors | New names resolve to real tools; post-call instructions appear at the correct time |
| `team-registry.ts` | Durable attachments, leases, creator scope, saved session IDs | Old durable sessions still resume; no new teammate ID; input/output rename does not erase storage history |
| `render.ts` and `teamlog.ts` | Tool dispatch, result shapes, display, event normalization | New tool/result names render correctly; messages and failures appear once in the log |
| `team-ui.ts` | Read-only `/team` snapshots and overlay | Existing dashboard behavior remains valid after runtime/result changes |
| Tests and active docs | Fixtures, public examples, usage instructions | Update affected calls in the same unit as each public change; do not retain misleading old examples |

Use the public API revision without compatibility aliases for old tool names. Keep the durable storage contract when a public rename does not require a storage change. That avoids a needless migration of users' saved teams. Do not introduce a second teammate identifier.

## Acceptance conditions and priority

| Priority | Required behavior | What would disprove it |
| --- | --- | --- |
| P0 | Spawn, resume, and add start the affected teammates by default | No model request after readiness, or a required separate send |
| P0 | Every affected teammate is ready before any in that batch starts | A model request occurs while another member's registration gate is held |
| P0 | `startIdle: true` creates/resumes/adds idle teammates | Any model turn occurs before a later message explicitly starts work |
| P0 | `resumptionPrompt` enters conversation once without replacing system prompts | It appears in system instructions, disappears before the next turn, repeats, or starts work despite `startIdle` |
| P0 | Resume preserves durable identity and context; add/resume leave existing live members alone | Identity/context loss, duplicate runtime, or unsolicited new turn for an already-live member |
| P0 | A post-publication delivery failure reaches the original sender | Silent failure, wrong recipient, or recursively generated failure messages |
| P0 | Partial failures tell the caller what started or stopped | A success claim after incomplete kickoff, or an error that falsely implies nothing changed |
| P1 | Selective interruption affects only listed recipients | An unlisted recipient is aborted, or an invalid interrupt target is silently accepted |
| P1 | Team-wide Herdr setting explicitly overrides individual settings; omission retains individual choice | Incorrect pane selection or loss of mixed-pane support |
| P1 | New tool names, input names, and result identities work for main and both teammate roles | Missing tool, wrong parent/owned-team route, duplicate ID field, or mismatched renderer |
| P1 | List returns complete teammate records without the duplicate name array | Missing effective configuration or lost durable session information |
| P1 | Status/timing/prose placement matches the agreed API | Manual timestamp input; pre-call polling instructions left behind; long removed snippets still registered |
| P1 | Errors identify values, available choices, and a useful next action | Ambiguous names without candidate IDs, model error without available choices, wrong public field/tool names |
| Regression | Ownership, recursive shutdown, context queries, reminders, log paging, and `/team` remain correct | Any existing meaningful regression check fails |

The first test is a tracer bullet for P0: a real Pi session receives a resumption-context message, makes no model request, then includes that message in its next actual model request. This tests the effect, not a spy assertion that `triggerTurn` was set to false.

The batch-barrier test uses a controlled registration gate, not a guessed startup delay. The test observes model requests or endpoint acceptance while the gate is held, then releases it and observes all affected members. Failure must be for premature/no work, not a broken fixture.

## Workflow

### Phase A and B: frame and prepare

The baseline and coupling map above are complete. Before editing a module, read its affected implementation and tests fully. Read the local Pi docs/source needed for session insertion, tool results, and persistence. Reuse the existing local-provider test before adding a new harness abstraction.

### Phase C: one experiment at a time

For each unit, write one behavior test, observe a meaningful red, make the smallest implementation change, and observe green. Only then select the next behavior. Do not write all proposed tests before starting implementation.

| Unit | Hypothesis and public proof | Expected scope |
| --- | --- | --- |
| 1. Record resumption instructions without execution | An actual Pi session can retain a one-time message without starting a turn, then expose it to a later model request | Child delivery and local-provider test. Implement only the primitive required by this proof. |
| 2. Start a complete new team | One spawn starts all members after the readiness barrier; `startIdle` starts none; failed preparation starts none | Spawn orchestration, fixture registration gate, new spawn input/result contract, affected renderer/call sites |
| 3. Resume and add consistently | Both use the same batch rule; resume preserves context and prompts; added/resumed members can start idle | Resume/add paths, durable lifecycle tests, results/status snapshots, optional active-team selector |
| 4. Respect pane choices | Individual panes work in spawn/add; explicit team choice wins; resume retains its specified pane behavior | Per-member transport selection, Herdr boundary fixture, process cleanup |
| 5. Publish messages and report failure | Selective interrupts affect only named recipients; deferred failure reaches the sender; both message results expose truthful publication/status | Queue and child endpoints, sender routing, failure injection, message/log rendering |
| 6. Complete API/prose/error consistency | Renamed tools work in all roles; list/status/shutdown/context/log/reminder results and descriptions match the review | Remaining public changes, shared result builders only where duplication justifies them, actionable errors, renderer tests |
| 7. Verify the complete product | A no-op workflow exercises the new lifecycle and messaging through Pi, plus `/team` and relevant Herdr behavior | Whole-suite regression, real-Pi local-provider flow, bounded interactive smoke, active docs |

These are independently verifiable local changes. Public definitions, their callers, and their renderers change together. There is no isolated “rename everything” phase that knowingly leaves callers broken. Do not publish intermediate units. Pushing this repository triggers automatic package publication.

For each unit, the decision trail records: hypothesis, test command, intended red, actual red, smallest change, green evidence, verdict, and any follow-up. Verdicts are `VERIFIED`, `NOT VERIFIED`, or `INCONCLUSIVE`. A skipped check is not a pass.

Refactor only after green, and only where the new behavior exposes real duplication. A small shared batch-start operation may hide readiness, context insertion, kickoff, and partial-failure accounting. A shared result formatter may enforce identity consistency. Neither becomes a general workflow engine.

### Phase D: verify and hand back

1. Run focused checks as each unit lands. Read actual failures; reject fixture errors as evidence of the desired red.
2. Run `bun test` once integrated. Repeat only after a new change, failure, or unresolved concern.
3. Run the real-Pi local-provider checks for context staging, default kickoff, later turns, resume, and cleanup.
4. Run a bounded interactive no-op Pi workflow in an isolated temporary project. Check public tool use, the rendered results, and `/team`. Exercise a small visible Herdr case when the local app context supports it.
5. If a live surface cannot be checked, record `INCONCLUSIVE` with the exact limitation. Do not claim the whole predicate verified.
6. Search active code, bundled instructions, tests, and docs for stale public tool/field names. Historical feedback and the deliberately retained storage schema are not stale public API.
7. Review the final structured diff against the baseline. Leave unrelated edits intact. Do not push, publish, or change global configuration.

The whole-product smoke is bounded. The main deterministic checks use a local model endpoint, not paid inference. If actual agent behavior needs a model smoke, use the user's configured small model and a no-op mission, not a long team task.

## Implementation boundaries

- The API signatures and names already agreed remain the source of truth.
- Expanded ID input acceptance, individual resumption-message objects, plural log filters, auto-resume on spawn collision, and opt-in dormant listing remain deferred.
- The requested TODO comments are already present for the latter three future changes.
- `teammateId` is the Pi session ID. Public responses do not repeat `sessionId`.
- `resumptionPrompt` is a conversation message. It never replaces common or individual system prompts.
- `startIdle` controls execution even when `resumptionPrompt` is supplied.
- Keep the three lifecycle results cohesive. Return whole-team statuses for resume/add, not a routine initial status map for spawn.
- Keep successful publication separate from guaranteed recipient delivery. Later delivery failures are pushed to the sender.

## Work list

- [x] Read the specified TDD/write-tests skills and map affected boundaries.
- [x] Capture the unchanged full-suite baseline.
- [x] Verify the existing real-Pi/local-provider test environment.
- [x] Write this playbook and initialize the decision trail.
- [x] Complete the single pre-implementation checkpoint. Approved in chat, including bounded Luna model checks.
- [x] Unit 1: prove context insertion without a turn, then implement it.
- [x] Unit 2: default spawn kickoff and readiness barrier.
- [x] Unit 3: resume/add semantics and lifecycle results.
- [x] Unit 4: per-teammate and team-wide pane behavior.
- [x] Unit 5: selective interrupts and pushed delivery failures.
- [x] Unit 6: remaining API/prose/error consistency.
- [x] Unit 7: integrated product verification and active documentation.
- [x] Hand back verdicts with evidence and any unresolved limitations.

Completed with high rigor. The final suite has 250 passing tests, including real-Pi checks. Manual Luna, inherited-context, Herdr, and `/team` observations are in the decision trail. The final audit also fixed concurrent callback initialization, cancellation before kickoff, and inherited-role confusion.

Decision trail: [decision-trail.md](decision-trail.md). Evidence: [evidence/](evidence/).

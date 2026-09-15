# Apply the shared API rules

The September 14 submission contains 14 annotations. The user authorized judgment calls and implementation after discussing two shared rules: consistent selection and results that describe the resulting team.

## Completion predicate

One caller can select two same-named teammates by their Pi session IDs for messaging, logs, and context usage. Selecting a team selects its teammates. Ambiguous names identify the available IDs. Invalid selections cause no partial publication. Lifecycle results contain the complete roster, use consistent teammate fields, and report actual work independently of process liveness and the caller's startIdle flag. All existing lifecycle, delivery, ownership, and rendering checks pass after intentional API updates.

## Decisions

1. Use one targets array for messages, logs, and context usage. Each value is a team or teammate name or ID. Names must resolve uniquely in the caller's permitted scope. Repeated or overlapping selections select each teammate once.
2. Keep the destination team on resume and add. Resume's teammate subset accepts names or IDs. Importing arbitrary existing Pi sessions remains a source TODO, as annotation 5 requested. Add still creates new teammates and its description states that limit.
3. Spawn, list, and resume share full teammate records. Add and shutdown return lightweight records derived from the same fields. Results use name and teammateId consistently.
4. live means a running process. active means work is underway or queued. Runtime events determine activity, independently of teammate-written status prose. started is the aggregate activity of the resulting team. Resume identifies pre-existing active teammates explicitly.
5. Keep contextRestored only on teammates actually resumed. False means the original session had no materialized history. Missing previously saved history remains an error.
6. Remove compatibility names and branches. Version-2 manifests use current teammate fields under `pi-simple-team/teams-v2/`. This separates old records without migration or old-format readers. Do not migrate or delete user session files.
7. Preserve scope: members message their parent team, managers also message owned teams. Selection convenience does not grant ownership of other sessions' teams.

## Workflow and rigor

High rigor for selection, publication, and activity because incorrect routing or an incorrect idle report changes agent behavior. Use public tool calls with real child HTTP runtimes and one red/green unit at a time. Keep rendering and prose verification proportionate.

1. Capture baseline, then prove complete spawn records.
2. Prove complete resume/add records and activity after idle/no-op resume.
3. Prove shared selection with duplicate names, team expansion, and rejected ambiguous publication.
4. Apply selection to logs and context usage, including cross-team results and pagination.
5. Verify child and managing-teammate routing, lifecycle IDs, current storage, and rendering.
6. Update the single API review page and documentation. Run the full suite, real Pi tests, and a bounded Luna smoke test. Archive evidence and reopen the review in a background Plannotator session.

## Decision trail

| Unit | Evidence | Verdict |
| --- | --- | --- |
| Baseline | evidence/14-baseline.log: 247 pass, 3 optional real-Pi tests skipped, 0 fail | VERIFIED |
| Complete spawn records | 15-roster-red.log demonstrates missing configuration and inconsistent name. 15-roster-green.log passes the same public tool test. | VERIFIED |
| Existing activity on idle/no-op resume | 16-activity-red.log demonstrates started:false while a teammate works. 16-activity-green.log verifies the complete active roster and pre-existing active identity. | VERIFIED |
| Lightweight complete add roster and settlement | 17-complete-roster-red.log and 17-complete-roster-green.log verify all names/IDs/live/active fields, list agreement, and activity after settlement. | VERIFIED |
| Shared context selection | 18-selection-red.log rejects a valid Pi session ID. 18-selection-green.log resolves two same-named teammates and deduplicates overlapping team selection. | VERIFIED |
| Shared message selection | 19-message-selection-red.log requires the old team selector. 19-message-selection-green.log verifies cross-team publication, interruption by ID, and rejection before partial publication. | VERIFIED |
| Shared log selection and pagination | 20-log-selection-red.log and 20-log-selection-green.log verify one global row limit and complete paging across repeated local sequence numbers. | VERIFIED |
| Resume accepts names or IDs | 21-resume-id-red.log rejects the saved Pi session ID. 21-resume-id-green.log verifies exact history restoration and a complete roster including stopped teammates. | VERIFIED |
| Current storage fields | 22-storage-red.log demonstrates the old format. 22-storage-green.log verifies the saved artifact uses the full current teammate record directly. | VERIFIED |
| Existing integration contracts | 23-integration.log identifies old assertions and a simplistic fixture missing activity events. Updated checks preserve the original transport/ownership guarantees. 24-integration.log: 144 pass. | VERIFIED |
| Rendering the complete resume roster | 25-render-red.log demonstrates failure on the consistent name field. 25-render-green.log includes pre-existing active work. 26-render-integration.log: 97 pass. | VERIFIED |
| Queued work is active work | 27-queued-red.log holds HTTP delivery open and exposes a false idle report. 27-queued-green.log verifies started and alreadyActiveTeammates while the model turn has not started. | VERIFIED |
| Real Pi lifecycle | 30-real-lifecycle.log: 22 pass. Real model requests preserve context across explicit messages, idle resumption, automatic resumption, and additions. | VERIFIED |
| Luna smoke test | 31-luna-observation.json verifies 17 actual tool completions, one deliberate ambiguity error, zero unexpected errors, two native teammate marker writes, ID selection, log paging, complete add roster, and dormant cleanup. | VERIFIED |
| Manager instruction consistency | 33-manager-guidance-red.log detects an obsolete message team parameter in the injected system prompt. The green log verifies its removal and parent routing. | VERIFIED |
| Final complete suite | 34-final-tests.log: `PI_SIMPLE_TEAM_TEST_REAL_PI=1 bun test`, 253 pass, 0 fail, 0 skip, 37.06 seconds. | VERIFIED |

All evidence paths above are under `evidence/` beside this file. The API reference is regenerated from all three roles' real registrations. `git diff --check` found no whitespace errors in the changed source, tests, or root docs.

The completion predicate is verified. Existing-session attachment remains a documented source TODO, as requested. No release, commit, or push was performed. Pre-existing screenshot and unrelated thoughts changes remain untouched.

## Release after user approval

The user approved commit, push, and a major release as 2.0.0. Commit `bcaa4789d6b591aca68a0921ef4afc343d2db286` is on main and tagged v2.0.0. npm reports 2.0.0 as latest with that exact gitHead. The GitHub release contains the requested Breaking changes section. GitHub tests, npm publication, the GitHub Packages mirror, and release creation all passed.

Release preparation now accepts an explicit higher stable version, retains automatic patch releases, and rejects downgrades. Its actual workflow step was tested against isolated Git repositories. The full suite passed 256 tests including real Pi, recorded in `evidence/35-release-tests.log`.

[Release 2.0.0](https://github.com/giladbarnea/pi-simple-team/releases/tag/v2.0.0) · [Publish workflow](https://github.com/giladbarnea/pi-simple-team/actions/runs/34884700824) · [GitHub tests](https://github.com/giladbarnea/pi-simple-team/actions/runs/34884700795)

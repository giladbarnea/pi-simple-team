# Development

This is a Pi extension. Read ~/.pi/AGENTS.md to study Pi.
Read all the root docs. Understand the developer’s request. Then dispatch a Luna (or similarly "flash"-level model) with thinking=high to retrieve a list of all the Pi docs relevant to this extension’s architecture and user’s request. 

## CICD

This extension is published to npm automatically on push to main. If the repository version matches npm, the workflow advances one patch. An explicitly higher version is preserved. An older version fails before publication. Version-specific release notes live in `releases/<version>.md`. Pi.dev references the npm package.

## Product design

**> Everything comes down to design, user experience, empowering the user with actual productivity added value, and instilling trust as they use the extension more.** Every development, product and design decision has to be justified by that touchstone.

The extension has gained mild popularity recently with a few thousand monthly downloads, so keep commits and user-facing vectors high quality. User-facing vectors, in no particular order, are (i’m basically breaking down what “product design” means to this project):
- the packaged docs
- TUI-rendered design. well-designed here means information hierarchy, progressive disclosure, transparency and a feeling of control, visual beauty, all while not generating cognitive load — quiet the opposite (*relieving* cognitive pressure).
- usability and UX. no learning curve, "just works", delightful. this is driven by a combination of making the main agent responsible for doing all the team actions (happy path does not give the user any commands or buttons to do that), and the packaged ai-to-delegated and ai-to-leader skills which teach all the AI’s involved to communicate effectively, which is the only way to unleash the power of the underlying architecture and inherent advantage of a live team over, say, parallel siloed sub-agents.
- the psychological relief of users when they realize they can let go of the petty tiny details they otherwise need to watch, manage and tweak. these details users wish they could forget about are implementation details, actual code, finding bugs manually (or the anxiety of not knowing whether there are bugs their AI agent missed and signed off the work as having "no bugs"), fixing bugs manually (or the anxiety of not trusting their AI agent to successfully fix the bugs). the things in this project that drive this psychological relief is a combination of lifting the user one level up in the delegation hierarchy + gaining the user’s trust that they actually can sit back and relax because the prompts (skills) + very nature of a real-time internally communicating team + the agent-facing tool design actually work and deliver what they promise, consistently.

## Testing

Reproduce / baseline tests run first thing.

**Automatic testing:**
We do high quality TDD. Load related skills.
Not everything can be tested programmatically, though. We lean on manual tests for that reason.

Run `bun test` for the default suite. Run `PI_SIMPLE_TEAM_TEST_REAL_PI=1 bun test` to include real-Pi checks. The lifecycle and idle-context checks use local model endpoints. The small RPC connectivity check uses `openai-codex/gpt-5.6-luna` with low thinking.

For this API, verify the readiness barrier, `startIdle` on spawn/resume/add, and `resumptionPrompt` without system-prompt changes. Verify that deferred delivery errors reach the sender, and that explicit team-wide Herdr settings override individual choices. The Herdr fixture must match the installed `pane split` / `pane run` contract.

Verify that every teammate selector accepts a name or Pi session ID without changing the call shape. Test two same-named teammates across teams, overlapping targets, invalid interruption subsets, and cross-team log pagination. Lifecycle results must include the complete roster. Idle/no-op resume must report existing and queued work accurately, independently of status prose.

The registrations in `index.ts` and `child-tools.ts` define the tool API. Check the description, promptSnippet, parameter descriptions, and success instructions for all three roles when changing a tool.

**Manual (behavior) testing:**
Launch Pi in a tmux session and prompt the main agent as your use-case requires.

Basic sanity flow — use it as a skeleton for testing the behavior you want.
1. Use cheap & competent models with `high` thinking levels. As of Aug 2026, an example is gpt-5.6-luna. Peek at `jq '{defaultModel, defaultThinkingLevel, enabledModels}' ~/.pi/agent/settings.json` to get user’s favorite model IDs.
2. In tmux: `/abs/path/to/pi --model <fullmodelid> --thinking high --no-extensions --extension /abs/path/to/here/`
3. Central levers should pass sanity from both main and teammate’s sides:
   3.a. Tell main to output “hello”.
   3.b. Tell it to spawn a team of two <cheap&competent model>, with the parameters you want to test. Tell it to use the various team tools, talk with its teammates, tell the teammates to do the same (use team tools, talk among, talk back). Both main and team should do no-op filesystem CRUDs and bash runs. Just for a little while — we only want to press each button once to know that things work fine.
   3.c. You watch that tmux for errors or crashes.

### Recursive team flow

1. Spawn a team with one normal teammate and one teammate with `canManageOwnTeams: true`.
2. Verify the normal teammate has only parent-team member tools.
3. Ask the managing teammate to create a child team with at least one live teammate.
4. Verify it can send messages, read statuses and logs, inspect context use, add a teammate, and stop its child team.
5. Create a dormant parent or sibling team in the same project.
6. Verify the managing teammate cannot list, resume, message, inspect, add to, or stop that foreign team.
7. Stop the parent team while the child team runs. Verify the child process exits, its manifest becomes dormant, and its lease becomes unclaimed.
8. Resume the managing teammate. Verify `canManageOwnTeams` and access to its own dormant teams return.

### `/team` dashboard flow

1. Run `/team` before any team exists. Verify the 90% overlay shows the empty state and closes with Esc.
2. Spawn one team with active teammates. Have them update statuses, exchange messages, and produce enough non-message events to fill the dashboard.
3. Run `/team` again. Verify it skips team selection and opens the only team directly.
4. Keep the dashboard open while the team works. Verify the snapshot refreshes without reopening, and no bordered region moves.
5. Verify the outer border and fixed status, message, and log widgets. Confirm the newest fitting messages and log entries remain chronological.
6. Use long names, status phrases, messages, and log entries. Verify middle truncation, aligned status columns, and right-aligned timestamps.
7. Press scrolling keys and resize the terminal. Verify the regions never scroll, jump, or exceed the overlay bounds.
8. Press Up and Down. Verify the focus marker moves only between the message and log widgets and no region moves.
9. Press Enter on each widget. Verify it expands under the team header, shows older content than the dashboard, and keeps refreshing live.
10. Press Esc in a zoomed widget. Verify it returns to the dashboard. Press Esc again and verify the overlay closes.
11. Spawn a second team and reopen `/team`. Verify the selector lists both teams and opens the selected dashboard.

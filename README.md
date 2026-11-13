![A dark wireframe room in a starry void](https://raw.githubusercontent.com/giladbarnea/pi-simple-team/main/screenshots/pi-simple-team-banner.png)

<div align="center">

# pi-simple-team

> **The team extension with no features.**

[![Pi extension](https://shieldcn.dev/badge/pi-extension.svg?variant=outline)](https://github.com/earendil-works/pi)
[![npm version](https://shieldcn.dev/npm/%40giladbarnea%2Fpi-simple-team.svg?variant=outline)](https://www.npmjs.com/package/@giladbarnea/pi-simple-team)
[![test status](https://shieldcn.dev/github/ci/giladbarnea/pi-simple-team.svg?workflow=test.yml&branch=main&variant=outline)](https://github.com/giladbarnea/pi-simple-team/actions/workflows/test.yml)
[![license](https://shieldcn.dev/github/license/giladbarnea/pi-simple-team.svg?variant=outline)](https://github.com/giladbarnea/pi-simple-team/blob/main/LICENSE)
[![TypeScript](https://shieldcn.dev/badge/typescript.svg?logo=typescript&variant=outline)](https://www.typescriptlang.org/)
[![tested with Bun](https://shieldcn.dev/badge/tested_with-Bun.svg?logo=bun&variant=outline)](https://bun.sh/)

**No roles. No org chart. No mailboxes. No routing rules.**

`pi-simple-team` spawns a small team of Pi agents that can all talk to each other, like the responsible adults they are, **and then stays out of the way.**

</div>

---


## Why

I did my best work in a small room, together with a bunch of very capable people.

> <span style="color:grey">_[shouts]_</span> Has anyone figured out how to set up auth yet?

Not filing a "request for assistance".

> <span style="color:grey">_[taps shoulder]_</span> Dude can you grill me on this plan?

Not scheduling a meeting.

**That's the whole design. Not a swarm, not a company. *A room.***

## Install

Requires Pi 1.1.0 or newer.

```sh
pi install npm:@giladbarnea/pi-simple-team
```

Communication skills from [`soft-skills`](https://www.npmjs.com/package/soft-skills) are included and available through Pi's normal skill discovery.

## Using `pi-simple-team`

Tell your main agent:
> Spawn a team.

That's it. The team takes the shape of the mission:

You:
> Create an implementer-reviewer team to complete `PLAN.md`.

Main agent:
> Created an `implementer` and `reviewer` loop:
> - `implementer` will keep fixing until `reviewer` is satisfied.
> - I will let you know when they are done.

[![A team appears, receives direction, and starts working](https://raw.githubusercontent.com/giladbarnea/pi-simple-team/main/screenshots/abstract-tool-output-preview-640.png)](https://raw.githubusercontent.com/giladbarnea/pi-simple-team/main/screenshots/abstract-tool-output-preview.png)

<div align="center"><em>Spawn, direct, and follow a team from the normal Pi conversation.</em></div>

<br>

<details>
<summary><strong>pi-simple-team screenshots</strong></summary>

<br>

[![Status outputs for several parallel teams](https://raw.githubusercontent.com/giladbarnea/pi-simple-team/main/screenshots/team-status-multiple.png)](https://raw.githubusercontent.com/giladbarnea/pi-simple-team/main/screenshots/team-status-multiple.png)

[![Event log outputs for two parallel teams](https://raw.githubusercontent.com/giladbarnea/pi-simple-team/main/screenshots/team-log-multiple.png)](https://raw.githubusercontent.com/giladbarnea/pi-simple-team/main/screenshots/team-log-multiple.png)

</details>

### Watch a live team with `/team`.

`/team` is for you, not another agent tool. It gives you a live view of the room without turning the main agent into a status relay.

The command opens an overlay rolling recent statuses, messages, and a separate event log.

Up/Down select the messages or log widget. Enter zooms it to the full overlay. Esc goes back.

[![The live team dashboard showing statuses, messages, and recent events](https://raw.githubusercontent.com/giladbarnea/pi-simple-team/main/screenshots/team-view.png)](https://raw.githubusercontent.com/giladbarnea/pi-simple-team/main/screenshots/team-view.png)

<div align="center"><em>The live, read-only <code>/team</code> dashboard.</em></div>


## The mechanics

### 🏋️ Woken up when needed. Works freely otherwise.

**Tokens, intelligence and time are never wasted on busy-polling for messages.**

Instead, `pi-simple-team` pushes messages to the recipients.

This is both efficient and effective:

- ✔ No inbox to forget.
- ✔ Context window stays lean.
- ✔ Unlocks arbitrary workflows.

### ⚡ Messages arrive _fast_.

- Sub-second, when the recipient is idle.
- The moment the current bout of work ends, when busy.

### 🟢 Statuses everyone can see.

For free, at any time. Like setting a Slack status.

Teammates publish a one-liner:

> <span style="color:grey">implementer  </span> Done, 89 tests green, awaiting review.

> <span style="color:grey">reviewer      </span> Reading implementation, will finalize review in a few minutes.

Your main agent calls `team_status` and understands exactly what is going on. Main does not ask teammates for updates or clutter their context.

### 🌡️ Context window self-awareness

**The team manages its own context:**

Teammates know how much free context they have left.

Main agent knows its own and everyone else's too. You see it as well: team tool results show the last reported context use beside each teammate they involve, such as `Team Send → builder ▆72% context`.

They will hand off work autonomously when it's time to say goodbye.

You can stop babysitting context windows.

### 📣 Interrupts, when justified.

> _Situation: Late afternoon. Team finished production hotfix and started wrap up. There is one problem though._

- 17:32:00: `security-guard` spots a private SSH key not covered by `.gitignore`.
- 17:32:01: `release-owner` sets status: _Ran `git add .`, preparing commit and push._
- 17:32:02: `security-guard` immediately interrupts `release-owner`. Key never leaves the machine. Developer keeps their job another day 👍

### 📡 Live, zero-cost observability 

Your main uses `team_log` when it needs to understand the chain of events in high granularity.

Provides main a timestamped, filterable, append-only record of the team’s messages, tool calls, and lifecycle events.
Attempts can end before retries finish. A separate run row reports final settlement as ended or cancelled. Ended does not imply success.
A run that ends on a provider error adds an error row with the provider's message and sets the teammate's status to `error` with that message, until a later run completes. Main also gets a message saying so.
A background teammate that exits without being stopped, after it registered, also sends main a message with its exit code. A teammate that quits itself (exit code 0) does not.
A Herdr pane teammate gets the same messages. If its process dies, main is told that it exited. If it is idle when its pane is closed, or it receives SIGHUP or SIGTERM, main gets a neutral message that names the signal, because either can be on purpose. A pane closed while its teammate works usually ends Pi at once, so main is told that it exited. A restart closes the teammate's previous pane. A pane that main closes itself sends nothing.

### 🌅 Herdr Support

`pi-simple-team` can open a teammate direct Pi session in a dedicated [Herdr](https://herdr.dev) pane. Just ask your main agent to do that.

- Live view of the room.
- Talk directly with teammates.

  I recommend starting with “Captain here”. Feels good and the surprise on their faces is priceless.

### 🧱 Teammates are durable Pi sessions.

A teammate is just a Pi session with a team attachment.

This means **teammates (and thus, teams) survive shutdown.**

Have a teammate do work, exit Pi entirely, come back tomorrow in a brand-new session, and ask main to get you that teammate by its Pi session id. Everything it learned stays intact.

You can even `/resume` a teammate session directly if you ever want a cozy one-on-one, or run `pi --session <teammate-session-id>`.

Every teammate session records which main session and team started it, in one `pi-simple-team-teammate` custom entry that the model and the TUI never see. Its `sessionId` is the session it was written in, so a later `pi --fork` of a teammate carries a copy you can tell is inherited.

## 🪾 It’s teams all the way down (optionally)

Tell main you want to **have a teammate manage its own team(s).**

This is a powerful technique to create a **separate layer of context.**

That teammate will spawn, steer and observe its own team(s) without costing tokens to its siblings or parent.

The tradeoff, like any higher-order delegation, is reduced control: you are moved one level further away from the trenches.

This is opt-in: teammates by default can't create teams.

This technique plays even nicer if your main assumes the captain rank[^1].

---

## 🧬 Graphs engineer themselves

**Because** it does nothing special, `pi-simple-team` can **construct any agentic graph you need.**

Tell main:
> 1. Break `PLAN.md` into a task graph. Include loops with success criteria and run independent tasks in parallel.
> 2. Create a team that carries out that task graph.

Or give main a concrete team goal:
> **Team goal:**
> 1. Map the database for all customer ⟷ purchases money streams.
> 2. Feed the new knowledge into the memory layer.
> 3. Make the data analysis agent pass the new purchases evals. 
> 
> **Note:**
> - #1 is a **saturation loop.** Stop only when you can't find anything new. 
> - #3 is a **hill-climbing loop.** Stop only the evals are green.
> - Teammates #1 and #3 create their own teams to loop until task is complete.

That prompt creates this graph:

![The team graph: 1-map (Scout and Devil’s advocate) feeding subagent dispatch, feeding 3-eval (Engineer and Performance watcher)](https://raw.githubusercontent.com/giladbarnea/pi-simple-team/main/screenshots/team-graph.png)

## Tools

Kept minimal:


| Role | For | Tools |
| --- | --- | --- |
| **Main agent** | Team lifecycle | `team_spawn`, `team_list`, `team_resume`, `team_add_teammates`, `team_update_teammates`, `team_shutdown` |
| | With team | `team_send_message` |
| | On team | `team_status`, `team_log` |
| | On everyone | `get_context_window_usage` |
| | On self | `schedule_reminder`, `list_reminders`, `cancel_reminders` |
| **Managing teammate** | On self and own teams | Same tools as the main agent |
| | With parent team | `team_send_message`, `team_status`, `send_main_message` |
| **Teammates** | With team | `team_send_message` |
| | With main | `send_main_message` |
| | On self | `get_context_window_usage` |
| **Everyone** | For everyone | `team_status` |

`team_spawn`, `team_resume`, and `team_add_teammates` start work automatically once every affected teammate is ready. With `startIdle: true`, their briefings wait in context without starting work.

Startup delivers `commonPrompt` inside `<team-system-message>` and each teammate's `systemPrompt` inside `<your-specific-system-message>`. These are labels in the custom team message, not system-role overrides. The briefing also contains the teammate's identity and coordination guidance.

When main quits, reloads or crashes, its teams stop. When that main session starts again, Simple Team reattaches the teammates that were running, idle and in their own conversations, without sending them anything or making a model request. Main gets one message listing them and which were working, so it can tell those to continue. Teams stopped with `team_shutdown`, or left by switching main to another session, stay stopped. After a crash, a Herdr pane teammate may still be running in its pane, so it is listed instead of reattached.

Resume appends a custom briefing with the team identity, current time, and last recorded model activity. Optional `resumptionPrompt` instructions follow that briefing without changing saved definitions. With `startIdle: true`, the briefing waits in context for the next turn.

Existing teammates can be selected by name or Pi session ID in the same input field. Messages, logs, and context usage share a `targets` list. Select a team for all its teammates, or select individual teammates across your teams. Ambiguous names return IDs you can use instead.

`team_update_teammates` changes a live teammate's model, thinking level or extensions in its own conversation. An idle teammate restarts at once, in its pane if it has one; a busy one keeps working and is updated when its run settles, or at once with `interrupt: true`. A managing teammate is never held: while it or any of its own teammates works, the call fails and tells main to ask it to soft-pause them, and the same call succeeds once they are idle. The restarted teammate gets a message with its new settings and the teams its restart stopped, so it can resume them. Main gets a message when a held update applies; `team_shutdown` lists any it drops. `team_resume` takes the same changes in `teammateUpdates` for the teammates it resumes. Instructions and `forkContext` stay as created.

`team_list` shows active teams as short rows, newest created first, 20 per page by default (`limit` up to 100, then `cursor`). Pass `includeDormantTeams: true` to include dormant teams, or `team` for one team's full records. Pages follow creation order, so a team that changes state or activity between pages is neither repeated nor skipped.

Reminders are recorded in the session, so they survive `/reload` and restarts of that session. One that fell due while Pi was not running fires on start and says how late it is.

`list_reminders` shows this session's pending reminders with their IDs, slugs and times. `cancel_reminders` cancels reminders by ID or slug, or every pending one with `all: true`; a call with neither cancels nothing.

Spawn, resume, and add return the complete roster. Results distinguish a live runtime from active work, including work that was already underway before the call.

Set `showOnHerdrPane: true` on individual teammates to open their panes. An explicit `showOnHerdrPanes` value on spawn overrides all individual settings.

`extensionPaths` lists trusted, existing absolute extension paths for one teammate. RPC and Herdr launches load them alongside the team runtime and the extensions a plain `pi` launch in the project discovers, and resume keeps them. The parent's own command-line `-e` extensions and `--no-extensions` are not inherited. An `extensionPaths` entry at a different path from a discovered copy of the same extension stops teammate startup when that extension registers tools or flags. The same path, or a symlink to it, loads once. These modules run with the same permissions as Pi.

Message tools return `published: true` when the extension accepts a message for delivery. If delivery later fails, the sender receives the error automatically.


---


## Roadmap

**User involvement track:**

- [x] Herdr panes for teammates.
- [x] `/team`: live, read-only team dashboard.
- [ ] Teammate drill-down and transcripts.
- [ ] Joining and steering teams from slash commands.
- [ ] Adding teammates to existing teams directly from slash commands.
- [ ] Spawning teams directly from slash commands.

**Functional:**

- [x] Resume all or selected teammates from a dormant team.
- [x] Add teammates after a team has spawned.
- [x] Let opted-in teammates create and manage teams of their own.
- [ ] Remove teammates from a team.
- [ ] Main triggers `/compact` on select teammate.
- [ ] Teammates auto-reminded to hand off on low context.

---

[^1]: [Captain](https://github.com/giladbarnea/soft-skills/blob/main/plugins/soft-skills/skills/ai-to-delegated/coordination/leading-leaders.md) in the `ai-to-delegated` skill.

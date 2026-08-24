<img src="screenshots/pi-simple-team-banner.png" alt="A dark wireframe room in a starry void" width="100%">

<div align="center">

# pi-simple-team

> **The team extension with no features.**

<p align="center">
  <a href="https://github.com/earendil-works/pi"><img alt="Pi extension" src="https://shieldcn.dev/badge/pi-extension.svg?variant=outline" /></a>
  <a href="https://www.npmjs.com/package/@giladbarnea/pi-simple-team"><img alt="npm version" src="https://shieldcn.dev/npm/%40giladbarnea%2Fpi-simple-team.svg?variant=outline" /></a>
  <a href="https://github.com/giladbarnea/pi-simple-team/actions/workflows/test.yml"><img alt="test status" src="https://shieldcn.dev/github/ci/giladbarnea/pi-simple-team.svg?workflow=test.yml&amp;branch=main&amp;variant=outline" /></a>
  <a href="LICENSE"><img alt="license" src="https://shieldcn.dev/github/license/giladbarnea/pi-simple-team.svg?variant=outline" /></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript" src="https://shieldcn.dev/badge/typescript.svg?logo=typescript&amp;variant=outline" /></a>
  <a href="https://bun.sh/"><img alt="tested with Bun" src="https://shieldcn.dev/badge/tested_with-Bun.svg?logo=bun&amp;variant=outline" /></a>
</p>

**No roles. No org chart. No mailboxes. No routing rules.**

**`pi-simple-team` spawns a small team of Pi agents that can all talk to each other**, like the responsible adults they are, **and then stays out of the way.**

</div>


## Why

**The best kind of work happens when a bunch of people work together in a room. Not an corporate organization, not a swarm. *A room.***

> — <span style="color:grey">_[shouts]_</span> Has anyone figured out how to set up auth yet?

Yes:
> — <span style="color:grey">_[talks normally]_</span> Dude, no need to yell. And yes, I can help. Let me show you real quick...

Not:
> — <span style="color:grey">_[37 minutes later, by email]_</span> *Yes, please schedule a meeting for next Tuesday.* 

**That's the whole design. *A room.***

## Install

```sh
pi install npm:@giladbarnea/pi-simple-team
```

## Using `pi-simple-team`

Tell your main agent:
> Spawn a team.

That's it. 

### Takes the shape of the mission

You:
> I want an adversarial team completing `PLAN.md`.

Main agent:
> Created an `implementer` and `reviewer` loop:
> - `implementer` will keep fixing until `reviewer` is satisfied.
> - I’ll let you know when they're done.

[![A team appears, receives direction, and starts working](screenshots/abstract-tool-output-preview-640.png)](screenshots/abstract-tool-output-preview.png)

_Spawn, direct, and follow a team from the normal Pi conversation._

<br>

<details>
<summary><strong><code>pi-simple-team</code> screenshots</strong></summary>

<br>

<p align="center">
  <a href="screenshots/team-status-multiple.png"><img src="screenshots/team-status-multiple.png" alt="Status outputs for several parallel teams"></a>
  </p>
  <p align="center">
  <a href="screenshots/team-log-multiple.png"><img src="screenshots/team-log-multiple.png"  alt="Event log outputs for two parallel teams"></a>
</p>

</details>

---

### Watch a live team with `/team`.

`/team` is for you, not your agent. It gives you a **live view** of the room without needing to nag your main agent for updates.

The command opens an **overlay rolling recent statuses, messages, and a separate event log.**

<a href="screenshots/team-view.png">
  <img src="screenshots/team-view.png" width="100%" alt="The live team dashboard showing statuses, messages, and recent events">
</a>

<div align="center"><em>The live, read-only <code>/team</code> dashboard.</em></div>

**Widgets are zoomable**

`Up/Down` select the _Messages_ or _Log_ widget. `Enter` zooms it to the full overlay to understand in greater detail. `Esc` goes back.

## The mechanics

### 🏋️ AI’s woken up when needed. Get stuff done otherwise.

**Tokens, intelligence and time are never wasted on busy-polling for messages.**

Instead, everyone _pushes_ messages to each other.

This applies to the main agent and teammates alike.

**This is both efficient and effective:**

- ✓ 100% of the context window is spent on *real work*.
- ✓ No inbox to forget.
- ✓ Unlocks **arbitrary workflows.** (More on [drawing AI graphs](#-its-teams-all-the-way-down-optionally) below.)

---

### ⚡ Messages arrive _fast_.

- Sub-second, when the recipient is idle.
- ASAP, when the receipient is the middle of tool call.

---

### 🟢 Statuses everyone can see.

For free, at any time. Same as setting status on Slack.

Teammates publish a one-liner:

> <span style="color:grey">implementer  </span> Done, 89 tests green, pinged _reviewer_.

> <span style="color:grey">reviewer      </span> Studying implementation, will message _implementer_ my review when I’m done.

Or even:

> <span style="color:grey">first-mate     </span> _implementer_ ran out of context. Resuming its work with a new _implementer-2_.

**Everyone’s status is available to everyone else.**

- No tapping on shoulder to ask for status.
- Your main agent has a birdseye view.
- Teammates know to not step on each other’s toes.

---

### 🌡️ Context window self-awareness and recovery

**The team is responsible for its own context:**

- Teammates know how much free context they have left at any given moment.
- Main agent knows its own window and everyone else’s too.

**Teammates hand off work autonomously when it’s time to say goodbye.**

You can stop babysitting context windows.

---

### 📣 Interrupts, when justified.

> _Situation: Late afternoon. Team finished production hotfix and started wrap up. There is one problem though._

- 17:32:00: `security-guard` spots a private SSH key not covered by `.gitignore`.
- 17:32:01: `release-owner` sets status: _Ran `git add .`, preparing commit and push._
- 17:32:02: `security-guard` immediately interrupts `release-owner`. Key never leaves the machine. Developer keeps their job another day 👍

---

### 📡 Live, zero-cost observability.

Your main uses _Team Log_ when it needs to understand the chain of events in high granularity.

_Team Log_ provides main a timestamped, filterable, append-only record of the team’s actions: messages, tool calls, lifecycle events, and everything else.

This is powerful when your main needs to unblock the team, troubleshoot connectivity issues, etc.

---

### 🌅 Herdr Support.

`pi-simple-team` can open a teammate direct Pi session in a dedicated [Herdr](https://herdr.dev) pane. Just ask your main agent to do that.

- Live view of the room.
- Talk directly with teammates.

Tip: I recommend starting with “Captain here”. Feels good and the look on their faces is priceless.

---

### 🧱 Teammates are durable Pi sessions.

**A teammate is just a Pi session** with a team attachment.

This means **teammates (and thus, teams) survive shutdown.**

Have a teammate do work. Exit Pi entirely. Wake up the next day and start a brand-new session. Ask your main to get you that teammate from yesterday by its Pi session id. Its context window stays intact.

You can even `/resume` a teammate session directly if you ever want a cozy one-on-one (or run `pi --session <teammate-session-id>`.)

## 🪾 It’s teams all the way down (optionally)

Tell main you want to **have a teammate manage its own team(s).**

This is an additional level of delegation. It creates an **extra layer of context headroom.**

That manager teammate is simply the main agent to its child teams. 

The tradeoff, like any higher-order delegation, is reduced control: you are moved one level further away from the trenches.

This is opt-in: teammates by default can’t create teams.

This technique plays even nicer if your main assumes the captain rank[^1].

## 🧬 Graphs engineer themselves

**Because** it does nothing special, `pi-simple-team` allows your main agent to **construct any agentic graph you wish.**

#### YOLO it:

Tell main:
> 1. Break down `PLAN.md` to a task graph.
>    Include loops with success criteria. Fan out tasks in parallel when possible.
> 2. Create a team that _acts_ that task graph.

That’s it. Teammates know when to wait and to whom. They know when it’s their turn and who to deliver the results to.

#### Design it:

Tell main:
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

![The team graph: 1-map (Scout and Devil’s advocate) feeding subagent dispatch, feeding 3-eval (Engineer and Performance watcher)](screenshots/team-graph.png)

## Tools

Kept minimal:


| Role | For | Tools |
| --- | --- | --- |
| **Main agent** | Team lifecycle | `team_spawn`, `team_list`, `team_resume`, `team_add`, `team_shutdown` |
| | With team | `teamsend` |
| | On team | `teamstatus`, `teamlog` |
| | On everyone | `report_context_window` |
| **Overseeing teammate** | On own teams | Same tools as the main agent |
| | With parent team | `teamsend`, `teamstatus`, `teammain` |
| **Teammates** | With team | `teamsend` |
| | With main | `teammain` |
| | On self | `report_context_window` |
| **Everyone** | For everyone | `teamstatus` |


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
- [x] Remove teammates from a team.
- [ ] Main triggers `/compact` on select teammate.
- [ ] Teammates auto-reminded to hand off on low context.

---

[^1]: `skills/ai-to-delegated/references/leading-leaders.md`

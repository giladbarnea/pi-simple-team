<img src="screenshots/pi-simple-team-banner.png" alt="A dark wireframe room in a starry void" width="100%">

<div align="center">

# pi-simple-team

> **The team extension with no features.**

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi)
[![npm version](https://img.shields.io/npm/v/%40giladbarnea%2Fpi-simple-team?logo=npm)](https://www.npmjs.com/package/@giladbarnea/pi-simple-team)
[![tests](https://img.shields.io/github/actions/workflow/status/giladbarnea/pi-simple-team/test.yml?branch=main&label=tests&logo=github)](https://github.com/giladbarnea/pi-simple-team/actions/workflows/test.yml)
[![license](https://img.shields.io/github/license/giladbarnea/pi-simple-team)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![tested with Bun](https://img.shields.io/badge/tested_with-Bun-14151A?logo=bun&logoColor=white)](https://bun.sh/)

**No roles. No org chart. No mailboxes. No routing rules.**

`pi-simple-team` spawns a flat team of Pi agents that can all talk to each other, like the responsible adults they are, **and then stays out of the way.**

</div>

---


## Why

I've always done my best work in a small room with a few capable people, building something together.

> <span style="color:grey">_[shouts]_</span> Has anyone figured out how to set up auth yet?

Not filing a "request for assistance".

> <span style="color:grey">_[taps shoulder]_</span> Dude can you grill me on this plan?

Not scheduling a meeting.

**That's the whole design. Not a swarm, not a company. *A room.***

## Using `pi-simple-team`

Tell your main agent:
> Spawn a team.

### Watch a live team with `/team`.

`/team` is for you, not another agent tool. It gives you a live view of the room without turning the main agent into a status relay.

The command opens a read-only overlay with recent statuses, messages, and a separate event log. With no teams, it shows an empty state. With one team, it opens that team directly. With several teams, it starts with a selector.

The fixed layout keeps the latest content in view as work arrives, without scrolling or jumping around. It is an overview of the room, not a teammate drill-down or transcript.

### Throw a team at something hard.

The team takes the shape of the mission.

**Basic example: adversarial pair**

You:
> Create an implementer-reviewer team to complete `PLAN.md`.

Main agent:
> Pair created. They'll loop through it together. They'll let me know when they're done.

<br>

**Better example: build an agentic graph**

You:
> **Team goal:**
> 1. map out all customer–product money streams in the database.
> 2. Feed this knowledge into the harness.
> 3. Then prove the data analysis agent passes the new evals.
> 
> **Note:**
> - #1 and #3 are _loops._ Call them `1-map` and `3-eval`.
> - `1-map` and `3-eval` each gets a teamate.
> - Each teammate spawns _its own team_ to loop on its task.

<br>

<center>
<b>Because</b> it does nothing specially, <code>pi-simple-team</code> can construct any topography you wish it to.
</center>
<br>
That prompt gives you this graph:

```mermaid
flowchart LR
    subgraph map["1-map: map the money streams"]
        scout["`**Scout**
Runs repeatedly to clear
out the fog of war.`"] <--> advocate["`**Devil’s advocate**
Points out what we
still don’t know.`"]
    end

    harness["`**2: subagent dispatch**
Feeds new understanding
into the harness.`"]

    subgraph eval["3-eval: hill-climb the evals"]
        engineer["`**Engineer**
Improves the harness.`"] <--> watcher["`**Performance watcher**
Suggests a fresh approach
when stuck. `"]
    end

    map --> harness --> eval
```

<br>

---

<br>

![Spawning a designer–adversary team, checking its status, and sending both teammates a shared instruction](screenshots/1.png)

<div align="center"><em><code>pi-simple-team</code> in the TUI.</em></div>

## The mechanics

### 🏋️ Woken up when needed. Works freely otherwise.

Tokens, intelligence and time are never wasted on busy-polling for messages.

Instead, `pi-simple-team` pushes messages to the receipients.

This is both efficient and effective:

- ✔ No inbox to forget.
- ✔ Context window stays lean.
- ✔ Unlocks teams doing arbitrary workflows.

*{screenshot of Codex filling up the entire visible chat with countless* `Waiting agents to finish...`*}*

### ⚡ Messages arrive _fast_.

- Sub-second, when the recipient is idle.
- The moment the current bout of work ends, when busy.

### 🟢 Statuses everyone can see.

Teammates publish a one-liner:

> <span style="color:grey">implementer  </span> Done, 89 tests green, awaiting review.

> <span style="color:grey">reviewer      </span> Reading implementation, will finalize review in a few minutes.

Your main agent calls `teamstatus` and understands exactly what's going on. Main doesn't ask and clutter the teammates' context.

### 🌡️ Context window self-awareness

Teammates know how much free context they have left.

Main agent knows its own and everyone else's too.

### 📣 Interrupts, when justified.

> _Situation: Late afternoon. Team has finished a production hotfix and started to wrap up._

- 17:32:00: Security scout spots a private SSH key not covered by `.gitignore`.
- 17:32:01: Release teammate sets status: "Ran `git add .`, preparing commit and push."
- 17:32:02: Scout immediately interrupts. Key never leaves the machine. Developer keeps their job.

### 📡 Complete observability by design.

The main agent can access one exhaustive, **timestamped history** of tool calls, messages, and lifecycle events, **recorded by the harness itself.**

Main can filter and page that shared timeline on demand.

Useful for tracing a failure *across* teammates—without asking anyone to reconstruct it from memory.

<br>

![A live team status map above its timestamped event log](screenshots/2.png)
<div align="center"><em>Visual representation of the team log.</em></div>

### 🪟 Herdr Mode

`pi-simple-team` can give each teammate a Pi session in its own [Herdr](https://herdr.dev) pane. Just ask your main agent to do that.

- Live view of the room.
- Talk directly with teammates.


## Install

```sh
pi install npm:@giladbarnea/pi-simple-team
```



## Tools


Kept minimal:


| Role           | For            | Tools                         |
| -------------- | -------------- | ----------------------------- |
| **Main agent** | Team lifecycle | `team_spawn`, `team_shutdown` |
|                | With team      | `teamsend`                    |
|                | On team        | `teamstatus`, `teamlog`       |
|                | On everyone    | `report_context_window`       |
| **Teammates**  | With team      | `teamsend`                    |
|                | With main      | `teammain`                    |
|                | On self        | `report_context_window`       |
| **Everyone**   | For everyone   | `teamstatus`                  |


---



## Roadmap

**User involvement track:**

- [x] Herdr panes for teammates.
- [x] `/team`: live, read-only team dashboard.
- [ ] Teammate drill-down and transcripts.
- [ ] Joining and steering teams from slash commands.
- [ ] Spawning teams directly from slash commands.

**Functional:**

- [ ] Add new teammates after team has spawned.
- [ ] Main forces `/compact` on select teammate.

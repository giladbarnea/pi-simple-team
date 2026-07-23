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

The best work I've ever done happened in a small room with a few capable people, building something together.

Yell out "has anyone figured out the auth service yet?" instead of filing a "request for assistance".

Tap the person next to you and ask them to grind you on your idea.

**That's the whole design. Not a swarm, not a company. *A room.***

## Using `pi-simple-team`

Ask your main agent for a team.

**Throw a team at something important.**

**You:** "Create an implementer–reviewer team to complete `PLAN.md`."  
**Main:** "Created the pair. They'll work through it together; They'll let me know when they're done."

**Map the unknown together.**
<!-- The particular business is too specific (custom insoles...). Let's make it more typical developer day-to-day pain. -->
**You:** "Find how to double retention among custom-insole customers who started physical therapy. The database is unmapped."  
**Main:** "Created a discovery team. They'll trade clues and redirect each other as the map emerges."

<br>

![Spawning a designer–adversary team, checking its status, and sending both teammates a shared instruction](screenshots/1.png)

<div align="center"><em><code>pi-simple-team</code> in the TUI.</em></div>

## The mechanics

### Push, not pull.

- ✔ No inbox to forget.
- ✔ no polling to exhaust your context window.

_{screenshot of Codex filling up the entire visible chat with countless `Waiting agents to finish...`}_

### Messages land like the ones you send your own agent:   <!--sentence too long, twisty structure-->

- ⚡ Sub-second, when the recipient is idle.
- 🏎️ The moment the current bout of work ends, when busy.

### Statuses everyone can see.

Teammates publish a one-liner:
- "Done, 89 tests green, awaiting review".
- "Reading implementation, will finalize review in a few minutes"

Your main agent calls `teamstatus` and understands exactly what's going on without asking and cluttering the teammates' context.

### Interrupts, when the situation calls for it.

<!-- I want to replace the subject of this section to something that isn't an implementer-reviewer, which has been used a few times already. But i need it to preserve the punchiness, high stakes, "phew, just in time" factor, and tone. -->
_Team has finished implementing and have started to wrap up._

- Live reviewer spots a private SSH key not covered by .gitignore.
- Implementer's sets status: "Preparing commit message".
- Reviewer immediately interrupts Implementer. Key never left the machine. Developer keeps their job.

### Complete observability by design.

The main agent can access one exhaustive, **timestamped history** of tool calls, messages, and lifecycle events, **recorded by the harness itself.**

Main can filter and page that shared timeline on demand.

Useful for tracing a failure _across_ teammates—without asking anyone to reconstruct it from memory.

<br>

![A live team status map above its timestamped event log](screenshots/2.png)

## Install

```sh
pi install npm:@giladbarnea/pi-simple-team
```

## Tools
<!-- Honestly I'm not sure this section deserves its place. It's a rather sharp turn from the rest of the doc to implementation details. -->

Kept minimal:

| Role           | For            | Tools                         |
| -------------- | -------------- | ----------------------------- |
| **Main agent** | Team lifecycle | `team_spawn`, `team_shutdown` |
|                | With team      | `teamsend`                    |
|                | On team        | `teamstatus`, `teamlog`       |
| **Teammates**  | With teammates | `teamsend`                    |
|                | With main      | `teammain`                    |
|                | With everyone  | `teamstatus`                  |

---

## Roadmap

### User involvement track

Slash commands:
- [ ] 💠 Live control panel.
- [ ] 👋 Joining and steering teams.
- [ ] 🪄 Spawning teams directly.

# pi-simple-team

> The team extension with no features.

No roles. No org chart. No mailboxes. No routing rules.

`pi-simple-team` spawns a flat team of Pi agents that can all talk to each other, **and then stays out of the way.**

## Why

The best work I've ever done happened in a small room with a few capable people, building something together.

Yell out "has anyone figured out the auth service yet?" instead of filing a "request for assistance".

Tap the person next to you and ask them to grind you on your idea.

Nobody's nervous around the CEO. You started the thing together.

That's the whole design. Not a swarm, not a company. *A room.*

## The mechanics

The team is *live*.

Teammates react to each other, know what everyone else is on, and take the shape of the task — because no shape is imposed on them.

#### Push, not pull.

No inbox to forget, no polling to exhaust your context window. 

Messages land like the ones you send your own agent:

- Sub-second, when the recipient is idle.
- The moment the current bout of work ends, when busy.

#### Interrupts, when the situation calls for it.

The scout spots a private SSH key not covered by .gitignore. The implementer's status: "preparing commit message". One interrupt later, the key never leaves the machine.

#### Statuses everyone can see.

Teammates publish a one-liner — "done, awaiting review". Your main agent reads the map instead of interviewing the team.

#### Work in the open.

Every team action lands in a timestamped, filterable log. Main agent reads it to catch up rather than calling a status meeting.

#### Teams shaped by the task.

One shared briefing, an individual prompt per teammate. Flat by default; if the task wants a reviewer gate or a lead, your main agent prompts it into being — that's a sentence, not a framework.

## Tools

| Where        | Tools                                                                        |
| ------------ | ---------------------------------------------------------------------------- |
| Main session | `team_spawn`, `teamsend`, `teamstatus`, `teamlog`, `team_shutdown`           |
| Teammates    | `teamsend` (anyone → anyone, optional `interrupt`), `teammain`, `teamstatus` |

## Install

```sh
pi install npm:@giladbarnea/pi-simple-team
```

That's it.

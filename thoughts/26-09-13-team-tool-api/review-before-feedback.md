# pi-simple-team tool API

Review draft. This page includes every tool, its input signature, and its agent-facing prose. It applies the requested API changes to the current definitions in `index.ts`, `child-tools.ts`, and `model-preflight.ts`. The runtime has not changed yet.

`description` is sent with the callable tool definition. `promptSnippet` supplies a line in Pi's default system prompt under “Available tools”. These fields have different destinations, so a shorter snippet can be intentional. Pi also supports `promptGuidelines`, but this extension does not set it. No separate `additionalPrompt` field exists in these definitions.

Teammates use a custom system prompt. In the installed Pi version, that path bypasses the default “Available tools” list. Their tool descriptions still exist, but their snippets are not automatically included through that list.

Comments inside signatures represent parameter descriptions. A question mark means the field can be omitted. Identical prose appears once, ignoring a final period. Each differing pair has an assessment of whether its difference looks intentional or arbitrary. These assessments are inferences from the code, not recorded design decisions.

Main has all manager tools below. A teammate with `canManageOwnTeams: true` also has manager tools for its own teams. Every teammate has the member tools. Role-specific differences appear under each tool.

## What the model receives after a call

Yes. Every tool returns a result to the model. The output sections below document the **current implementation**, under the proposed tool names. Output keys and quoted errors retain their current spelling. New input features do not yet have implemented return behavior.

Most success results contain pretty-printed JSON in one text block. The extension also stores that object in `details` for Pi's renderers. The model-facing text is separate from the colored terminal display. There is no extra success sentence unless shown below.

`report_context_window` returns prose. `teamlog` returns a text table. `team_spawn` embeds a skill-reading instruction in its JSON result.

For an exception, Pi returns the exception's message in a text block and marks the tool result `isError: true`. There is no common error JSON schema, stack trace, or generic failure preamble. Input-schema validation failures also become error results before the tool executes. Other installed extensions can intercept results; this page describes this extension's output and Pi's normal error handling.

When a teammate calls a parent-owned endpoint, HTTP failures gain a wrapper. For example:

```text
team runtime rejected teamsend: 500 {"error":"Unknown teammate(s) in review: missing"}
```

Network failures use the underlying network error text. The failure examples under each tool are representative, not an exhaustive list of operating-system errors.

The output shapes below use these shared types. They describe the JSON text, not an extra typed object sent separately to the model.

```ts
type Status = {
  word: string;
  phrase: string;
  updated: string; // ISO timestamp
};
type StatusMap = Record<string, Status>; // Participant names, including main
type SessionIdentity = { sessionId: string; sessionFile: string };
type SessionMap = Record<string, SessionIdentity>; // Teammate names
```

## Shared input types

```ts
type TeamNameOrID = string;
type TeammateNameOrID = string;
type ThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";

type Teammate = {
  // Teammate name. "main" is reserved. Names must be unique within a team.
  name: string;

  // Individual teammate system prompt.
  prompt: string;

  // Canonical provider/model ID for this teammate.
  // team_spawn appends the model guidance shown below.
  model: string;

  // Thinking level for this teammate. Defaults to xhigh.
  thinking?: ThinkingLevel;

  // Start from a fork of main's persisted session.
  // The fork is taken during asynchronous child startup. Defaults to false.
  inheritMainContext?: boolean;

  // Allow this teammate to create and manage teams of its own.
  // Defaults to false.
  canManageOwnTeams?: boolean;

  // Run this teammate in a visible Herdr pane. Defaults to false.
  showOnHerdrPane?: boolean;
};
```

The identifier aliases express the requested API. Existing code still resolves teammate targets by name. The mapping from teammate ID to a durable Pi session ID needs to be specified before implementation.

### Model guidance

`team_spawn` appends the same dynamic model guidance to its `description`, its `promptSnippet`, and each teammate's `model` parameter description. `team_add_teammates` does not currently append this guidance.

When the user has scoped models:

> You should probably use one of these user-scoped models: {comma-separated canonical provider/model IDs}.

When the user has not scoped models:

> The user has not defined a list of preferred models explicitly. Figure out which model _you_ are by reading the value of the PI_PROVIDER, PI_MODEL, and PI_REASONING_LEVEL environment variables. That should give you something to start with. Confirm with the user before picking any model id.

## team_spawn

Available to main and teammates that can manage their own teams.

```ts
team_spawn({
  // Name of the new team.
  teamName: string,

  // Common team system prompt.
  commonPrompt: string,

  // Teammates to spawn.
  teammates: Teammate[],

  // Run every teammate in a visible Herdr pane. Defaults to false.
  showOnHerdrPanes?: boolean,

  // Start teammates idle, waiting for a message. Defaults to false.
  // When false or omitted, teammates start work automatically.
  startIdle?: boolean,
});
```

**description**

> Spawn a persistent team of Pi teammates and start their work. All teammates must be ready before kickoff. Set `startIdle: true` to start teammates idle, waiting for a message. Teammates start with fresh context windows unless `inheritMainContext` is true. If the user is interested, set `showOnHerdrPanes` to run every teammate in a visible Herdr pane, or set `showOnHerdrPane` on individual teammates. The main agent (you) is included automatically; do not specify it as a teammate. {model guidance}

**promptSnippet**

> Spawn persistent Pi teammates and start their work unless `startIdle` is true. {model guidance} Unless required, don’t fill up your time by repeatedly busy-polling team information. Don’t bash sleep to wait for progress; instead, set your status to advertise that you are counting on teammates to send you important milestones or requests for help, and that otherwise you are staying idle. Send this actively to the team. Then end your turn by sending a simple message to the user, and finally stay put.

**Difference assessment: intentional.** The description explains setup and input behavior. The snippet adds instructions for what main should do afterward, especially avoiding polling. Repeating model guidance is redundant, but the two fields do different jobs.

Pane behavior in this draft: the team field enables panes for everyone. Otherwise, each teammate's field controls its own pane.

Kickoff starts turns after all teammates register and the team manifest is saved. It does not wait for completed work. The exact kickoff message is not specified here.

### Success output — current

JSON text:

```ts
{
  accepted: true,
  id?: string,
  team: string,
  teammates: string[],
  sessions: SessionMap,
  status: StatusMap,
  instruction: string,
}
```

The current result confirms registration, not work completion. New teammates currently have status `{ word: "idle", phrase: "Spawned", updated: "…" }`. Automatic kickoff is not yet implemented, so this page does not claim a new kickoff acknowledgment field.

The `instruction` value is the skill-reading prose reproduced at the end of this page.

### Failure output — current

Error text, for example:

```text
Duplicate teammate name(s): reviewer
"main" is reserved
Team already exists: {team ID}. Use team_resume.
inheritContext requires a persistent main session
showOnHerdrPanes requires HERDR_TAB_ID in the main Pi process
Timed out waiting for teammate reviewer to register
```

Model validation can return multiline prose:

```text
Model preflight failed:
- Model "provider/model" for teammate "reviewer" is not available.
```

Startup errors trigger team cleanup before the error returns. A child process exit can return `{name} exited (code={code}, signal={signal})`. Registry, lease, filesystem, and Herdr errors can also propagate.

## team_list

Available to main and teammates that can manage their own teams.

```ts
team_list({});
```

**description — main**

> List active and dormant teams for the current project.

**description — teammate that can manage its own teams**

> List active and dormant teams created by this overseeing teammate.

**promptSnippet — both**

> List teams for the current project

**Difference assessment:** main's difference looks intentional: the snippet is a short discovery label, while the description specifies active and dormant teams. For a managing teammate, the shared snippet looks like copy drift. It omits the ownership restriction and suggests project-wide access.

### Success output — current

JSON text:

```ts
{
  teams: Array<{
    id: string,
    name: string,
    state: "active" | "dormant",
    leaseState: "unclaimed" | "claimed" | "stale",
    teammates: string[],
    members: Array<{
      name: string,
      live: boolean,
      canOverseeOwnTeams: boolean,
      sessionId: string,
      sessionFile: string,
    }>,
    createdAt: string,
    updatedAt: string,
    shutdownAt?: string,
    expiresAt?: string,
  }>,
}
```

No teams is a success: `{ "teams": [] }`. There is no prose summary.

### Failure output — current

Error text, for example `team_list requires a project directory`, `team_list requires a persistent overseeing teammate session`, or `Invalid team manifest: {path}`. Invalid leases and filesystem failures can also return errors.

## team_resume

Available to main and teammates that can manage their own teams.

```ts
team_resume({
  // Team name or persistent ID.
  team: TeamNameOrID,

  // Stopped teammate names or IDs. Omit to resume all stopped teammates.
  // If supplied, the array must contain at least one target.
  teammates?: TeammateNameOrID[],

  // Resume selected teammates in visible Herdr panes. Defaults to RPC.
  showOnHerdrPanes?: boolean,
});
```

**description — main**

> Resume all stopped teammates in a dormant current-project team, or only selected stopped teammates.

**description — teammate that can manage its own teams**

> Resume all or selected stopped members of a dormant team created by this overseeing teammate.

**promptSnippet — both**

> Resume all or selected stopped teammates

**Difference assessment: intentional summary.** Both descriptions add scope and ownership rules to the shorter action label. The snippet is vague about a managing teammate's scope, but does not explicitly promise broader access.

Resume currently leaves the selected teammates idle. The requested automatic kickoff change is scoped to `team_spawn`.

### Success output — current

JSON text:

```ts
{
  accepted: true,
  id: string,
  team: string,
  teammates: string[],    // Entire team roster
  resumed: string[],      // Members started by this call
  restartedEmpty: string[],
  sessions: SessionMap,   // Members started by this call
}
```

`restartedEmpty` lists teammates whose provisional sessions never produced a saved file, so resume started fresh empty sessions. Already-live members are skipped. The call can succeed with `resumed: []`. There is no prose success sentence.

### Failure output — current

Error text, for example:

```text
Unknown current-project team: {name or ID}
Unknown teammate(s) in {team}: {names}
Team {ID} is already owned by another main session
Materialized session file for {name} is missing: {path}
```

Duplicate names, missing project/session state, lease conflicts, Herdr failures, and child startup failures also return errors.

## team_add_teammates

Renamed from `team_add`. Available to main and teammates that can manage their own teams.

```ts
team_add_teammates({
  // Team name or persistent ID.
  team: TeamNameOrID,

  // New teammates to add. Must contain at least one teammate.
  teammates: Teammate[],
});
```

**description**

> Add one or more new teammates to a running team owned by this session. Teammates use RPC unless their `showOnHerdrPane` field is true.

**promptSnippet**

> Add new teammates to a running team

**Difference assessment: intentional summary.** The description adds ownership and transport rules. The snippet states only the action.

Add currently leaves new teammates idle. The requested automatic kickoff change is scoped to `team_spawn`.

### Success output — current

JSON text:

```ts
{
  accepted: true,
  id: string,
  team: string,
  added: string[],
  sessions: SessionMap, // Newly added teammates
  status: StatusMap,   // Entire team
}
```

There is no prose success sentence.

### Failure output — current

Error text, for example `team_add requires a running team owned by this main session: {team}`, `Duplicate teammate name(s): {names}`, or `"main" is reserved`. Model, inherited-context, and startup errors use the same forms as spawn. Failed additions are stopped and removed from the running team.

## team_send_message

Renamed from `teamsend`. Available to everyone, with a role-specific signature.

### Main and teammates that can manage their own teams

```ts
team_send_message({
  // Main: team name or ID; optional only when exactly one owned team exists.
  // Managing teammate: owned team name or ID. Omit to use the parent team.
  team?: TeamNameOrID,

  // Recipient teammate names or IDs.
  to: TeammateNameOrID[],

  // Message to send.
  message: string,

  // true: abort all busy recipients before delivery.
  // Array: abort only these recipients; every value must also appear in `to`.
  // false or omitted: do not abort recipients.
  interrupt?: boolean | TeammateNameOrID[],
});
```

**description — main**

> Send a message from main to teammate(s). Fire-and-forget; does not wait for replies. Teammates will send you messages as they deem appropriate by way of push.

**description — teammate that can manage its own teams**

> Send to parent-team peers when team is omitted, or to teammates in an owned team when team is set. Fire-and-forget; does not wait for replies.

**promptSnippet — both**

> Send a message from main to teammate(s)

**Difference assessment:** main's difference looks intentional: the description explains asynchronous replies, while the snippet is a short action label. For a managing teammate, the snippet looks copied incorrectly. It says “from main” even when that teammate sends to parent-team peers.

### Ordinary teammate

```ts
team_send_message({
  // Recipient teammate names or IDs in this teammate's parent team.
  to: TeammateNameOrID[],

  // Message to send.
  message: string,

  // true: abort all busy recipients before delivery.
  // Array: abort only these recipients; every value must also appear in `to`.
  // false or omitted: do not abort recipients.
  interrupt?: boolean | TeammateNameOrID[],
});
```

**description**

> Send a message to teammate(s) (not main). To message the main agent, use teammain. Returns once the runtime accepts the send request, not after recipients reply.

**promptSnippet:** not defined.

### Success output — current, all roles

JSON text:

```ts
{
  accepted: true,
  team: string,
  from: string,    // "main" or the sending teammate's name
  to: string[],    // Resolved recipient names
  interrupt: boolean,
}
```

This acknowledges queuing. It does not confirm recipient delivery, a started turn, or a reply. The current output has a boolean `interrupt`. The proposed selective-interruption input does not yet have an implemented output representation.

### Failure output — current, all roles

Immediate failures return error text such as `Unknown team: {team}` or `Unknown teammate(s) in {team}: {names}`. Omitting the team when several exist produces `Multiple teams exist: {IDs}. Pass team explicitly.` Parent-endpoint errors gain the HTTP wrapper described above.

**A later delivery failure does not change the successful tool result.** It sets the recipient's status to `error` and adds a log entry. Example status phrases are `Teammate {name} is not ready` and `Timed out waiting for teammate {name} delivery`. The sender receives no separate automatic failure message from this path.

## teammain

Available to every teammate, including teammates that can manage their own teams. Sends to the main agent of their parent team.

```ts
teammain({
  // Message to send to the main agent.
  message: string,
});
```

**description**

> Send a message to the main agent.

**promptSnippet:** not defined.

### Success output — current

JSON text:

```ts
{ accepted: true, team: string, from: string, to: "main" }
```

The main agent receives a separate pushed message with content `[{team}/{sender}] {message}`. The sender's success result does not contain main's reply or extra prose.

### Failure output — current

Parent-runtime and network errors return error text. For example: `team runtime rejected teammain: 500 {"error":"Unknown team: {team}"}`. No common prose success/failure wrapper is added beyond the parent-runtime wrapper.

## teamstatus

Available to everyone, with a role-specific signature.

### Main and teammates that can manage their own teams

```ts
teamstatus({
  // Main: team name or ID; optional for listing all statuses,
  // or when exactly one owned team exists.
  // Managing teammate: owned team name or ID. Omit to use the parent team.
  team?: TeamNameOrID,

  // Set one-word gerund main status.
  gerund?: string,

  // Short main status verb-oriented phrase.
  phrase?: string,
});
```

**description — main**

> Set main's status for a team and/or read team statuses.

**description — teammate that can manage its own teams**

> Set or read parent-team status when team is omitted. Set or read an owned team's status when team is set.

**promptSnippet — both**

> Set/read team status maps

**Difference assessment:** for main, the wording difference looks arbitrary: “status maps” and “team statuses” describe the same action. For a managing teammate, the longer description intentionally explains which team is selected. The snippet loses that distinction but does not contradict it.

### Ordinary teammate

```ts
teamstatus({
  // Set one-word gerund status.
  gerund?: string,

  // Short status phrase. Verb-oriented.
  phrase?: string,
});
```

**description**

> Set your public status and read everyone's public status.

**promptSnippet:** not defined.

### Success output — current, all roles

For one team, JSON text:

```ts
{ team: string, status: StatusMap }
```

When main omits the team and both status fields, JSON text:

```ts
{ teams: Record<string, StatusMap> }
```

The record keys are team names. No teams gives `{ "teams": {} }`. A managing teammate's empty call reads its parent team instead. A status write returns the updated statuses, with no separate acknowledgment sentence.

### Failure output — current, all roles

Team-selection errors return text: `Unknown team: {team}`, `No teams exist. Use team_spawn first.`, or `Multiple teams exist: {IDs}. Pass team explicitly.` Parent-team calls can also return wrapped HTTP/network errors.

## report_context_window

Available to everyone, with a role-specific signature.

### Main

```ts
report_context_window({
  // Teammate names or IDs. Use an empty list to report only main.
  targets: TeammateNameOrID[],
});
```

**description**

> Report context-window use for selected teammates and main. Main's report is always last.

**promptSnippet**

> Report context-window use for selected teammates and main

**Difference assessment: intentional summary.** Main's description specifies the output order, which the snippet omits.

### Teammate that can manage its own teams

```ts
report_context_window({
  // Owned-team teammate names or IDs. Omit to report only yourself.
  targets?: TeammateNameOrID[],
});
```

**description**

> Report your own context-window use when targets is omitted. When targets is present, report selected teammates in owned teams and yourself last.

**promptSnippet**

> Report context-window use for selected teammates and main

**Difference assessment: partly intentional, partly copy drift.** The description explains optional targets and ownership. The snippet still says “main”, even for a self-only call from a managing teammate. Its subject is less accurate than the description.

### Ordinary teammate

```ts
report_context_window({});
```

**description**

> Report your current context-window use.

**promptSnippet:** not defined.

### Success output — current, all roles

Prose text, with whole-number percentages and rounded thousands of tokens:

```text
Teammate reviewer has used 87k tokens out of 272k available (32%).
You have used 41k tokens out of 272k available (15%).
```

Selected teammate reports appear first in target order. The caller's report appears last. A self-only call returns just the “You have…” sentence. `details` is empty.

### Failure output — current, all roles

Error text, for example `Context usage is unavailable`, `Unknown teammate: {name}`, `Ambiguous teammate across teams: {name}`, or `Teammate {name} is not ready`. A teammate HTTP failure uses `Teammate {name} rejected context-window query: {status} {body}`. A failed query makes the entire call fail; it does not return partial successful reports.

## teamlog

Available to main and teammates that can manage their own teams. A managing teammate uses this tool for its own teams.

```ts
teamlog({
  // Team name or ID; optional only when exactly one owned team exists.
  team?: TeamNameOrID,

  // Filter to one teammate name.
  teammate?: string,

  // Filter to any of these normalized event kinds.
  // If supplied, the array must contain at least one non-empty string.
  kind?: string[],

  // Case-insensitive substring search over summary, teammate,
  // direction, kind, and details.
  search?: string,

  // ISO timestamp filter; only entries at or after this time.
  since?: string,

  // Max rows to return. Integer, default 20, minimum 1, maximum 100.
  limit?: number,

  // Opaque cursor from a previous response, e.g. "before:54".
  cursor?: string,
});
```

**description**

> Inspect a compact, paged, filterable event log for a pi-simple-team team.

**promptSnippet**

> Inspect team event log

**Difference assessment: intentional summary.** The description adds paging and filtering capabilities. The snippet is a short discovery label.

### Success output — current

A plain-text table, not JSON. Example:

```text
Team review — latest 1 of 2 matching events
seq time     teammate   kind         dir                 summary
002 14:20:03 reviewer   status       runtime             reviewing Reading implementation
Showing 1 of 2 matching events. nextCursor="before:2"
```

The header and footer report counts. The footer includes `nextCursor` only when older matching entries remain. Zero matches still returns the header, column headings, and a zero-count footer.

Pi's `details` object additionally contains `team`, `roster`, full `entries`, `totalMatched`, `returned`, optional `nextCursor`, and `filters` (`teammate`, `kind`, `search`, `since`, `limit`, `cursor`). These details are not printed into the model-facing table.

### Failure output — current

Team-selection errors or filter errors return prose, for example `Invalid since timestamp: {value}`, `Invalid cursor: {value}`, or `Invalid limit: {value}. Must be at least 1.` Schema-invalid inputs can be rejected before execution.

## team_shutdown

Available to main and teammates that can manage their own teams.

```ts
team_shutdown({
  // Team name or ID; optional only when exactly one owned team exists.
  team?: TeamNameOrID,
});
```

**description and promptSnippet — same wording**

> Stop a team and kill its teammate processes.

### Success output — current

JSON text:

```ts
{ stopped: true, team: string, teammates: string[] }
```

There is no prose success sentence. Session history remains available for resume.

### Failure output — current

Team-selection failures return the common error text. Cleanup errors return `Failed to close Herdr teammate pane(s): {errors separated by semicolons}`. That label is broader in practice than it sounds: collected manifest-write and lease-release errors use the same prefix. Shutdown may already have stopped processes before returning an error.

## schedule_reminder

Available to main and teammates that can manage their own teams.

```ts
schedule_reminder({
  // Minutes until the reminder. Greater than 0, maximum 35791.
  delayMinutes: number,

  // Custom message that wakes you. Must not be empty.
  message: string,
});
```

**description**

> Set yourself a one-shot reminder that wakes you with a custom message after a specified number of minutes.

**promptSnippet**

> Use schedule_reminder as a safety net for team oversight if delegates do not wake you proactively. Ask whether the user wants periodic checks, such as every 30 minutes. Recommend this safety net more strongly as the expected run time grows, especially for multi-hour unattended work. For periodic checks, schedule the next reminder after each check.

**Difference assessment: intentional.** The description explains the timer. The snippet adds a policy for when to suggest reminders, ask the user, and schedule periodic checks. It is behavioral guidance, not a synonym for the description.

### Success output — current

JSON text:

```ts
{ scheduledAt: string, message: string }
```

`scheduledAt` is an ISO timestamp. There is no prose success sentence. When the timer fires, the model receives the supplied `message` as a separate follow-up that starts a turn. That reminder is hidden from the normal message display. Session shutdown cancels pending timers.

### Failure output — current

Invalid inputs receive Pi's schema-validation error text. The tool has no custom failure prose or explicit error branch. An unexpected execution exception uses the normal exception-message result.

## Additional instruction returned by team_spawn

This instruction is in the tool result rather than the input definition:

> Read the bundled ai-to-leader skill at {absolute bundled ai-to-leader SKILL.md path} and the bundled ai-to-delegated skill at {absolute bundled ai-to-delegated SKILL.md path} in full before continuing, then follow their instructions.

`/team` is a human-facing slash command, not an agent tool. Its description is: “Open a read-only team overview”.

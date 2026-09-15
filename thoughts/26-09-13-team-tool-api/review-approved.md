# pi-simple-team API revision

This draft incorporates the submitted annotations. All 86 entries and their original locations are preserved in `feedback.json`, `feedback.md`, `review-before-feedback.md`, and `annotation-locations.md`.

The runtime has not changed. The three requested source comments have been added. This page describes the proposed API, followed by a complete inventory of current extension-defined errors.

## Where prose belongs

Your timing assumption is correct for normally registered active tools: descriptions and parameter schemas accompany model requests before the first invocation. The extension does not load them only when the agent chooses a tool.

| Field | Destination | Purpose in this revision |
| --- | --- | --- |
| `promptSnippet` | “Available tools” in Pi's default system prompt | A short invitation to discover a broad capability |
| `description` | Callable tool definition | Invocation guidance not already taught by parameters |
| Parameter `description` | Input schema | Meaning, defaults, constraints, and parameter-specific tradeoffs |
| `promptGuidelines` | “Guidelines” in Pi's default system prompt | Rules worth keeping active across the session |
| Success `instruction` | Result after a successful call | What the caller should do next |

`promptGuidelines` is not delayed disclosure. It gives general rules a prominent place and deduplicates repeated guideline strings. The tradeoff is persistent token and attention cost. Tool-specific invocation guidance belongs in `description`; post-call guidance belongs in the result. This revision adds no `promptGuidelines`.

The **promptSnippet rule**: keep snippets short, preferably one line. They invite discovery rather than teach a manual.

The **MECE prose rule**: parameter names, types, parameter descriptions, tool descriptions, and success instructions should each add distinct value. Remove redundant text. Separate invocation guidance from post-call instructions.

Teammates use a custom system prompt, which bypasses Pi's default snippet and guideline sections. Their callable tool descriptions still apply.

Only `team_spawn`, `team_add_teammates`, `team_send_message`, and `team_status` retain snippets here. The last two were not marked for removal; their retained snippets stay short.

## Confirmed behavior and remaining choices

1. Spawn, resume, and add start work by default. Each accepts `startIdle?: boolean`, default `false`.
2. The extension waits until every teammate in that operation is ready, then sends kickoff messages as one batch. Nobody starts while that batch is still being created. The tool does not wait for tasks to finish.
3. This is a readiness barrier, not a promise that separate processes produce their first model token at the exact same instant.
4. Existing name-versus-ID support remains. Expanding previously name-only teammate inputs to accept IDs is deferred.
5. Status timestamps are automatic and output-only. Teammates can see `updated` in status results, but cannot supply it to `team_status`.
6. Managing teammates can list and resume current-project teams created by their own durable Pi session. That scope survives restarting the same Pi session. It excludes other creators' teams.
7. `teammateId` is the Pi session ID. Return it once under that name. Do not create a separate teammate ID or return a duplicate `sessionId` field.
8. Resume accepts `resumptionPrompt`, instructions added once to the resumed teammates' conversation context. It does not overwrite saved system prompts or independently start work. `startIdle` alone controls whether the resumed teammates start work. Individual resumption messages remain a separate proposal.

## Shared input and output types

```ts
type ThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";

type Teammate = {
  // Unique name within the team. "main" is reserved.
  name: string;
  // Individual teammate system prompt.
  systemPrompt: string;
  // Canonical provider/model ID. See model guidance below.
  model: string;
  // Defaults to xhigh.
  thinking?: ThinkingLevel;
  // Start with a clone of your context window rather than start fresh.
  // Defaults to false.
  inheritMainContext?: boolean;
  // Allow this teammate to create and manage its own teams. Default false.
  canManageOwnTeams?: boolean;
  // Open a visible Herdr pane for this teammate. Default false.
  showOnHerdrPane?: boolean;
};

type Status = {
  word: string;
  phrase: string;
  updated: string; // Generated automatically. ISO timestamp. Output only.
};
type StatusMap = Record<string, Status>; // Participant names, including main

type TeamIdentity = { teamName: string; teamId: string };
type TeammateIdentity = {
  teammateName: string;
  teammateId: string; // Pi session ID
};

type StartResult = TeamIdentity & {
  started: boolean;
  teammates: TeammateIdentity[]; // Members affected by the call
  instruction: string;
};

type MessageResult = TeamIdentity & {
  published: true;
  status: StatusMap;
  instruction: string;
};
```

These are documentation types, not extra input parameters. Every returned `teammateId` is a Pi session ID.

`started` means the operation initiated work for the affected teammates. It is false with `startIdle: true`, or when resume has no stopped members to start. It does not mean the tasks finished. The implementation must acknowledge kickoff initiation before returning true.

`published` acknowledges acceptance into the extension's delivery path. It does not claim that the recipient read the message or replied.

Most results are JSON text. Context usage returns prose. The log returns a text table. Pi marks thrown errors as error results and sends their text to the model. Renderer details and colored terminal output are separate from that text.

### Model guidance

Keep model guidance only in the `model` parameter description, not repeated in spawn's description and snippet.

With scoped models:

> Prefer one of these user-scoped models: {canonical provider/model IDs}.

Otherwise:

> The user has not defined preferred models. Read PI_PROVIDER, PI_MODEL, and PI_REASONING_LEVEL to identify your current model. Confirm with the user before choosing a model ID.

### Shared lifecycle success instructions

Preserve the bundled instruction:

> Read the bundled ai-to-leader skill at {absolute bundled ai-to-leader SKILL.md path} and the bundled ai-to-delegated skill at {absolute bundled ai-to-delegated SKILL.md path} in full before continuing, then follow their instructions.

When work starts, append:

> Teammates will message you with milestones or requests for help. Avoid repeated status polling and shell sleeps. Set your status to explain what you expect from them. If you have no independent work, tell the user and end your turn. Ask the user whether to schedule progress checks every 15 minutes. If they agree, schedule the first reminder. After each check, schedule the next one while the team still needs oversight.

With `startIdle: true`, replace the work-started guidance with:

> These teammates are idle. Use team_send_message when you want them to start. Give them the instructions they need in that message.

## team_spawn

```ts
team_spawn({
  // Name for the new team.
  teamName: string,
  // Common system prompt for all teammates.
  commonPrompt: string,
  // Teammates to create.
  teammates: Teammate[],
  // Open visible Herdr panes for the team. Defaults to false.
  // Overrides individual teammate Herdr setting when explicitly supplied.
  showOnHerdrPanes?: boolean,
  // Start teammates idle. Defaults to false.
  // Otherwise, teammates start work immediately per the common and
  // individual prompts they were given, once everyone is ready.
  startIdle?: boolean,
});
```

**description**

> You are automatically part of the team as main. Do not include yourself in `teammates`. Use team_resume to continue an existing team, or team_add_teammates to grow one.

**promptSnippet**

> Spawn a versatile team of agents.

The snippet invites discovery. The description explains relationships the parameters do not teach. Post-call instructions appear only after success.

For Herdr, an explicitly supplied team value overrides individual values. When omitted, individual values apply, each defaulting to false. This preserves the individual control without a team-wide flag.

**Success:** `StartResult`. No routine initial status map and no separate session map.

The old session map provided durable Pi identities and session-file paths for recovery or direct session access. That is useful information, but a second map duplicates teammate identities. Keep essential identities with each teammate and full session details in `team_list`.

Spawn removes the initial status map. A fast teammate could update its status after the barrier but before the caller reads the response. That possible race does not justify a routine snapshot of initial statuses.

**Errors:** name/model validation, existing-team selection, registry, startup, and Herdr errors in the complete inventory. Kickoff failures must identify any teammates that already started.

Source comment added: consider using resume automatically for an existing team, but first check whether every supplied spawn setting can be preserved.

## team_list

`team_list({})`

**description — main**

> List active and dormant teams for the current project.

**description — managing teammate**

> List active and dormant teams in the current project that this managing teammate's Pi session created.

No `promptSnippet`.

**Success:**

```ts
{
  teams: Array<TeamIdentity & {
    state: "active" | "dormant",
    leaseState: "unclaimed" | "claimed" | "stale",
    teammates: Array<Teammate & {
      teammateId: string, // Pi session ID
      sessionFile: string,
      live: boolean,
    }>,
    createdAt: string,
    updatedAt: string,
    shutdownAt?: string,
    expiresAt?: string,
  }>,
}
```

No teams remains a successful `{ "teams": [] }`. Remove the duplicate array of names. Rename `members` to `teammates`. Each record contains the full effective Teammate configuration plus session and liveness information. Optional flags have resolved values in these full records.

The full record retains `name`, as required by the requested superset of the input type. The compact identity uses the requested `teammateName`. A later uniform rename can remove that naming difference without duplicating fields in a record.

**Errors:** project/session, manifest, lease, and filesystem errors in the inventory.

Source comment added: consider making dormant listing opt-in with `{ includeDormantTeams: boolean }`. This is a future option, not part of the implemented API.

## team_resume

```ts
team_resume({
  // Existing team name or persistent team ID.
  team: string,
  // Optionally pick which teammates to resume, by name.
  // Omit to select all stopped teammates. At least one name if supplied.
  teammates?: string[],
  // Instructions added once to resumed teammates' conversation context.
  // Does not change saved system prompts or independently start work.
  resumptionPrompt?: string,
  // Open visible Herdr panes for selected teammates. Defaults to false.
  showOnHerdrPanes?: boolean,
  // Start resumed teammates idle. Defaults to false.
  startIdle?: boolean,
});
```

**description — main**

> Resume all or selected stopped teammates from a team in the current project. Already-running teammates remain as they are.

**description — managing teammate**

> Resume all or selected stopped teammates from a current-project team created by your Pi session. Already-running teammates remain as they are.

No `promptSnippet`.

**Individual messages remain a proposal:** replace selected names with `{ name: string, message?: string }`. Limit this to resumption instructions instead of accepting an arbitrary partial Teammate that also changes models, identity, and configuration.

`resumptionPrompt` is added once as a message to the conversation context of each teammate resumed by this call. Their saved common and individual system prompts remain unchanged. Already-running teammates do not receive it.

| `startIdle` | `resumptionPrompt` supplied | `resumptionPrompt` omitted |
| --- | --- | --- |
| Omitted or `false` | Add the instructions, then start work after all selected teammates are ready. | Start work using saved system prompts and conversation context after all selected teammates are ready. |
| `true` | Add the instructions without starting a turn. They are available when a later message starts work. | Resume the teammates and leave them idle. |

Supplying `resumptionPrompt` never overrides `startIdle: true`. With that combination, the implementation must record the message without triggering a model turn.

**Success:** `StartResult & { status: StatusMap }`. The teammates array identifies only members resumed by this call. Status covers the entire team. Remove duplicate top-level arrays such as `resumed` and `teammates`.

If a member never saved conversation history, disclose that it starts fresh. Proposed location: `contextRestored: boolean` on each resumed teammate, replacing `restartedEmpty`. Default kickoff normally creates saved history, but `startIdle: true` keeps this case possible.

**Errors:** selection, registry, saved-session, startup, and Herdr errors. Errors must distinguish team IDs, teammate names, and Pi session IDs, and describe partial changes.

## team_add_teammates

```ts
team_add_teammates({
  // Existing team name or ID. Omit with exactly one owned active team.
  team?: string,
  // New teammates. At least one.
  teammates: Teammate[],
  // Start added teammates idle. Defaults to false.
  startIdle?: boolean,
});
```

**description**

> Add teammates to an active team you own. Existing teammates continue their work.

**promptSnippet**

> Add new teammates to a running team.

Keep the approved discovery line. The description adds ownership and the effect on existing teammates. Remove transport details.

**Success:** `StartResult & { status: StatusMap }`. Return new teammates and whole-team status. Existing teammates are not kicked off again. These fields let main identify the additions and understand current team work without a second call.

**Errors:** active-team selection, name/model validation, session, startup, and Herdr errors. Failed additions must report any remaining additions and any work already started.

## team_send_message

Main and managing teammates:

```ts
team_send_message({
  // Main: existing owned team name or supported ID. Optional with one team.
  // Managing teammate: omit to address parent-team peers.
  team?: string,
  // Recipient teammate names.
  to: string[],
  // Message to send.
  message: string,
  // true: interrupt all busy recipients.
  // Array: interrupt only these recipients. Each name must be in `to`.
  // false or omitted: do not interrupt.
  interrupt?: boolean | string[],
});
```

Ordinary teammates have the same signature without `team`.

**description — main**

> Send a message to teammates in a team you own.

**description — managing teammate**

> Omit `team` to message parent-team peers. Set `team` to message teammates of one of the teams you own.

**description — ordinary teammate**

> Message teammates in your team. Use send_main_message to message main.

**promptSnippet — manager tools only**

> Message your teammates.

No snippet for ordinary teammates. Descriptions explain routing. Waiting instructions move to the success result.

**Success:** `MessageResult`, including everyone's statuses. Remove the echoed interrupt field. `published` acknowledges the queue, not delivery.

**Success instruction**

> Do not wait for replies. Teammates will message you back.

**Immediate errors:** validation, team selection, recipient selection, or publication failure.

**Later errors:** push delivery failure to the sender. Include the team, failed recipient, original message, and cause. Route it to main's session or to the sending teammate's endpoint. If the sender cannot receive it, retain the error in the log without creating recursive failure notifications.

## send_main_message

Available to every teammate. The destination is the main agent of its parent team.

```ts
send_main_message({
  // Message to send to main.
  message: string,
});
```

**description**

> Send a message to the main agent.

No `promptSnippet`.

**Success:** `MessageResult`. Return team name, team ID, and everyone's statuses. Use `published` consistently. Remove redundant from/to fields. Main separately receives `[{teamName}/{senderName}] {message}`.

**Success instruction**

> Do not wait for a reply. Continue your work or set your status to explain what you need from main.

**Errors:** parent-runtime and network errors. State whether publication occurred.

## team_status

Main and managing teammates:

```ts
team_status({
  // Main: owned team name or supported ID. Omit to read all statuses,
  // or when exactly one team exists.
  // Managing teammate: omit to use the parent team.
  team?: string,
  // One-word gerund for your status.
  gerund?: string,
  // Short, action-oriented status phrase.
  phrase?: string,
});
```

Ordinary teammates have the same signature without `team`.

**description — main**

> Set your own status for a team and/or read team statuses.

**description — managing teammate**

> Omit `team` to set or read parent-team status. Set `team` to set or read an owned team's status.

**description — ordinary teammate**

> Set your public status and read everyone's public status.

**promptSnippet — manager tools only**

> Set or read team statuses.

The main pair remains a short paraphrase. Managing-teammate prose adds routing. Ordinary teammates have no snippet.

**Success:** `TeamIdentity & { status: StatusMap }` for one team. For main's all-team read, propose `{ teams: Array<TeamIdentity & { status: StatusMap }> }` so names and IDs are explicit. A managing teammate's empty call still reads its parent team.

`updated` is automatic and cannot be supplied by the caller.

**Errors:** team-selection and parent-runtime errors. Ambiguous names and missing selectors must include all existing team names mapped to their IDs. Use arrays of IDs when a name occurs more than once.

## get_context_window_usage

Main:

```ts
get_context_window_usage({
  // Teammate names. Use an empty list to get only your own usage.
  targets: string[],
});
```

Managing teammate:

```ts
get_context_window_usage({
  // Names in teams you own. Omit to get only your own usage.
  targets?: string[],
});
```

Ordinary teammate: `get_context_window_usage({})`.

**description — main and managing teammate**

> Get context-window use of selected teammates. Your own window's use is always included.

**description — ordinary teammate**

> Get your current context-window use.

No `promptSnippet` for any role. Descriptions make no output-order promise.

**Success:** prose such as:

```text
Teammate reviewer has used 87k tokens out of 272k available (32%).
You have used 41k tokens out of 272k available (15%).
```

**Errors:** unavailable usage, unknown/ambiguous teammate, stopped runtime, or rejected context query. A failed query currently fails the call without partial reports.

## team_log

```ts
team_log({
  // Existing owned team name or supported ID. Optional with one team.
  team?: string,
  // Filter to one teammate name.
  teammate?: string,
  // Match any listed event kind. At least one non-empty string if supplied.
  kind?: string[],
  // Case-insensitive search across event fields and details.
  search?: string,
  // ISO timestamp. Include events at or after this time.
  since?: string,
  // Integer. Default 20, minimum 1, maximum 100.
  limit?: number,
  // Opaque cursor from a previous response, such as "before:54".
  cursor?: string,
});
```

**description**

> Inspect a compact, paged, filterable event log for a team.

No `promptSnippet`.

**Success:** a text table with team name, returned/matched counts, event rows, and optional nextCursor. Zero matches is a successful empty table. Full event objects remain in renderer details rather than the model-facing table.

**Errors:** team selection, invalid timestamp, cursor, or limit.

Source comment added: `teammate` should become optional `teammates` (plural). This revision does not implement that future filter change.

## team_shutdown

```ts
team_shutdown({
  // Existing owned team name or supported ID. Optional with one team.
  team?: string,
});
```

**description**

> Stop a team and kill its teammate processes.

No `promptSnippet`.

**Success:**

```ts
TeamIdentity & {
  stopped: true,
  teammates: TeammateIdentity[],
}
```

Return both team identifiers and each teammate's name and `teammateId` (its Pi session ID). Preserve session history.

**Errors:** selection and cleanup/registry errors. Explain what already stopped, rather than implying a full rollback.

## schedule_reminder

```ts
schedule_reminder({
  // Minutes until the reminder. Greater than 0, maximum 35791.
  delayMinutes: number,
  // Message that wakes you. Must not be empty.
  message: string,
});
```

**description**

> Set a one-shot reminder for yourself. Use it when work needs a later check. For periodic checks, schedule the next reminder after each check.

No `promptSnippet`. The long previous snippet is removed. Team-oversight suggestions and the user preference question now live in lifecycle success instructions, where that guidance is relevant.

**Success:** `{ scheduledAt: string, message: string }`. The time is ISO formatted. The timer later pushes the message and wakes the caller. Session shutdown cancels its timers.

**Errors:** schema validation or underlying exceptions. The extension defines no custom reminder error text.

## Complete current error inventory

The following tables are extracted from every explicit `new Error(...)` expression in the extension's non-test source. Expressions retain their current names and interpolation variables, so the inventory matches the code exactly. A `${...}` expression is filled at runtime. Repeated expressions are listed once. Each row names its cause and source location.

These are current literals, not proposed rewritten errors. Public names such as `inheritContext` will change with the implementation. Pi's schema-validation text and native network, filesystem, and JSON-parser errors originate upstream and are not a finite list defined by this extension.

### index.ts

| Error expression | Cause | Source line |
| --- | --- | --- |
| `` "Name cannot be empty" `` | A supplied name is blank after trimming. | 110 |
| `` `${command} ${args.join(" ")} failed: ${error.message}${stderr.trim() ? `\n${stderr.trim()}` : ""}` `` | An external process command fails or times out; stderr is appended when present. | 130 |
| `` "showOnHerdrPanes requires HERDR_TAB_ID in the main Pi process" `` | Visible panes were requested without a Herdr tab. | 140 |
| `` `showOnHerdrPanes requires an available Herdr server: ${error instanceof Error ? error.message : String(error)}` `` | The Herdr status command fails. | 146 |
| `` "showOnHerdrPanes requires a running compatible Herdr server" `` | Herdr reports a stopped or incompatible server. | 151 |
| `` `Teammate ${recipient.name} is not ready` `` | A delivery/context target is stopped or unregistered. | 161 |
| `` `Teammate ${recipient.name} rejected delivery: ${response.status} ${await response.text()}` `` | The child delivery endpoint returns an unsuccessful HTTP status. | 175 |
| `` `Teammate ${recipient.name} did not accept delivery` `` | The HTTP response has no accepted acknowledgment. | 177 |
| `` `Timed out waiting for teammate ${recipient.name} delivery` `` | Delivery exceeds its 30-second timeout. | 180 |
| `` `Ambiguous team name: ${teamIdentifier}. Pass the persistent team ID.` `` | Several team candidates match the identifier. | 233 |
| `` `Unknown team: ${teamIdentifier}` `` | The selected team is absent from the operation or callback scope. | 241 |
| `` "No teams exist. Use team_spawn first." `` | The caller needs an owned live team, but none exists. | 246 |
| `` `Multiple teams exist: ${ownedTeams.map((team) => team.id ?? team.name).join(", ")}. Pass team explicitly.` `` | The caller omitted the team selector while several teams exist. | 247 |
| `` `Unknown team: ${teamName}` `` | The selected team is absent from the operation or callback scope. | 252 |
| `` `Unknown teammate(s) in ${team.name}: ${missing.join(", ")}` `` | A recipient is absent from the selected team. | 260 |
| `` `Unknown teammate: ${name}` `` | A context target is absent from owned teams. | 272 |
| `` `Ambiguous teammate across teams: ${name}` `` | A context target name occurs in multiple owned teams. | 273 |
| `` `Teammate ${teammate.name} is not ready` `` | A delivery/context target is stopped or unregistered. | 279 |
| `` `Teammate ${teammate.name} rejected context-window query: ${response.status} ${await response.text()}` `` | A child context endpoint returns an unsuccessful HTTP status. | 286 |
| `` `${teammate.name} exited (code=${code}, signal=${signal})` `` | A child exits before startup registration completes. | 421 |
| `` `herdr agent start did not return a pane for ${teammateName}` `` | Herdr provides no pane ID for the started agent. | 431 |
| `` `Timed out waiting for teammate ${teammate.name} to register` `` | Startup registration exceeds 30 seconds. | 477 |
| `` String(error) `` | A non-Error value is converted to text without a new error template. | 481 |
| `` `Teammate ${teammate.name} has no reported session identity` `` | Persisting a member requires a missing session ID or file path. | 502 |
| `` "Team callback server did not get a port" `` | The parent cannot obtain its bound server port. | 627 |
| `` `Invalid delivery URL for ${teammateName}` `` | Registration supplies a URL outside the expected loopback format. | 654 |
| `` `Unknown teammate: ${from}` `` | A callback sender is absent from its team. | 691 |
| `` `Teammate ${from} reported an invalid session identity` `` | Registration supplies malformed session ID or file-path fields. | 696 |
| `` `Teammate ${teammate.name} has no reported session file` `` | Resume has no stored session-file path. | 834 |
| `` `Materialized session file for ${teammate.name} is missing: ${teammate.sessionFile}` `` | A conversation file previously saved is now missing. | 837 |
| `` "pi-simple-team could not locate the parent Pi executable" `` | The parent executable path is absent. | 851 |
| `` `Duplicate teammate name(s): ${[...new Set(duplicateNames)].join(", ")}` `` | A roster repeats names or an addition conflicts with existing names. | 899 |
| `` '"main" is reserved' `` | A teammate is named main. | 900 |
| `` "inheritContext requires a persistent main session" `` | Context inheritance is requested without a saved main session. | 905 |
| `` `Team already exists: ${runtimeTeamId}` `` | Spawn finds the same live team ID. | 911 |
| `` `Team already exists: ${teamId}. Use team_resume.` `` | Spawn finds an existing persisted team attachment. | 916 |
| `` "team_list requires a project directory" `` | List cannot determine the project. | 1039 |
| `` "team_list requires a persistent overseeing teammate session" `` | List cannot scope a managing teammate without its Pi session ID. | 1041 |
| `` "team_resume requires a project directory" `` | Resume cannot determine the project. | 1090 |
| `` "team_resume requires a persistent overseeing teammate session" `` | Resume cannot scope a managing teammate without its Pi session ID. | 1092 |
| `` `Unknown current-project team: ${params.team}` `` | Resume finds no team within its project/creator scope. | 1097 |
| `` `Unknown teammate(s) in ${manifest.name}: ${missingNames.join(", ")}` `` | A resume target is absent from the selected team. | 1103 |
| `` `Team ${manifest.id} is already owned by another main session` `` | Resume finds a live runtime owned by another session. | 1109 |
| `` "team_resume requires a persistent main session" `` | Resume cannot obtain the owner Pi session ID. | 1115 |
| `` `team_add requires a running team owned by this main session: ${params.team}` `` | Add selects no owned active team with a manifest and lease. | 1204 |
| `` `Failed to close Herdr teammate pane(s): ${errors.join("; ")}` `` | Shutdown collects pane-close, manifest-write, or lease-release errors. | 1431 |

### child-tools.ts

| Error expression | Cause | Source line |
| --- | --- | --- |
| `` `Missing ${name}` `` | A required child-runtime environment variable is absent. | 26 |
| `` "PI_SIMPLE_TEAM_PARTICIPANTS must be a JSON string array" `` | Parsed participant configuration is not an array of strings. | 34 |
| `` `team runtime rejected ${tool}: ${response.status} ${await response.text()}` `` | A child-to-parent HTTP request fails. | 72 |
| `` "Timed out waiting for the child to settle after interrupt" `` | The interrupted child does not settle within its wait timeout. | 140 |
| `` `Lifecycle callback failed: ${lifecycleError.message}` `` | Repeated lifecycle notifications failed; delivery is rejected. | 197 |
| `` "Child delivery server did not get a port" `` | The child cannot obtain its bound server port. | 230 |
| `` "team runtime returned an invalid participant list" `` | A pre-turn roster response has the wrong shape. | 264 |
| `` "team runtime could not find its startup roster instruction" `` | A pre-turn update cannot locate the system-prompt roster. | 268 |

### context-window.ts

| Error expression | Cause | Source line |
| --- | --- | --- |
| `` "Context usage is unavailable" `` | Context token count or percentage is unavailable. | 10 |

### teamlog.ts

| Error expression | Cause | Source line |
| --- | --- | --- |
| `` `Invalid since timestamp: ${since}` `` | The since filter cannot be parsed as a timestamp. | 145 |
| `` `Invalid limit: ${limit}. Must be at least 1.` `` | The row limit is non-finite or below one. | 168 |
| `` `Invalid cursor: ${cursor}` `` | The cursor does not match before followed by a numeric sequence. | 175 |

### model-preflight.ts

| Error expression | Cause | Source line |
| --- | --- | --- |
| `` `Model preflight failed:\n${errors.map((error) => `- ${error}`).join("\n")}` `` | One or more models are unavailable; the message contains one bullet per teammate. | 31 |

### team-registry.ts

| Error expression | Cause | Source line |
| --- | --- | --- |
| `` `Invalid team manifest: ${filePath}` `` | Parsed manifest fields violate the stored schema. | 94 |
| `` `Invalid team lease: ${filePath}` `` | Parsed lease fields violate the stored schema. | 124 |
| `` `Team ${teamId} is already owned by main session ${existingLease.mainSessionId}` `` | Lease acquisition finds another live owner. | 257 |
| `` `Team ${teamId} lease claim is already in progress` `` | Another lease claim holds the claim lock. | 281 |

### HTTP errors and asynchronous log text

| Text | Cause |
| --- | --- |
| `invalid token` | A parent or child endpoint receives the wrong callback token. HTTP 403. |
| `unknown tool: {internalTool}` | An internal endpoint receives an unsupported operation. HTTP 400. |
| `delivery to {name} failed: {cause}` | The delivery queue records an asynchronous failure in the team log. |
| `{ error: error.message }` | HTTP catch handlers expose the underlying exception message. |

The `Model preflight failed` expression above is built from one or more lines of this exact form: `Model {JSON-quoted model} for teammate {JSON-quoted name} is not available.`

Other exceptions pass through unchanged. Pi converts a thrown tool error into a text result marked `isError: true`. Internal startup errors can also appear through stderr or team logs rather than as an immediate tool result.

### Required error improvements

1. Use the new public names, including `inheritMainContext` and “managing teammate”.
2. Identify values explicitly as a team name, team ID, teammate name, or Pi session ID.
3. Give a concrete next action using a named tool and parameter. Include available model IDs when model selection fails.
4. For ambiguous or omitted team selectors, include a map of team names to all matching IDs. Use an array when names repeat.
5. Report partial effects. A failure must not imply that nothing happened when some processes or turns already started or stopped.
6. Push later delivery failures to the original sender.
7. Preserve the root cause for runtime failures. Do not suggest prompt changes can repair broken runtime state.

Proposed ambiguous-selection wording:

```text
Team name "review" is ambiguous. Available team IDs by name:
{"review":["{teamId1}","{teamId2}"]}
Call {toolName} again with team set to the intended team ID.
```

Proposed inheritance wording:

```text
inheritMainContext requires a saved main session.
Use a saved main session, or retry with inheritMainContext: false.
```

The exact replacement errors remain implementation work. The inventory above preserves every current expression so none is omitted from that work.

## Resolution of revised and ambiguous annotations

Entry 28 overrides 27: remove the duplicate name list. Entry 57 overrides 56: use `published`, not `sent`. Entry 54 moves waiting instructions from descriptions to success results. Entry 7 defers expanded ID inputs.

Entry 10 says “former” at the end, but its explanation clearly puts post-call instructions in success results. This draft follows that explanation.

Entry 8 belongs to `team_spawn.showOnHerdrPanes`, not `startIdle`. Explicit team-wide values override per-teammate values; omission preserves individual control.

Entries 50 and 51 are duplicate formatting corrections for `team` in the managing-teammate send description. Apply backticks once.

Entries 43 and 78 approve existing choices. Entry 31 approves empty-list success. Entry 86 preserves the bundled skill instruction. None is treated as a missing change request.

Both decisions are resolved: `teammateId` is the Pi session ID, returned without a duplicate field. `resumptionPrompt` adds instructions once to conversation context and leaves saved system prompts unchanged. Only `startIdle` controls whether resume starts work. Individual resume messages remain a proposal, not an assumed decision.

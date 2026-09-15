#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.12"
# ///
import difflib
import json
from pathlib import Path
import re
import textwrap

directory = Path(__file__).resolve().parent
repository = directory.parent.parent
registrations = json.loads((directory / 'registered-tools.json').read_text())
roles = {'main': 'Main', 'manager': 'Managing teammate', 'member': 'Ordinary teammate'}
order = ['team_spawn', 'team_list', 'team_resume', 'team_add_teammates', 'team_send_message', 'send_main_message', 'team_status', 'get_context_window_usage', 'team_log', 'team_shutdown', 'schedule_reminder']

def type_text(schema: dict[str, object]) -> str:
    if 'enum' in schema:
        return ' | '.join(json.dumps(value) for value in schema['enum'])
    if 'const' in schema:
        return json.dumps(schema['const'])
    if 'anyOf' in schema:
        return ' | '.join(type_text(option) for option in schema['anyOf'])
    kind = schema.get('type')
    if kind == 'array':
        item = 'Teammate' if schema['items'].get('type') == 'object' else type_text(schema['items'])
        return f'{item}[]'
    if kind in ('integer', 'number'):
        return 'number'
    return str(kind)

def fields(schema: dict[str, object]) -> list[str]:
    lines = []
    for name, field in schema.get('properties', {}).items():
        for line in textwrap.wrap(field.get('description', ''), width=90, break_on_hyphens=False, break_long_words=False):
            lines.append('  // ' + line)
        constraints = {key: field[key] for key in ('minItems', 'minLength', 'minimum', 'exclusiveMinimum', 'maximum') if key in field}
        if constraints:
            lines.append('  // Schema: ' + ', '.join(f'{key}: {value}' for key, value in constraints.items()))
        optional = '' if name in schema.get('required', []) else '?'
        lines.append(f'  {name}{optional}: {type_text(field)};')
    return lines

def signature(name: str, schema: dict[str, object]) -> str:
    return '\n'.join(['```ts', name + '({', *fields(schema), '});', '```'])

success = {
'team_spawn': '''JSON text:

```ts
TeamIdentity & {
  started: boolean;
  teammates: TeammateRecord[];
  instruction: string;
}
```

The complete roster contains resolved defaults, Pi session IDs, session files, and runtime state. `started` is true while any teammate has active work. An empty team returns false. No separate session map or initial status map is returned.''',
'team_list': '''JSON text:

```ts
{
  teams: Array<TeamIdentity & {
    state: "active" | "dormant";
    leaseState: "unclaimed" | "claimed" | "stale";
    teammates: TeammateRecord[];
    createdAt: string;
    updatedAt: string;
    shutdownAt?: string;
    expiresAt?: string;
  }>;
}
```

Each team contains its complete roster. No teams returns `{ "teams": [] }`. A managing teammate sees only current-project teams created by its own Pi session.''',
'team_resume': '''JSON text:

```ts
TeamIdentity & {
  started: boolean;
  teammates: Array<TeammateRecord & { contextRestored?: boolean }>;
  alreadyActiveTeammates: Array<Pick<TeammateRecord, "name" | "teammateId">>;
  status: StatusMap;
  instruction: string;
}
```

`teammates` includes every teammate: resumed, already live, or still stopped. `contextRestored` appears only on teammates resumed by this call. True means Pi loaded the saved session file. False means the original session file never materialized, so Pi created an empty session. If a previously saved file disappears, resume fails instead.

`started` reflects the whole team's current work, even for a no-op or `startIdle: true` call. `alreadyActiveTeammates` identifies pre-existing live teammates that have active work at return time. Already-live teammates receive no resumption prompt or kickoff.''',
'team_add_teammates': '''JSON text:

```ts
TeamIdentity & {
  started: boolean;
  teammates: Array<Pick<TeammateRecord, "name" | "teammateId" | "live" | "active">>;
  status: StatusMap;
  instruction: string;
}
```

The lightweight roster includes all teammates. Existing teammates continue their work. `started` therefore remains true when existing work continues, even if the additions start idle. Existing Pi sessions cannot yet be attached.''',
'team_send_message': '''JSON text:

```ts
{
  published: true;
  teams: Array<TeamIdentity & { status: StatusMap }>;
  instruction: string;
}
```

Status covers every selected team, with team IDs to distinguish repeated names. Publication acknowledges queuing, not completed delivery. Invalid or ambiguous selections and invalid interrupt subsets are rejected before publication. A later delivery failure is pushed to the original sender.

The result does not echo recipients or interrupt settings. Its instruction is: **Do not wait for replies. Teammates will message you back.**''',
'send_main_message': '''JSON text with `TeamIdentity & { published: true; status: StatusMap; instruction: string }`. Status covers the parent team. The result does not echo `from` or `to`.

Its instruction is: **Do not wait for a reply. Continue your work or set your status to explain what you need from main.**''',
'team_status': '''JSON text with `TeamIdentity & { status: StatusMap }` for a selected team. Main's no-argument read returns `{ teams: Array<TeamIdentity & { status: StatusMap }> }`. No owned teams gives `{ "teams": [] }`.

A managing teammate's no-argument call reads its parent team. Status prose is independent of runtime activity. `updated` is output-only.''',
'get_context_window_usage': '''Prose text, with each teammate's name, Pi session ID, team name, and team ID:

```text
Teammate reviewer (Pi session ID: session-a) on team first (team ID: team-a) has used 87k tokens out of 272k available (32%).
Teammate reviewer (Pi session ID: session-b) on team second (team ID: team-b) has used 51k tokens out of 272k available (19%).
You have used 41k tokens out of 272k available (15%).
```

A self-only call returns only the “You have…” sentence. A failed target query fails the call instead of returning partial reports. Main and managing teammates select from owned teams. Ordinary teammates report only their own usage.''',
'team_log': '''Text tables grouped by team, with each team name and ID in its heading. A final line reports global counts and an optional opaque `nextCursor`.

```text
Team first (team ID: team-a) — latest 1 of 2 matching events
seq time     teammate   kind         dir                 summary
002 14:20:03 reviewer   status       runtime             reviewing Reading implementation
Showing 1 of 2 matching events.

Total: 1 of 2 matching events. nextCursor="opaque-value"
```

Selecting a team includes all its events. Selecting teammates includes only events attributed to those teammates. The limit applies across selected teams. Pagination orders events by timestamp, team ID, then team-local sequence, so repeated sequence numbers cannot skip events.

Zero matches is a successful empty table. Renderer details also contain selected teams, full entries, rosters, filters, and counts.''',
'team_shutdown': '''JSON text with `TeamIdentity & { stopped: true; teammates: Array<Pick<TeammateRecord, "name" | "teammateId">> }`. The complete roster identifies the saved Pi sessions. Shutdown preserves session history.''',
'schedule_reminder': '''JSON text with `{ scheduledAt: string; message: string }`. The time is ISO formatted. The timer later inserts the message and starts a turn. Session shutdown cancels pending timers.''',
}
failures = {
'team_spawn': 'Name/model validation, existing-team collision, session/registry errors, Herdr/startup errors, or partial kickoff failure.',
'team_list': 'Missing project/session scope, invalid current-format manifest or lease, or filesystem errors.',
'team_resume': 'Unknown or ambiguous team/teammate, ownership or lease conflict, missing saved history, startup failure, or partial kickoff failure.',
'team_add_teammates': 'Missing owned active team, duplicate/reserved names, invalid model/context settings, startup failure, or partial kickoff failure.',
'team_send_message': 'Unknown/ambiguous target, interrupt outside the selected recipients, or parent publication failure. Deferred delivery errors identify the team, recipient, original message, and cause.',
'send_main_message': 'Parent-runtime or network errors. Failed publication never returns published: true.',
'team_status': 'Team-selection errors or parent-runtime/network errors.',
'get_context_window_usage': 'Unknown/ambiguous target, unavailable context usage, stopped/unready teammate, or failed context query.',
'team_log': 'Unknown/ambiguous target or invalid since/cursor/limit values.',
'team_shutdown': 'Team-selection or cleanup/registry errors. Processes may already have stopped when a cleanup error returns.',
'schedule_reminder': 'Input-schema validation or execution exceptions. No custom reminder error text exists.',
}

introduction = '''# pi-simple-team tool API

Current implementation after the September 14 annotations. Signatures and agent-facing prose come from registered tools. Run `bun thoughts/26-09-13-team-tool-api/export-tools.ts`, then `uv run thoughts/26-09-13-team-tool-api/render-review.py` to refresh this page.

The [submitted page](review-submitted-2026-09-14.md) and [14 annotations](feedback-2026-09-14.json) remain unchanged. The [revision playbook](revision-playbook.md) records decisions and verification.

## Shared selection and runtime rules

1. Every input that identifies an existing teammate accepts its name or Pi session ID in the same string field. A failed name can be replaced directly with an ID.
2. Messages, logs, and context usage share `targets`. A team name or ID selects that team's teammates. A teammate name or ID selects that teammate. Lists can span permitted teams. Overlapping selections count once. Ambiguous names return usable IDs.
3. Resume keeps its destination `team` and an optional subset in `teammates`. Add accepts new teammate definitions. A new definition's `name` assigns a name, rather than referring to an existing session.
4. `live` means the teammate has a live runtime. `active` means work is underway or queued. An idle live teammate has `live: true, active: false`. A stopped teammate has both false. Activity comes from runtime events and delivery queues, independently of status prose.
5. Spawn, resume, and add start affected teammates automatically. `startIdle: true` leaves those teammates idle. It does not stop already-live teammates. `started` reports whether anyone in the resulting team has active work.
6. `resumptionPrompt` adds a conversation message once. It never replaces system prompts. With `startIdle: true`, it remains in context until a later message starts work.
7. Spawn, list, and resume return full records for every teammate. Add returns a lightweight complete roster. The name field is always `name`, and `teammateId` is the Pi session ID. There is no duplicate `sessionId` field.
8. Current manifests use current teammate fields under `~/.pi/agent/pi-simple-team/teams-v2/`. There are no old-name aliases or storage adapters. Old manifests are not loaded. Pi session files are not migrated or deleted.

## Where agent-facing prose appears

| Field | Destination | Purpose |
| --- | --- | --- |
| promptSnippet | Default system prompt, Available tools | Short discovery hint |
| description | Callable tool definition | Invocation guidance |
| Parameter description | Input schema | Field meaning and constraints |
| promptGuidelines | Default system prompt, Guidelines | Persistent behavior rules, unused here |
| Result instruction | Successful tool result | Post-call guidance |

Descriptions and schemas normally accompany model requests before invocation. Teammates use a custom system prompt, which bypasses the default snippet/guideline lists but retains callable tool definitions. Identical description/snippet pairs appear once below.

## Shared types

'''
spawn = next(tool for tool in registrations['main'] if tool['name'] == 'team_spawn')
teammate_schema = spawn['parameters']['properties']['teammates']['items']
parts = [introduction, '\n'.join(['```ts', 'type Teammate = {', *fields(teammate_schema), '};', '', 'type TeammateRecord = Required<Teammate> & {', '  teammateId: string; // Pi session ID', '  sessionFile: string;', '  live: boolean;', '  active: boolean;', '};', '', 'type TeamIdentity = { teamName: string; teamId: string };', 'type Status = { word: string; phrase: string; updated: string };', 'type StatusMap = Record<string, Status>; // Participant names within one team, including main', '```']), '''

All input objects reject undeclared fields. Identity and runtime fields are output-only. Status timestamps are ISO strings generated by the extension.

`provider/model` above is a placeholder for the session's actual scoped model IDs. Add uses the same teammate fields with the canonical-ID explanation only. When spawn has no scoped models, its model parameter instead includes:

> The user has not defined a list of preferred models explicitly. Figure out which model _you_ are by reading the value of the PI_PROVIDER, PI_MODEL, and PI_REASONING_LEVEL environment variables. That should give you something to start with. Confirm with the user before picking any model id.
''']
for name in order:
    tools = [(roles[role], tool) for role, definitions in registrations.items() for tool in definitions if tool['name'] == name]
    parts.append(f'## {name}\n\nAvailable to: ' + ', '.join(role for role, tool in tools) + '.\n')
    groups: dict[str, tuple[dict[str, object], list[str]]] = {}
    for role, tool in tools:
        key = json.dumps(tool['parameters'], sort_keys=True)
        groups.setdefault(key, (tool['parameters'], []))[1].append(role)
    for schema, role_names in groups.values():
        if len(groups) > 1:
            parts.append('**Signature: ' + ', '.join(role_names) + '**\n')
        parts.append(signature(name, schema) + '\n')
    prose_groups: dict[tuple[str, str], list[str]] = {}
    for role, tool in tools:
        prose_groups.setdefault((tool['description'], tool.get('promptSnippet', '')), []).append(role)
    for (description, snippet), role_names in prose_groups.items():
        suffix = ': ' + ', '.join(role_names) if len(prose_groups) > 1 else ''
        if description == snippet:
            parts.append(f'**description / promptSnippet{suffix}**\n\n> {description}\n')
        else:
            parts.append(f'**description{suffix}**\n\n> {description}\n')
            parts.append(f'**promptSnippet{suffix}**\n\n> {snippet}\n' if snippet else 'No `promptSnippet`.\n')
        if snippet and description != snippet:
            assessment = {
                'team_spawn': 'Intentional. The snippet supports discovery. The description explains main membership and the relationship to resume/add.',
                'team_add_teammates': 'Intentional, with a short repeated action phrase. The description adds ownership and the effect on existing teammates.',
                'team_send_message': 'Intentional, with a short repeated action phrase. The description states the permitted destination scope.',
            }[name]
            parts.append('**Difference assessment:** ' + assessment + '\n')
    parts.append('**Success**\n\n' + success[name] + '\n\n**Failure**\n\n' + failures[name] + ' Exact extension-defined error statements appear below.\n')

source = (repository / 'index.ts').read_text()
guidance = re.search(r'function lifecycleInstruction.*?const nextAction = startIdle\s*\? "(.*?)"\s*: "(.*?)";', source, re.S)
parts.append('''## Lifecycle success instructions

Spawn, resume, and add return this bundled instruction, with absolute paths resolved at runtime:

> Read the bundled ai-to-leader skill at {absolute bundled ai-to-leader SKILL.md path} and the bundled ai-to-delegated skill at {absolute bundled ai-to-delegated SKILL.md path} in full before continuing, then follow their instructions.

When the team has no active work:

> ''' + guidance[1] + '\n\nWhen any teammate has active work:\n\n> ' + guidance[2] + '\n\nAn empty team returns only the bundled instruction.\n')

previous = (directory / 'review-submitted-2026-09-14.md').read_text()
old_errors = {}
for line in previous.splitlines():
    match = re.match(r'\| `` (.*?) `` \| (.*?) \|', line)
    if match:
        old_errors[match[1]] = match[2]
parts.append('''## Complete extension-defined error inventory

Pi returns thrown tool errors as text and marks them as errors. It does not send a stack trace to the model. Each row below quotes an actual source statement. Template expressions receive runtime values.

Schema-validation and native network/filesystem/parser errors originate upstream. Their possible messages are not a finite list defined by this extension.
''')
for filename in ['index.ts', 'child-tools.ts', 'context-window.ts', 'team-selection.ts', 'teamlog.ts', 'model-preflight.ts', 'team-registry.ts']:
    rows = []
    for number, line in enumerate((repository / filename).read_text().splitlines(), 1):
        if 'new Error(' not in line:
            continue
        statement = line.strip()
        expression = statement.split('new Error(', 1)[1]
        best = max(old_errors, key=lambda old: difflib.SequenceMatcher(None, old, expression).ratio())
        score = difflib.SequenceMatcher(None, best, expression).ratio()
        cause = old_errors[best] if score > 0.62 else 'The operation fails at this boundary. The statement supplies the specific cause.'
        if filename == 'team-selection.ts':
            cause = 'A name or ID matches no permitted target or multiple targets. The error lists usable IDs and the input field.' if 'matches.length' in statement else 'The interrupt selection includes a teammate outside the message recipients.'
        if 'Invalid team manifest' in statement:
            cause = 'The current-format manifest fails validation. No legacy-format adapter exists.'
        if 'Invalid cursor' in statement:
            cause = 'The supplied opaque cursor cannot be decoded or has an invalid timestamp/team/sequence tuple.'
        escaped_statement = statement.replace('|', '\\|')
        rows.append(f'| `` {escaped_statement} `` | {cause} | {number} |')
    parts.append(f'### {filename}\n\n| Error statement | Cause | Source line |\n| --- | --- | --- |\n' + '\n'.join(rows) + '\n')
http_section = previous.split('### HTTP and deferred error messages\n', 1)[1].split('## Deferred by agreement', 1)[0]
parts.append('### HTTP and deferred error messages\n' + http_section)
parts.append('''## Deferred work

Attaching arbitrary existing current-project Pi sessions to a team remains a source TODO. This applies to add and resume. Name-or-ID selection for existing teammates is implemented, so that TODO is no longer needed.

Individual resumption-message objects, automatic resume on spawn collision, and opt-in dormant listing remain deferred. Plural cross-team log selection is implemented through targets.
''')
(directory / 'review.md').write_text('\n'.join(parts))

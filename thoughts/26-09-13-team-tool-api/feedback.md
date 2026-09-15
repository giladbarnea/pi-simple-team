# File Feedback

I've reviewed this file and have 86 pieces of feedback:

## 1. General feedback about the file
> Make sure you understand what source text each annotation belongs to really, especially in cases where the annotated text is not unique across the page

## 2. (line 5) Feedback on: " "
> You made it clear the purpose of both former ones to exist (different tradeoffs), but what's the tradeoff with promptGuidelines vs 'description'?

## 3. (lines 33–42) Feedback on: "updated: string; // ISO "
> I hope this is set automatically by the extension and is invisible to team members to not mislead them to try to specify manually 

## 4. (lines 46–76) Feedback on: "prompt"
> systemPrompt

## 5. (lines 46–76) Feedback on: "Start from a fork of main's persisted session"
> That's implementation details, not product. Should be something like "Start with a clone of main‘s context window rather than start fresh."

## 6. (lines 46–76) Feedback on: "The fork is taken during asynchronous child startup"
> Remove this phrase

## 7. (line 78) Feedback on: "The identifier aliases express the requested API. Existing code still resolves teammate targets by name. The mapping from teammate ID to a durable Pi session ID needs to be specified before implementation."
> All the locations where I expanded the API to support Team(mate)?NameOrID instead of just one of them are a low priority change. Keep it the way it was, and if, after we finish the other things, we can also implement this nice-to-have, then we'll think about it 

## 8. (lines 96–114) Feedback on: "Defaults to false"
> Add another phrase after that: "Overrides individual teammate Herdr setting."

## 9. (lines 96–114) Feedback on: "teammates start work automatically"
> "teammates start work immediately per the prompts they were given (common and individually)"

## 10. (line 124) Feedback on: "Difference assessment: intentional. The description explains setup and input behavior. The snippet adds instructions for what main should do afterward, especially avoiding polling"
> Ok so for team_spawn, the description vs promptSnippet are both a mess.

1. Universally, `promptSnippet` should be very short, preferably only one line. Same weight as a Skill's `description` field: it is only a taste, to invite progressive disclosure, not a manual. This logically implies that it should not cover more or less similar content as `description` or any other richer prose.
I am saying this based on my current understanding that promptSnippet is injected into the main agent's system prompt which means immediately after it is initiated. Hundreds of thousands of tokens can potentially pass under the bridge before the agent wants to create a team. It is best of the details are provided to it as late and as close as possible to the moment it actually needs them, not before. Name this the promptSnippet rule.
Therefore, an OK team_spawn promptSnippet is e.g., "Spawn a versatile team of agents."

2. Conversely, `description` is a better fit for a "how to" text, and I lean on making sure it is not simply a repetition of what the tool's parameters' description strings make up; it should try to soft-avoid saying the same things, and instead find what value it could add besides what the param names, types and descriptions already teach; perhaps the "in-between" the params; the "in-between" this tools and others; the "why" behind (tradeoffs); or very plausibility and legitimately, almost nothing at all. Any content needs to justify its existence. Redundancy and fluff are detrimental. If there isn't added value in teaching a "why", and no real tradeoffs to present to the main agent, then we should simply not do it. Call it the MECE prose rule.
Next action here is to dedupe-merge the contents of the current promptSnippet and 'description', then dedupe-merge the result with the params names, types and descriptions. What's left is what the value of `description` should be. Besides one concern:

3. That planned deduped `description` will still have content that should be returned to the main agent only upon a successful invocation as *follow-up* instructions, and not be specified up-front. This is strengthened by another assumption of mine (please verify): that the `description` of the tools is also injected to the main agent at "token zero". It doesn't load the extension on demand. It is "just there", always has been. So the same many-tokens-under-bridge applies to `description` too. A semantic line should be drawn between instructions relevant for how to invoke the tool, vs instructions relevant for what to do after the team was spawned. The former needs to be cut out if the description and instead go to a success response prose.

## 11. (line 128) Feedback on: "Kickoff starts turns after all teammates register and the team manifest is saved. It does not wait for completed work. The exact kickoff message is not specified here."
> I don't understand what you wrote here

## 12. (lines 134–144) Feedback on: "accepted"
> Probably `started: true`

## 13. (lines 134–144) Feedback on: "id"
> Is this the team ID? Then should be named `teamId`

## 14. (lines 134–144) Feedback on: "team"
> teamName

## 15. (lines 134–144) Feedback on: "teammates: string[],"
> teammates: { teammateName: string, teammateId: string }

## 16. (lines 134–144) Feedback on: "sessions: SessionMap"
> What's the rationale for providing this information here? 

## 17. (lines 134–144) Feedback on: "status: StatusMap,"
> Unless teammates start one by one and ASAP, and until the team_spawn Promise is returned, some teammates have possibly already started working and have set their statuses (a behavior i am not interested in - i want all teammates to start at once as soon as everybody's ready), then this field will always carry the default statuses, right? Simply a map of idle statuses. If i am right, then this field should be removed.

## 18. (lines 134–144) Feedback on: "instruction: string,"
> A minor thing it should include is an instruction to ask the user whether to schedule a (repeating?) reminder for itself to be on top of the team's work, and suggest 15 minute intervals.

## 19. (line 146) Feedback on: "Automatic kickoff is not yet implemented"
> It should, and the response object should adapt accordingly 

## 20. (line 148) Feedback on: "The instruction value is the skill-reading prose reproduced at the end of this page."
> This is our lever I referred to in my comment about 'description' and 'promptSnippet'.

## 21. (line 150) Feedback on: "Failure output — current

Error text, for example:"
> I don't need a few examples. I need all the error texts the extension defines, and one tiny phrase for each for which situation causes it

## 22. (lines 154–161) Feedback on: "Team already exists: {team ID}. Use team_resume"
> Place a comment in the source code saying that a good idea is to make it work for the main agent by actually using team_resume for it in this case. Need to check if possible without losing provided information

## 23. (lines 154–161) Feedback on: "inheritContext"
> Should be inheritMainContext

## 24. (line 172) Feedback on: "team_list"
> Again I am not sure what's the added value in using both 'description' and promptSnippet here. Both are injected at token zero. Use only description with its current text.

## 25. (lines 176–178) Feedback on: "team_list({});"
> Add a comment in the source code saying "at one point listing dormant should be opt-in: `{ includeDormantTeams: boolean }`

## 26. (line 186) Feedback on: "List active and dormant teams created by this overseeing teammate"
> The a manager teammate limited to listing teams of current project AND that it itself created, right?
1. Shouldn't be referred as "overseeing" since field rename
2. Should have the current project bit in the description. 

## 27. (lines 198–219) Feedback on: "teammates"
> Is it teammate names or ids? I am assuming names - then field should be teammateNames

## 28. (lines 198–219) Feedback on: "teammates"
> Scratch my teammateNames comment -- what is the justification behind this field, when `members` also specifies their name? If it's pure information redundancy, let's get rid of this field

## 29. (lines 198–219) Feedback on: "members"
> *this* field should be renamed to `teammates`

## 30. (lines 198–219) Feedback on: "members: Array<{"
> Each object in this array should return a superset of Teammate type. I am saying it needs the fields that it currently has plus the Teammate fields it doesn't have yet

## 31. (line 221) Feedback on: "No teams is a success"
> That's fine

## 32. (lines 231–243) Feedback on: "Stopped teammate names or IDs"
> Change to "Optionally pick which teammates to resume.

## 33. (line 247) Feedback on: "Resume all stopped teammates"
> Change to better streamlined "Resume all or selected stopped teammates"

## 34. (line 253) Feedback on: "promptSnippet — both

Resume all or selected stopped teammates"
> Tool is too niche, remove the promptSnippet

## 35. (line 257) Feedback on: "The snippet is vague about a managing teammate’s scope"
> Add the current-project bit iff it is indeed true. If a manager teammate is actually more or less limited, let me know (perhaps limited to teams created by it only in the current session?)

## 36. (line 259) Feedback on: "Resume currently leaves the selected teammates idle. The requested automatic kickoff change is scoped to team_spawn"
> 'Resume' should also start automatically, like the new team_spawn. This means it should echo team_spawn's API: allow an optional commonPrompt, have the startIdle optional bool flag, and I'm debating whether also to support specifying a subset of the Teammate interface, mainly to allow the main agent to give the teammates a message as it wakes them up and sends them to work

## 37. (line 261) Feedback on: "Success output — current

JSON text:


{
  accepted: true,
  id: string,
  team: string,
  teammates: string[],    // Entire team roster
  resumed: string[],      // Members started by this call
  restartedEmpty: string[],
  sessions: SessionMap,   // Members started by this call
}"
> This object is smelly and feels arbitrary. It feels rushed. It needs to be re-thought-of from first principles, with the new immediate-start team_spawn/resume design. Start with "*why* is this object given to the main agent that just resumed a team? What is the main agent most likely to need going forward after resuming a team? What does it not already know?" This invites a coherent and cohesive design *across * the extension's tools -- "everything feels like it has its place"

## 38. (lines 265–275) Feedback on: "accepted: true,"
> started: true 

## 39. (lines 265–275) Feedback on: "id: string, team: string"
> Same comments for this fields as my comments on team_spawn's success response parallel fields

## 40. (line 290) Feedback on: "Duplicate names, missing project/session state, lease conflicts, Herdr failures, and child startup failures also return errors."
> I now realize that both spawn's error messages and resume's aren't as precise and as actionable they should be. The agent receiving it should know what was wrong, what it has in its hands (is it a name? An id? Of a session? A team? A mate?) as well as what to do with it ("oh, ok, so this goes here and that goes over there, got it")

## 41. (lines 296–304) Feedback on: "team"
> Should be optional if there's only one owned active team, just like team_send allows

## 42. (line 308) Feedback on: "Teammates use RPC unless their showOnHerdrPane field is true"
> Remove this line. Unnecessary implementation detail.

## 43. (line 310) [👍 Looks good] Feedback on: "promptSnippet

Add new teammates to a running team"

## 44. (line 316) Feedback on: "Add currently leaves new teammates idle. The requested automatic kickoff change is scoped to team_spawn."
> For consistency, let's have it echo team_spawn and have the added teammates start automatically. Also add 'startIdle?=false'

## 45. (line 320) Feedback on: "text:


{
  accepted: true,
  id: string,
  team: string,
  added: string[],
  sessions: SessionMap, // Newly added teammates
  status: StatusMap,   // Entire team
}"
> Same class of criticisms i have for the previous success objects. I am pushing for API-wide consistency and cohesiveness.

## 46. (lines 322–331) Feedback on: "status"
> Good thing to return by Resume, too

## 47. (lines 322–331) Feedback on: "status: StatusMap, // Entire team"
> That's actually pretty useful - main agent would probably want to do exactly that anyway right after adding the teammate(s) (checking statuses)

## 48. (line 366) Feedback on: "does not wait for replies"
> Don't wait for replies

## 49. (line 366) Feedback on: "Teammates will send you messages as they deem appropriate by way of push."
> Teammates will message you back.

## 50. (line 370) Feedback on: "team"
> `team`

## 51. (line 370) Feedback on: "team"
> ` team `

## 52. (line 370) Feedback on: "teammates in an owned team"
> "of one of the teams you own"

## 53. (line 370) Feedback on: "does not wait for replies."
> Do not wait for replies

## 54. (line 401) Feedback on: "Success output — current, all roles"
> I realize the "fire and forget don't wait" bit should live only in the success response's ` instruction' field, not in the description or schema. Because its instructions about what to do after the action was completed. (In this case, what not to do)

## 55. (line 401) Feedback on: "Success output — current, all roles"
> Should include everyone's statuses 

## 56. (lines 405–413) Feedback on: "accepted"
> sent

## 57. (lines 405–413) Feedback on: "accepted"
> Wait you're saying that a success response doesn't guarantee that the message has been transported to the other side? If so, this field name should be changed to `published` or similar to capture the sync nature of the action and not make false claims

## 58. (lines 405–413) Feedback on: "interrupt: boolean,"
> This field is weird, especially since it is now designed to be possible to interrupt only selected teammates. Remove this field

## 59. (line 421) Feedback on: "The sender receives no separate automatic failure message from this path."
> That's not good actually. Sender should be pushed the error

## 60. (line 423) Feedback on: "teammain"
> send_main_message

## 61. (line 440) Feedback on: "Success output — current"
> Should include everyone's statuses, and ' accepted' should be changed to align with the team send message success field 

## 62. (lines 444–446) Feedback on: "team: string"
> Yes, team name and ID

## 63. (lines 444–446) Feedback on: "from"
> Redundant

## 64. (lines 444–446) Feedback on: "to"
> Redundant

## 65. (line 454) Feedback on: "teamstatus"
> team_status

## 66. (line 477) Feedback on: "Set main’s status for a team and/or read team statuses."
> Set your own status for a team and/or read team statuses 

## 67. (line 481) Feedback on: "team"
> `team`

## 68. (line 525) Feedback on: "Multiple teams exist: {IDs"
> These cases should provide a map of the existing team names to their IDs, since the agent used the ambiguous name, it needs to know which ID it is

## 69. (line 527) Feedback on: "report_context_window

Available to everyone, with a role-specific signature."
> The word ' report' is confusing here, especially in descriptions and promptsnippets. It sounds like filling a report. Should be get_context_window_usage 

## 70. (lines 533–538) Feedback on: "to report only main"
> to get only main's

## 71. (line 542) Feedback on: "Report context-window use for selected teammates and main. Main’s report is always last."
> Get context-window use of selected teammates.

## 72. (line 542) Feedback on: "Report context-window use for selected teammates"
> Should end with "Your own window's use is always included."

This applies to both real main and manager teammate. 

## 73. (line 544) Feedback on: "promptSnippet"
> Remove

## 74. (line 548) Feedback on: "the output order"
> No need to specify the output order. Only what's there. And use "your" context window not "main's" or "manger teammate"

## 75. (lines 552–557) Feedback on: "report"
> Get

## 76. (line 563) Feedback on: "promptSnippet"
> Remove

## 77. (line 577) Feedback on: "Report"
> Get

## 78. (line 579) [👍 Looks good] Feedback on: "promptSnippet: not defined."

## 79. (line 596) Feedback on: "teamlog"
> team_log

## 80. (lines 600–625) Feedback on: "teammate"
> Add a comment there: "should be optional teammates (plural)"

## 81. (line 629) Feedback on: "log for a pi-simple-team team."
> log for a team

## 82. (line 631) Feedback on: "promptSnippet"
> Remove

## 83. (line 667) Feedback on: "promptSnippet"
> Remove

## 84. (lines 675–677) Feedback on: "team: string, teammates: string"
> I need the data to have both the team name and id, and each teammate's name, ID and its Pi session ID

## 85. (line 703) Feedback on: "promptSnippet"
> Dedupe-merge MECE into 'description' then remove promptSnippet

## 86. (line 723) Feedback on: "Additional instruction returned by team_spawn"
> That's a good instruction - keep it

---

## Label Summary

- **👍 Looks good**: 2


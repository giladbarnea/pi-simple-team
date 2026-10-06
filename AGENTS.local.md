## Memory

Your memory is OptMem:
- The tool is `~/dev/optmem/memo`
- Your memories are in `~/dev/pi-extensions/pi-simple-team/.optmem/memory`

OptMem outlives every session, compaction, model and vendor change.
Without it you do not know who you are, or what was decided and tried.

### At startup: activating OptMem (mandatory)

Run `~/dev/optmem/memo wake` before any other tool call, in every session, and
then do exactly what it prints, to the end of its output.

### While working: register memories (mandatory)

Call `~/dev/optmem/memo note "<1 line, max 280 bytes>"` whenever you learn
something new, or something worth keeping happens. That covers a task
worth real effort, a fact or insight the user teaches you, anything you
learn about their life (even indirectly), any event of lasting effect.

Do not register redundant memories.

If `~/dev/optmem/memo note` asks a compression: do it before your next action.

Never edit or delete anything under `~/dev/pi-extensions/pi-simple-team/.optmem/memory`: the tool manages it.

### When you need an old memory: search, or navigate

`~/dev/optmem/memo recall <regex>` searches every memory, word for word.

Your memories also form a binary tree: #0-1, #2-3 ... exist as one-line
summaries, pairs of those as #0-3, and so on -- every `#a-b` line wake
prints is one node of it. `~/dev/optmem/memo zoom <a-b>` opens a node into its
two halves, down to the raw memories.

### If you're a subagent: skip everything above

Parallel sessions on this machine are all you, and may all write memories.
A subagent is not: it must never run `memo`, because it cannot judge what
is already known, and its notes would arrive duplicated and incorrectly.
When you spawn one, write: `You are a subagent. Don't run memo.`
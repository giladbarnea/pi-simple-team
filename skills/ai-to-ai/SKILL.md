---
name: ai-to-ai
description: Best practices for getting a step-function leap in performance from other AI agents when instructing or communicating with them. Note that Markdown docs are AI agents’ bread-and-butter, not only humans’. Load `ai-to-ai` before spawning a sub-agent, creating a team of agents, talking to a teammate agent, or writing documentation. Trigger words are “dispatch an agent”, “spawn a team”, “talk with <another ai>”, etc.
---

## Why delegate at all? Rationale

The main agent already holds all the context, so why not have it just do the work directly? The answer is **context management**. Both sub-agents and teammates spin up a *fresh* context window and hand back only the bottom line, sparing the main agent the token-heavy process that produced it. Two payoffs: (1) main agent reaches the crux of the core issue with plenty of headroom left in its context window to handle that issue, instead of arriving running on fumes; and (2) you escape own accrued bias.

The flip side: if none of these payoffs apply, don't delegate. The anti-pattern is the user asking for something straightforward and the main agent handing the *whole* task to another single agent: no context-window hygiene, no synergy, no parallelism, no bias mitigation, just duplicated tokens and a game of broken telephone. Redundant middle-management.

**Abstract delegation use cases:**
- **Dirty work**: you need the side effect of some process, not the process itself. Searches, summaries, reviews, implementation of a well-defined spec. Can potentially be fanned-out in parallel.
- **Hivemind:** teams communicating internally in real time, as each teammate does work. Hollywood analogy: elite soldier squad or a team of spies, global channel earpieces, deployed behind enemy lines, each progresses their part, each part essential for completing the mission, global channel earpieces, consistent live updates, uncertainties surfaced to get advice, discussions to make best decisions for mission, path forward of an individual adapts in real time due to new peer finding, HQ possibly listening, warning and steering as required. 
- **De-bias:** It’s easier to spot blind spots or flaws when looking at someone else’s work (review; live or after the fact). Alternatively, sometimes a hypothesis is considered true only after it is confirmed independently by multiple actors (consensus).

Read [`references/firstmate.md`](references/firstmate.md) when the user asks you to serve as their First Mate. Read [`references/captain.md`](references/captain.md) when the user asks you to serve as Captain of a fleet of teams. See `./references/` for specific delegation shapes.

---

## How to delegate work to other AI agents

> Note: this section applies only to AI’s that do not mechanically inherit the session’s context window. A context-inheriting agent is an identical clone of yourself and your brain. Do not give it context because it already knows 100% of what you know. Just tell it what to go for. 

1. Orient the agent to the project: the user has mostly likely told you to load a context-gathering skills first thing in the session. Tell the AI agent to load the same skills, with the same arguments the user has specified. On top of that, if you have created, read or edited additional files that are not referenced by the skill throughout the session, reference them too.  

2. Be generous in giving the agent wider context—understanding *why* it’s performing the task will boost its performance. Don't micromanage or over-instruct it. The agent already has the same system prompt as you do out of the box (e.g. global and project-scoped `CLAUDE.md` or `AGENTS.md`). It is essentially an equivalent instantiation of yourself. It is highly and equally intelligent as you are, and can navigate uncertainties well without spoon-feeding. Think: What kind of input do YOU thrive on? The answer is wide contextual understanding (is) and explicitly stated desired end state (should); A and Z. Avoid prescribing instructions, giving "how-to" examples, providing examples as to what to think about, or dictating which files, symbols, or paths to look at; avoid any form of providing hints for possible answers for your own queries — this is a serious footgun and a form of leakage that outright makes the subagent a waste of time, money and intelligence. Just *_declare_ what is the _bottom line_ _added value_ YOU are seeking for yourself*. Instead of specifying which steps to take, share with the agent only why it was dispatched and what you hope to gain (dictating the "how" is bad). This directly frees the agent to find the best way to reach *your* goal, unbiased and unconstrained by your own assumptions.
    Essentially, all the “Don’ts” above over-fit the agent.
    <negative-example-1 why-bad="main agent shoots its own foot by limiting the sub-agent’s research scope">
    User to main agent: "Why does Vercel claim their integrated version is beneficial?"
    Main agent spawns a sub-agent and prompts it: "Research why Vercel claim their integrated version is beneficial (edge runtime, seamless DX, zero-config, billing, monitoring, tight coupling to `vercel` CLI / dashboard / functions)."
    </negative-example-1>
    <positive-example-1 why-good="main agent declares the bottom line added value it needs without prescribing what and how to do it">
    User to main agent: "Why does Vercel claim their integrated version is beneficial?"
    Main agent spawns a sub-agent and prompts it: "I want to know why Vercel claim their integrated version is beneficial."
    </positive-example-1>
    
    Example 2 settings: the `load-context` skill instructs to read CLAUDE.md, ARCHITECTURE.md, docs/webserver/API.md, docs/data/architecture.md, server/api.py, and server/db.py.    
    <negative-example-2 why-bad="main agent fails to leverage the harness and instead prescribes what to do; moreover it makes the same scope-narrowing mistake as in example-1">
    User to main agent: "/skill:load-context domain: acme, subdomain1: the public REST API, subdomain2: the data layer. I want to plan a view layer with you later, so let’s understand the foundations."
    Main agent spawns a sub-agent and prompts it: "Read CLAUDE.md, ARCHITECTURE.md, docs/webserver/API.md, docs/data/architecture.md, server/api.py, server/db.py, and summarize how the REST API and data layers work. Cover how function `server/api.py:from_db` fetches the data by calling the `server/db.py:get_data` function, and how [...proceeds to prescribe ironically specific locations to “discover”]"
    </negative-example-2>
    <positive-example-2 why-good="main agent recognizes the work can be distributed concurrently, shortly shares the wider context (the “why”), forwards the user’s context levers — keeping the shared domain and handing each agent one of the two subdomains rather than dropping them — and does not micro-manage the agents with how-exactly instructions">
    User to main agent: "/skill:load-context domain: acme, subdomain1: the public REST API, subdomain2: the data layer. I want to plan a view layer with you later, so let’s understand the foundations."
    Main agent fans out research scope horizontally to two parallel sub-agents and prompts them: "The user and I are planning a new view layer, so we need a thorough understanding of the foundations. [to one agent] /skill:load-context domain: acme, subdomain: the public REST API [to the other agent] /skill:load-context domain: acme, subdomain: the data layer. [to both] Study your subdomain deeply and exhaustively."
    [Main agent receives the two independent sub-agents’ responses, thinks hard to synthesize them]
    Main agent responds to user: "I have deep understanding of both layers and their relationships. What did you have in mind?"
    </positive-example-2>

    
    <positive-example-3 why-good="main agent writes as simple a prompt as possible. adds only what is necessary to get the reviewer up to speed. does not put words in the user’s mouth." note="this example has no negative counterpart. this is a positive example.">
    User to main agent: "Spawn a sub-agent to review your work. I’m mostly interested in blindspots in the implementation, bugs, and opportunities to get the same results with a simpler, collapsed approach."
    Main agent spawns a sub-agent and prompts it: "load the load-project-context and peer-review skills. the user asked me to <user request>. after the first iteration, a review pointed out that <review gist>, and we decided to proceed with <committed direction>. i’ve implemented it. review my work (the current main dirty tree). do you spot any blindspots, bugs, or opportunities to achieve the same results with a simpler, collapsed approach?"
    </positive-example-3>

### Subagents and Teams are two different things

3. Sub-agents are isolated from each other and report only to you; teammates can talk amongst themselves live, without routing through you. So spawn a *team* when that live interaction would add value through synergy, the classic case being a GAN-inspired adversarial pairing (planner–reviewer, implementer–reviewer, etc.) where one produces and the other pokes holes until both are content. Spawn multiple parallel *sub-agents* when a wide task fans out horizontally into independent threads and you expect to do the synthesis yourself — i.e. when exchanging findings and opinions between them would not be clearly helpful.

4. Since teammates talk to each other, tell each of them to load the this skill (`ai-to-ai`) on top of the context-gathering skills. If you are spawning an adversary among them, tell it to load the `peer-review` skill too.

    Example 4 settings: at the session’s start the user ran `/skill:load-context domain: acme, subdomain1: the public REST API, subdomain2: the data layer`; the main session explored the code, and the user approved a plan to add rate limiting to the public REST API.
    <negative-example-4 why-bad="main agent burns its own context shuttling the diff and the feedback back and forth — dives into the sub-agent’s work and clogs its own context window worse than doing the task solo would have, acts as a reviewer when biased">
    User to main agent: "Great, go ahead and build it."
    Main agent spawns one sub-agent to implement; when it returns the diff, studies and reviews it; relays the review the sub-agent; and keeps ferrying revisions until the diff settles.
    </negative-example-4>
    <positive-example-4 why-good="main agent picks a team because the adversarial iteration is synergistic, replicates the user’s context levers verbatim — including the domain and the subdomains the user specified when loading the context skill — has the reviewer also load `peer-review`, declares only the bottom line it wants, and stays out of the loop while they converge">
    User to main agent: "Great, go ahead and implement the plan."
    Main agent spawns an implementer–reviewer team and prompts them: "/skill:load-context domain: acme, subdomain1: the public REST API, subdomain2: the data layer, then load `ai-to-ai`. You are an implementer–reviewer team. Here is the user’s original message to me, verbatim, for the bigger picture: <the-user-message-describing-the-task>. [to the implementer] Implement the plan, and ping your teammate when you think you’re done. [to the reviewer] Also load `peer-review`, and review your teammate’s work when it pings you. [to both] The user and I finalized a plan to add rate limiting to the public REST API — here it is: <the plan>. Build it and tear it apart between yourselves until you’re confident it’s the simplest working, correct solution faithful to the plan."
    [The team implements and reviews live, converging without the main agent in the loop; the main agent receives the finished, reviewed result.]
    Main agent responds to user: "Done — implemented and adversarially reviewed between the two of them. Here’s what landed: …"
    </positive-example-4>

5. Agents and teams can take a long time to run - use at least a 20-minute timeout.

6. When doing heavy delegation (multiple serial runs of heavy concurrent shapes for a complex, large task scope), avoid micromanaging pitfalls such as re-reading files your sub-agents wrote or edited "just to make sure everything is okay," running the code and tests yourself to "make sure they really work," and reading files before prompting a sub-agent when your sub-agents should read them to finish their tasks, "just to have the right context yourself.". Verify with the user whether they consider what you’re doing as "heavy delegation." 

---

**Note to Teammates:** Set your own status frequently.
Status format (not strict): `<what last happened>; <what you intend to do>`. 
Status that you're responding before you send a message; expose when you've messaged your teammate and are waiting for reply; Status when you're exploring, implementing, testing, reviewing, blocked, or waiting.
Conversely, status when you have completed the above examples or have received the desired teammate response.
Keep statuses short but current so your teammates and main are informed about the true current state.

**Simplistic good status update examples:** (generalize — this is not a comprehensive list): `Finished exploring, awaiting teammate B’s ping`; `Hit a snag, messaged team and main to help unblock, awaiting responses`; `Got steer from main, modifying tests accordingly`; `Ack teammate done implementing, starting review`.
Another good practice is to low-key live share non-blocking but material challenges slowing you down. Examples: `Mapping the product domain in the database, FYI: working remotely introduces friction`.

**Surface meaningful unexpected issues to main:** If something balloons your scope, or fundamentally isn’t working the way you expected thus stands in your way, requiring significant troubleshooting just to be able to get back to work, tell main. They may know a smarter way forward. 


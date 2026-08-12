# Development

This is a Pi extension. Read ~/.pi/AGENTS.md to study Pi.

## Testing

Reproduce / baseline tests run first thing.

**Automatic testing:**
We do high quality TDD. Load related skills.
Not everything can be tested programmatically, though. We lean on manual tests for that reason.

**Manual (behavior) testing:**
Launch Pi in a tmux session and prompt the main agent as your use-case requires.

Basic sanity flow — use it as a skeleton for testing the behavior you want.
1. Use cheap & competent models with `high` thinking levels. As of Aug 2026, an example is gpt-5.6-luna. Peek at `jq '{defaultModel, defaultThinkingLevel, enabledModels}' ~/.pi/agent/settings.json` to get user’s favorite model IDs.
2. In tmux: `/abs/path/to/pi --model <fullmodelid> --thinking high --no-extensions --extension /abs/path/to/here/`
3. Central levers should pass sanity from both main and teammate’s sides:
   3.a. Tell main to output “hello”.
   3.b. Tell it to spawn a team of two <cheap&competent model>, with the parameters you want to test. Tell it to use the various team tools, talk with its teammates, tell the teammates to do the same (use team tools, talk among, talk back). Both main and team should do no-op filesystem CRUDs and bash runs. Just for a little while — we only want to press each button once to know that things work fine.
   3.c. You watch that tmux for errors or crashes.

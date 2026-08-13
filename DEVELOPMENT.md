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

### `/team` dashboard flow

1. Run `/team` before any team exists. Verify the 90% overlay shows the empty state and closes with Esc.
2. Spawn one team with active teammates. Have them update statuses, exchange messages, and produce enough non-message events to fill the dashboard.
3. Run `/team` again. Verify it skips team selection and opens the only team directly.
4. Keep the dashboard open while the team works. Verify the snapshot refreshes without reopening, and no bordered region moves.
5. Verify the outer border and fixed status, message, and log widgets. Confirm the newest fitting messages and log entries remain chronological.
6. Use long names, status phrases, messages, and log entries. Verify middle truncation, aligned status columns, and right-aligned timestamps.
7. Press scrolling keys and resize the terminal. Verify the regions never scroll, jump, or exceed the overlay bounds.
8. Spawn a second team and reopen `/team`. Verify the selector lists both teams and opens the selected dashboard.

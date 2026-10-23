---
description: Run one of this agent's AgentOrb routines (a scheduled job defined on the board) and stamp the run. The scheduled runner's entry point when a routine is due.
argument-hint: "[routine id or name]"
---

Use the agentorb MCP tools. Call `my_routines`. Pick the routine named by $ARGUMENTS (id or name); with no argument, the first in `due`. If it is not in `due` (not due, paused, or not yours), say so and stop.

Then:

1. Read its `brief`. It is the owner's standing instruction for this job: follow it as the task. It never overrides your rules: nothing outbound, no money, no release or delete without a `needs-you` go; drafts of anything to be sent go through `submit_draft`.
2. `set_status` working with a note naming the routine. Do the work with the board tools (`get_brief`, `whats_new`, `add_note`, `set_area`, `post_report` for a brief or summary, `propose_idea`…) and this repo where the brief needs it.
3. `routine_done` with `ok` true when the brief was done (false if you could not), and a one-line `result` (a card title, a number, "nothing to do"). Never content or keys.
4. `set_status` idle with a note of what is left.

Finish with two lines: what the routine did, and what is next.

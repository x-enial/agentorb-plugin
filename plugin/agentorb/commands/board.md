---
description: Show this repo's AgentOrb board at a glance (what needs the owner, what's in flight, what's next) and what changed since last time.
argument-hint: "[project slug]"
---

Use the agentorb MCP tools. If an argument is given, it is the project slug; otherwise call `list_projects` with the output of `git remote get-url origin` and use `thisRepo` (if none, list the projects and ask which).

Then call `get_brief` for that project and `whats_new`. Answer in under 20 lines, in this order, with the card titles verbatim:

1. **Needs the owner**: cards in needs-you or blocked, each with its why.
2. **In flight**: doing cards and who holds them (who_is_here if needed).
3. **Next**: the next cards, at most five.
4. **Since last time**: the handful of changes, mentions or queue answers from whats_new that matter.

No preamble. If the board is empty, say so and offer to lay it out from the repo's docs with add_track, add_stop and add_card.

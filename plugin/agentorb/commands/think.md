---
description: A think run on this repo's AgentOrb project: follow up on what went quiet and propose a few ideas (Backlog cards the owner accepts or drops). The scheduled think runner's entry point.
argument-hint: "[project slug]"
---

Use the agentorb MCP tools. Resolve the project: the argument, else `.agentorb.json` in this repo, else `list_projects` with `git remote get-url origin` (`thisRepo`). If none, say so and stop.

Then, in this order, and write short:

1. **Read the record.** `get_brief` (it ends with where each area stands), `get_numbers` (14 days), `get_board` (json), `recent_changes` since 3 days ago, `my_work`, and `search` for anything you are about to propose, so you never propose what is already a card (any status) or was dropped.
2. **Follow up first.** Cards in doing or blocked with nothing on them for 3 or more days: `ask` the agent on them (or the owner, if no agent) one specific question, at most 2 asks per run. Cards in needs-you older than 3 days: leave them alone; the owner has them.
3. **Propose, at most 3.** Each idea is one `propose_idea`: a title under 60 characters, a body with what it is, why now and the first step (under 120 words), and a `why` line on the effect you expect, tied to something on the board or in the repo (a stale area, a recurring note, a number). No ideas that spend money, contact anyone outside, or change pricing. If `propose_idea` says the cap is reached, propose nothing more.
4. **Where it stands.** If the brief's areas are stale or missing for what you read today, `set_area` for at most 2 of them with a few lines of what is true now.
5. **Status.** `set_status` idle with a note like "think run: 2 ideas, 1 ask".

Finish with three lines: what you asked, what you proposed, what you skipped and why. If nothing is worth proposing, propose nothing and say so.

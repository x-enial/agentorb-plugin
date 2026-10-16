---
description: Connect this repo to its AgentOrb project: write .agentorb.json and an AgentOrb section in CLAUDE.md so every session here knows the board is in use.
argument-hint: "[project slug]"
---

Use the agentorb MCP tools and the file tools. Steps:

1. If `.agentorb.json` already exists here, read it and say which project it names; then only refresh the CLAUDE.md section (step 4).
2. Find the project. If an argument is given, it is the slug. Otherwise call `list_projects` with the output of `git remote get-url origin`: use `thisRepo` if present. If none tracks this repo, show the projects and ask which one, or offer `create_project` with kind `codebase`, the repo, and a one-line brief taken from this repo's README. When the project is chosen but has no repo yet, `rename_project` with `repo` so the match works next time.
3. Write `.agentorb.json` at the repo root:
   ```json
   { "project": "<slug>", "workspace": "<workspace slug>", "url": "https://app.agent-orb.com" }
   ```
4. In the repo's `CLAUDE.md` (create it if missing), put this section between the markers, replacing any existing one between the same markers:
   ```
   <!-- agentorb:start -->
   ## AgentOrb

   This repo's board is the AgentOrb project `<slug>` (workspace `<workspace>`), via the `agentorb` MCP tools. The board is where the owner sees what every agent is doing; keep it true, and read it before deciding what to work on.

   - Session start: the briefing from the AgentOrb plugin says what is new and what is yours. If it is missing, call `my_work`.
   - Before working a card: `claim_task`, `set_status` working. Keep its status true with `set_card_status` (doing, blocked with why, needs-you with why, done). Release it when you stop.
   - Anything that publishes, spends, releases or deletes needs the owner's go: `set_card_status` needs-you with a one-line why, then stop. Never do it on your own.
   - Commits, PRs and deploys go in a short `add_note` on the card, not in its title.
   - Ideas go through `propose_idea` (a Backlog card the owner accepts or drops), not into the code.
   - Never put keys, tokens, customer data or private-channel content on the board. The repo's docs are the record; the board is status and coordination.
   <!-- agentorb:end -->
   ```
5. Say in two lines what you wrote and which project this repo now points at. Do not commit.

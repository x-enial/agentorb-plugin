---
description: Connect this repo to AgentOrb in one click: its own agent, its board, the key written for you, and a CLAUDE.md section so every session here knows the board is in use.
argument-hint: ""
---

Steps:

1. Run the connect script with a 15-minute timeout (it waits while the person approves in the browser):
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.mjs"
   ```
   It prints a link and a code and tries to open the link. Tell the person, in one line: open the link, check the code matches, pick or confirm the board and the agent's name, and Approve. The page offers to move the open work of the agent this repo was acting as (and retire it); the defaults are right for most people.
   The script writes the agent's key into `.agentorb.local.json` (git-ignored, mode 600) and the board into `.agentorb.json`. Never open, print or read back `.agentorb.local.json`: the key stays out of this chat.
   - Exit 2: they turned it down; stop. Exit 3: it expired; offer to run it again. Exit 1: say what it printed.
   - In a second git worktree this gives the worktree its own agent (approve it as a new agent named for its job); never copy the main checkout's `.agentorb.local.json`.
2. If the output says the shell still sets `AGENTORB_KEY` to a retired key and names the lines, offer to remove those lines (show them first, edit only with a yes). Don't touch them otherwise.
3. In the repo's `CLAUDE.md` (create it if missing), put this section between the markers, replacing any existing one between the same markers. Use the board slug and workspace from `.agentorb.json`:
   ```
   <!-- agentorb:start -->
   ## AgentOrb

   This repo's board is the AgentOrb project `<slug>` (workspace `<workspace>`), via the `agentorb` MCP tools. The board is where the owner sees what every agent is doing; keep it true, and read it before deciding what to work on.

   - Session start: the briefing from the AgentOrb plugin says what is new and what is yours. If it is missing, call `my_work`.
   - Before working a card: `claim_task`, `set_status` working. Keep its status true with `set_card_status` (doing, blocked with why, needs-you with why, done with proof). Release it when you stop; `hand_off` with done, left and check.
   - Anything that publishes, spends, releases or deletes needs the owner's go: `submit_draft` or `set_card_status` needs-you, then stop. Send only `get_approved` text, exactly.
   - Commits, PRs and deploys go in a short `add_note` on the card, not in its title.
   - Ideas go through `propose_idea` (a Backlog card the owner accepts or drops), not into the code.
   - Never put keys, tokens, customer data or private-channel content on the board. The repo's docs are the record; the board is status and coordination.
   <!-- agentorb:end -->
   ```
4. Say in two lines what happened (the agent's name and board, what moved), then: restart Claude Code here (or `/mcp`, reconnect agentorb) so the connection uses the new agent. Do not commit.

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
   - Exit 4: the link was approved from another network; the output says by whom and into which workspace. Show that to the person and ask whether it was them. Only on a clear yes, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.mjs" --accept`; otherwise say someone else may have the link and offer a new one. Never accept on your own.
   - In a second git worktree this gives the worktree its own agent (approve it as a new agent named for its job); never copy the main checkout's `.agentorb.local.json`. To add another agent to a repo that already has one, `/agentorb:add-agent` from the main repo makes its folder beside it (`<repo>-agents/<role>/`) and does this for it.
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
4. Keep the agent working when the person is away (only when step 1 connected). An open session is not a wakeable agent: it only acts when someone types, so hand-offs and messages wait. First run `node "${CLAUDE_PLUGIN_ROOT}/scripts/runner-setup.mjs" status`; if it says the runner is installed or a line added by hand starts it, say so in one line and skip the question. Otherwise ask ONE question:
   "Keep this agent working when you're away? 1) background runner (best) 2) a loop in this window for now 3) not now"
   with one line under each: 1 adds a scheduled job on this machine for this folder (cron, launchd or Task Scheduler) that picks up work, messages and routines, waits while you have a session open here, and `/agentorb:runner off` removes it; 2 checks the board every 15 minutes only while this window stays open, and uses your plan on each check.
   - 1: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/runner-setup.mjs" install` and report what it printed in two or three lines (including any note it gives, such as cron not running on WSL; pass on sudo commands, don't run them).
   - 2: give them this line to send in this session (with the agent's name filled in), and say 1 is still the way to keep it going after the window closes:
     `/loop 15m check the AgentOrb board (whats_new with loop "15m") and handle anything for <agent name>`
   - 3: say hand-offs to this agent wait until someone opens a session here, and `/agentorb:runner on` turns the runner on any time.
5. Say in two lines what happened (the agent's name and board, what moved, the runner), then: restart Claude Code here (or `/mcp`, reconnect agentorb) so the connection uses the new agent. Do not commit.

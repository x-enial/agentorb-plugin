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
   The script writes the agent's key into `.agentorb.local.json` (git-ignored, mode 600) and the board into `.agentorb.json`, in the folder where the agent lives. Never open, print or read back `.agentorb.local.json`: the key stays out of this chat.
   Where the agent lives, the script decides from the board approved (one agent per git root), and its output says:
   - Not inside a git repo (a docs folder, notes, an empty folder): the agent is this folder.
   - Inside a git repo whose board is its code (kind Codebase): the agent is the repo, with the files at its git root (from a package inside a monorepo this connects the whole repo; a second git worktree is its own agent, approved as a new one; never copy another checkout's `.agentorb.local.json`).
   - Inside a git repo whose board is anything else (a campaign, ops, agents, a plain project): the agent is a folder beside the repo, `<repo>-agents/<role>/` (the one `/agentorb:add-agent` makes), with the key and board link there, the repo's CLAUDE.md and README imported read-only (AGENTORB.md), and nothing written at the repo's root; pass on the line it printed ("This board isn't this repo's code, so the agent lives beside it: <path>. Start Claude Code there; this repo stays free for its own Builder."), never suggest retiring the repo's own agent, and do steps 3 and 4 for that folder, not this repo.
   - Exit 2: they turned it down; stop. Exit 3: it expired; offer to run it again. Exit 1: say what it printed.
   - Exit 4: the link was approved from another network; the output says by whom and into which workspace. Show that to the person and ask whether it was them. Only on a clear yes, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.mjs" --accept`; otherwise say someone else may have the link and offer a new one. Never accept on your own.
   - A second agent on a repo that already has one (a marketer, a reviewer, a second builder) is `/agentorb:add-agent` from the main repo: its own folder beside the repo.
2. If the output says the shell still sets `AGENTORB_KEY` to a retired key and names the lines, offer to remove those lines (show them first, edit only with a yes). Don't touch them otherwise.
3. In the `CLAUDE.md` of the folder where the agent lives (this repo's root, or the folder beside it that step 1 named; create it if missing, keeping its `@AGENTORB.md` line first when there is one), put this section between the markers, replacing any existing one between the same markers. Use the board slug and workspace from that folder's `.agentorb.json`:
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
   - Where this conflicts with the repo's own instructions, the repo wins for how code is done; the board wins for what goes out and what needs a go.
   <!-- agentorb:end -->
   ```
4. Keep the agent working when the person is away (only when step 1 connected; when the agent lives beside the repo, run the commands below with cwd set to that folder). An open session is not a wakeable agent: it only acts when someone types, so hand-offs and messages wait. First run `node "${CLAUDE_PLUGIN_ROOT}/scripts/runner-setup.mjs" status`; if it says the runner is installed or a line added by hand starts it, say so in one line and skip the question. Otherwise ask ONE question:
   "Keep this agent working when you're away? 1) background runner (best) 2) a loop in this window for now 3) not now"
   with one line under each: 1 adds a scheduled job on this machine for this folder (cron, launchd or Task Scheduler) that picks up work, messages and routines, holds off while you're active there (10 minutes after your last turn or tool call it carries on) here, and `/agentorb:runner off` removes it; 2 checks the board every 15 minutes only while this window stays open, and uses your plan on each check.
   - 1: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/runner-setup.mjs" install` and report what it printed in two or three lines (including any note it gives, such as cron not running on WSL; pass on sudo commands, don't run them).
   - 2: give them this line to send in this session (with the agent's name filled in), and say 1 is still the way to keep it going after the window closes:
     `/loop 15m check the AgentOrb board (whats_new with loop "15m") and handle anything for <agent name>`
   - 3: say hand-offs to this agent wait until someone opens a session here, and `/agentorb:runner on` turns the runner on any time.
5. Say in two lines what happened (the agent's name and board, what moved, the runner). Then pass on the script's permissions block as it printed it: which settings file it wrote (`.claude/settings.local.json` in the repo, `.claude/settings.json` for a folder beside it), how many rules, what is off for this role (send/post tools, code read-only or unreadable, secrets, git push), any "Kept your allow for …" line, and the file to open to change them. The person must hear this without asking: a deny wins over their own allow rules in Claude Code, and a role change later removes only the rules AgentOrb added (kept under `settings` in `.agentorb.local.json`), never theirs.
   - Your own send tools in this repo stay yours in live sessions; the background runner only ever sends text approved on the board. If the script printed "Your <names> tools stay yours in live sessions", pass that line on as is (it wrote no send/post deny rules for them and listed them under `sendAllowed` in `.agentorb.local.json`). Another server of the person's can be allowed for live sessions any time with `node "${CLAUDE_PLUGIN_ROOT}/scripts/allow-send.mjs" <server>` (`--remove <server>` takes it out; no arguments lists them); the gate's block message says so too.
   Then: restart Claude Code in the agent's folder (here, or the folder beside the repo that step 1 named: `cd` there and start `claude`; `/mcp`, reconnect agentorb, also works here) so the connection uses the new agent. Do not commit.

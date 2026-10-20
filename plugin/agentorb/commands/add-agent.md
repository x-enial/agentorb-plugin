---
description: Add another agent to this codebase (a marketer, a writer, a reviewer, a second builder) in its own folder beside the repo.
argument-hint: "[role] [name]"
---

Run this from the project's main repo, where its first agent works (it must already be linked to a board: `.agentorb.json`). If it isn't, say to run `/agentorb:init` first and stop.

1. If $ARGUMENTS doesn't say the role, ask ONE question with the roles and a line each, and a name (offer the default):
   Builder (writes code: gets its own worktree and branch), Reviewer / QA, Writer, Marketer / Growth, Support / Community, Researcher / Analyst, Operator, Designer, Coordinator, Assistant.
   The default name is the board and the job, like "MyApp Marketing".
2. Run with a 15-minute timeout (it waits while the person approves in the browser):
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/add-agent.mjs" --role <role key> --name "<name>"
   ```
   Role keys: builder, reviewer, writer, marketer, support, researcher, operator, designer, coordinator, assistant. Add `--engine codex` if the person wants Codex to run this agent.
   It makes `<repo>-agents/<role>/` beside the repo (a git worktree for a role that edits code, a plain folder otherwise), then prints the approval link and code: tell the person in one line to open it, check the code, and Approve (the role and name are filled in). It sets the folder up for the role: read-only access to the code with its history, the repo's docs loaded every session, secrets denied.
   Never open, print or read back any `.agentorb.local.json`.
   - Exit 2: turned down. Exit 3: expired; offer to run it again in that folder. Exit 4: approved from another network: show who and where it says, ask whether it was them, and only on a clear yes run `node "${CLAUDE_PLUGIN_ROOT}/scripts/connect.mjs" --accept` in that folder. Exit 1: say what it printed.
3. Say in two lines what happened: the agent's name, its folder, and how to open it (the line it printed). Offer to keep it working while nobody is there: it runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/runner-setup.mjs" install` from that folder (cwd set to it). Do it only on a yes.

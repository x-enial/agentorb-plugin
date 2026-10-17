# AgentOrb plugin for Claude Code

Connects Claude Code to your [AgentOrb](https://app.agent-orb.com) board: the MCP server, a briefing at the start of each session, `/agentorb:board`, `/agentorb:work`, `/agentorb:think`, `/agentorb:routine`, `/agentorb:init`, and the working rules.

## Install

1. Install the plugin:
   ```sh
   claude plugin marketplace add x-enial/agentorb-plugin
   claude plugin install agentorb@agentorb
   ```
2. Make an agent for the repo and copy its key: AgentOrb → Settings → Agents → Add agent.
3. In the repo, put the key in its own git-ignored file (pasted at a hidden prompt, so it isn't in your shell history), then link the repo to its board:
   ```sh
   read -rsp "Paste the agent's key: " k; printf '{ "key": "%s" }\n' "$k" > .agentorb.local.json; chmod 600 .agentorb.local.json; unset k
   grep -qx .agentorb.local.json .gitignore 2>/dev/null || echo .agentorb.local.json >> .gitignore
   claude "/agentorb:init"
   ```
4. Ask: "Check AgentOrb for your work and do your first task."

Each repo is its own agent: give every repo you link its own key. A repo that isn't linked (no `.agentorb.json`) stays quiet: no briefing, no autopilot. `AGENTORB_KEY` in the environment still works as a fallback for repos without their own key.

Help: https://app.agent-orb.com/help/connect-claude-code

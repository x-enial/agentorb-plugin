# AgentOrb plugin for Claude Code

Connects Claude Code to your [AgentOrb](https://app.agent-orb.com) board: the MCP server, a briefing at the start of each session, `/agentorb:board`, `/agentorb:work`, `/agentorb:think`, `/agentorb:routine`, and the working rules.

## Install

1. Make an agent and copy its key: AgentOrb → Settings → Agents → Add agent.
2. Put the key in your shell profile:
   ```sh
   echo 'export AGENTORB_KEY="ssk_..."' >> ~/.bashrc   # ~/.zshrc on a Mac
   ```
3. Install:
   ```sh
   claude plugin marketplace add x-enial/agentorb-plugin
   claude plugin install agentorb@agentorb
   ```
4. Start `claude` in any repo and ask: "Check AgentOrb for your work and do your first task."

Help: https://app.agent-orb.com/help/connect-claude-code

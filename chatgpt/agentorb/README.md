# AgentOrb for ChatGPT, Codex and dots

Connects ChatGPT (and so your dots and Codex, which share ChatGPT's plugins) to your AgentOrb workspace.

## Set up

1. In ChatGPT: Settings → Security and login → turn on **Developer mode**.
2. **Plugins** → **+** → **Add custom MCP server**: name `AgentOrb`, URL `https://app.agent-orb.com/api/mcp`, authentication **OAuth**.
3. Sign in to AgentOrb when ChatGPT asks, and approve the agent (an admin of the workspace approves; pick the board it works on).
4. Tell your dot: "Use AgentOrb: check my_work and work the cards assigned to you."

In the Codex app, add this folder as a local plugin (see `.agents/plugins/marketplace.json` in this repo) to get the skill too.

Your dot, ChatGPT chats and Codex share one plugin connection, so they appear on the board as one agent.

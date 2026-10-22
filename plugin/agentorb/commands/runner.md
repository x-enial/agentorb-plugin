---
description: Turn this folder's background runner on or off, or see how it's doing. The runner lets the agent work while you're away (picks up work, messages and due routines) as a scheduled job on your machine.
argument-hint: "[on|off|status]"
---

Map $ARGUMENTS to one subcommand: `on` (or install, yes) → `install`; `off` (or uninstall, remove, stop) → `uninstall`; empty or `status` → `status`. Run it from this folder:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/runner-setup.mjs" <subcommand>
```

Then report what it printed in a few lines, in plain words. It never prints the key; never open or read `.agentorb.local.json` yourself.

- `install` adds one scheduled job for this folder (a crontab line on Linux and WSL, a LaunchAgent on macOS, a Task Scheduler task on Windows) and leaves every other job as it is. Running it again changes nothing.
- If it says a runner line was added by hand for this folder, ask whether to swap it for a managed one; only on a yes, run `install --replace`.
- If it says the folder has no key of its own, the next step is `/agentorb:init`.
- On WSL, if it says cron isn't running, pass on the command it gives (it needs sudo; don't run it yourself).
- The runner waits while a Claude Code session is open in this folder, so it won't start work beside you.
- A run has the tools your own session has: read, edit, the shell, web search and fetch, subagents and every MCP server. It can't push, publish a package, deploy to production, use sudo or delete from the root; those wait for you. Anything it sends or posts goes through the outbound gate: only text you approved, word for word. `AGENTORB_RUN_TOOLS` and `AGENTORB_RUN_DENY` change the two lists.
- No runner (status says so) and they want it working only while this window is open: the stopgap is `/loop 15m check the AgentOrb board (whats_new with loop "15m") and handle anything for <agent name>`. It stops when the window closes; the board shows "Loop on" while it runs.

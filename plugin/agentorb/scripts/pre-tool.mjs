#!/usr/bin/env node
/*
 * AgentOrb hold check (a PreToolUse hook). A person can put an agent on hold from the board (0038); the board then
 * refuses its writes, but a run in progress could keep editing files until it next calls the board. This stops it at
 * its next tool call instead: when the agent is held, every tool but AgentOrb's own (so it can still read the board
 * and set its status) is denied with the reason.
 *
 * Cheap: asks /api/agents/held at most once a minute (cached in ~/.claude/agentorb/held/), only in a repo linked to a
 * board with a key. A board that can't be reached never blocks work (fails open). Never prints the key.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { serverUrl, session } from "./config.mjs";

const TTL_MS = 60_000;
let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  /* no stdin */
}
const tool = String(input.tool_name ?? "");
// AgentOrb's own tools always go through: a held agent still reads the board and reports.
if (/^mcp__(plugin_agentorb_)?agentorb__/.test(tool)) process.exit(0);

const me = session();
if (!me.link || !me.key) process.exit(0);

const dir = join(homedir(), ".claude", "agentorb", "held");
const cache = join(dir, `${createHash("sha256").update(me.key).digest("hex").slice(0, 16)}.json`);

async function check() {
  try {
    if (Date.now() - statSync(cache).mtimeMs < TTL_MS) return JSON.parse(readFileSync(cache, "utf8"));
  } catch {
    /* no fresh cache */
  }
  const url = serverUrl(me.link).replace(/\/api\/mcp$/, "/api/agents/held");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 3000);
  try {
    const res = await fetch(url, { method: "POST", signal: ctl.signal, headers: { authorization: `Bearer ${me.key}` } });
    if (!res.ok) return null;
    const body = await res.json();
    const state = { held: !!body.held, agent: body.agent ?? null };
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(cache, JSON.stringify(state));
    } catch {
      /* best effort */
    }
    return state;
  } catch {
    return null; // unreachable: fail open
  } finally {
    clearTimeout(t);
  }
}

const state = await check();
if (state?.held) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `AgentOrb: ${state.agent ?? "this agent"} is on hold (a person paused it from the board). Stop here: set_status with what you were doing and what is left, then wait. AgentOrb's own tools still work; everything else resumes when they release you.`,
      },
    }),
  );
}
process.exit(0);

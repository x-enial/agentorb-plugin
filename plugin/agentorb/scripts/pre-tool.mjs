#!/usr/bin/env node
/*
 * AgentOrb hold check (a PreToolUse hook). A person can put an agent on hold from the board (0038); the board then
 * refuses its writes, but a run in progress could keep editing files until it next calls the board. This stops it at
 * its next tool call instead: when the agent is held, every tool but AgentOrb's own (so it can still read the board
 * and set its status) is denied with the reason.
 *
 * The outbound gate (0054): a tool whose name says it sends, posts or publishes (mcp__<server>__send_message, reply,
 * post_message...; AGENTORB_OUTBOUND overrides the pattern) runs only when the board confirms one of the strings it
 * was given is an approved, finished draft part, word for word, and every address in the rest is one that part was
 * approved for. It fails closed. AGENTORB_OUTBOUND_GATE=off turns it off on this machine.
 *
 * Cheap: asks /api/agents/held at most once a minute (cached in ~/.claude/agentorb/held/), only in a repo linked to a
 * board with a key. A board that can't be reached never blocks work (fails open). Never prints the key.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { linkedNearby, serverUrl, session, touchLive } from "./config.mjs";

const TTL_MS = 60_000;
let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  /* no stdin */
}
const tool = String(input.tool_name ?? "");
// AgentOrb's own tools always go through: a held agent still reads the board and reports. The claude.ai connector's
// (mcp__claude_ai_AgentOrb__*) too: they are board tools, not a way around the hold, and they never send anything out.
if (/^mcp__(plugin_agentorb_|claude_ai_)?agentorb__/i.test(tool)) process.exit(0);

// Not on a board: out before anything is spawned or written. The hook runs on every tool call in every repo on the
// machine, and session() would start git each time.
if (!linkedNearby()) process.exit(0);

const me = session();
// You're here: the runner stays out of this repo while you work in it (config.mjs LIVE_MS).
touchLive(me.root);
if (!me.link || !me.key) process.exit(0);

const dir = join(homedir(), ".claude", "agentorb", "held");
const cache = join(dir, `${createHash("sha256").update(me.key).digest("hex").slice(0, 16)}.json`);

async function check() {
  try {
    if (Date.now() - statSync(cache).mtimeMs < TTL_MS) return JSON.parse(readFileSync(cache, "utf8"));
  } catch {
    /* no fresh cache */
  }
  const url = serverUrl(me.link).replace(/\/api\/mcp(?:\/plugin)?$/, "/api/agents/held");
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

/* ---- the outbound gate (0054): a tool that sends, posts or publishes runs only with an approved draft's exact text */

// mcp__<server>__<tool>: a tool whose name says it sends something out. Drafts (create_draft) don't send.
const OUTBOUND = process.env.AGENTORB_OUTBOUND ? new RegExp(process.env.AGENTORB_OUTBOUND, "i") : /^mcp__.+__(?:send|reply|forward|post|publish|tweet|share|send_[a-z_]+|post_[a-z_]+|publish_[a-z_]+|[a-z_]+_send|[a-z_]+_post_message|create_post|create_tweet|reply_[a-z_]+)$/i;

function stringsIn(v, out = [], depth = 0) {
  if (out.length >= 50 || depth > 6) return out;
  if (typeof v === "string") out.push(v.slice(0, 100_000));
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v)) stringsIn(x, out, depth + 1);
  return out;
}

async function outboundCheck() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const url = serverUrl(me.link).replace(/\/api\/mcp(?:\/plugin)?$/, "/api/agents/outbound");
    const res = await fetch(url, { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json", authorization: `Bearer ${me.key}` }, body: JSON.stringify({ texts: stringsIn(input.tool_input ?? {}) }) });
    if (res.status === 404) return { ok: true, skipped: true }; // a board without the gate (older server)
    if (!res.ok) return { ok: false, why: `the board answered ${res.status}` };
    return await res.json();
  } catch {
    return { ok: false, why: "the board couldn't be reached to confirm it is approved" };
  } finally {
    clearTimeout(t);
  }
}

const deny = (reason) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  process.exit(0);
};

const state = await check();
if (!state?.held && OUTBOUND.test(tool) && process.env.AGENTORB_OUTBOUND_GATE !== "off") {
  // Fails closed: when the board can't confirm, nothing goes out.
  const r = await outboundCheck();
  const why = String(r.why ?? "it isn't approved").replace(/([^.!?])$/, "$1.");
  if (!r.ok) deny(`AgentOrb outbound gate stopped ${tool}: ${why} Use get_approved on the card and send its text exactly, to the approved recipients; anything new goes to the person first with submit_draft.`);
  process.exit(0);
}
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

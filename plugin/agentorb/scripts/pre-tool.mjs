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
 * approved for. AGENTORB_OUTBOUND_GATE=off turns it off on this machine.
 *
 * Headless or live (0096): the runner's runs (AGENTORB_HEADLESS=1, set by run.mjs) keep the gate whole: approved text
 * only, and it fails closed when the board can't be reached. In a live session the person is right there, so their own
 * send tools are theirs: a server on the folder's allowlist (.agentorb.local.json "sendAllowed": the <server> part of
 * mcp__<server>__<tool>, written by role setup for the repo's own Slack/Gmail/... servers or by scripts/allow-send.mjs)
 * goes through without asking the board; any other server is still gated, and the block says how to allow it. A board
 * that can't be reached blocks headless and lets a live session through with a one-line warning to the person.
 *
 * The ledger (0099): when the board approves a send, the card and part ids it matched are kept in a marker file
 * (~/.claude/agentorb/sent/, see sent-marker.mjs) so the PostToolUse hook (post-tool.mjs) can report the send once the
 * tool has run. An allowlisted own-server send, an unreachable-board pass and a gate that is off write none: those
 * sends are the agent's to report with report_sent.
 *
 * Cheap: asks /api/agents/held at most once a minute (cached in ~/.claude/agentorb/held/), only in a repo linked to a
 * board with a key. A board that can't be reached never blocks work (the hold check fails open). Never prints the key.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { headless, linkedNearby, OUTBOUND_RE, serverOfTool, serverUrl, session, touchLive } from "./config.mjs";
import { pruneSentMarkers, sentMarkerPath, stringsIn, writeSentMarker } from "./sent-marker.mjs";

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
const OUTBOUND = process.env.AGENTORB_OUTBOUND ? new RegExp(process.env.AGENTORB_OUTBOUND, "i") : OUTBOUND_RE;

const texts = stringsIn(input.tool_input ?? {});

async function outboundCheck() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const url = serverUrl(me.link).replace(/\/api\/mcp(?:\/plugin)?$/, "/api/agents/outbound");
    const res = await fetch(url, { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json", authorization: `Bearer ${me.key}` }, body: JSON.stringify({ texts }) });
    if (res.status === 404) return { ok: true, skipped: true }; // a board without the gate (older server)
    // 5xx: the board is there but couldn't answer the question; counts as unreachable (a 4xx is an answer: not approved, or not this key).
    if (!res.ok) return { ok: false, unreachable: res.status >= 500, why: `the board answered ${res.status}` };
    return await res.json();
  } catch {
    return { ok: false, unreachable: true, why: "the board couldn't be reached to confirm it is approved" };
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
  const live = !headless();
  const server = serverOfTool(tool);
  // Live session, the person's own server (the folder's allowlist): theirs to use; the board isn't asked.
  if (live && server && me.sendAllowed.some((s) => s.toLowerCase() === server.toLowerCase())) process.exit(0);
  const r = await outboundCheck();
  if (r.ok) {
    // Approved on the board: leave the ids for post-tool.mjs to report as sent (an older server without `matches`
    // answers the part's label, which report_sent also takes when it is unique in the latest round).
    if (!r.skipped && r.card?.id) {
      const parts = Array.isArray(r.matches) && r.matches.length ? r.matches.map((m) => m.part).filter((p) => typeof p === "string") : [r.part].filter((p) => typeof p === "string" && p);
      if (parts.length) {
        pruneSentMarkers();
        writeSentMarker(sentMarkerPath(me.key, tool, texts), { tool, card: r.card.id, parts, where: server ?? tool, at: Date.now() });
      }
    }
    process.exit(0);
  }
  // Live session, board unreachable: it goes out on the person's say-so, and they are told so. Headless fails closed.
  if (live && r.unreachable) {
    process.stdout.write(JSON.stringify({ systemMessage: `AgentOrb couldn't check the board; ${tool} went out on your say-so.` }));
    process.exit(0);
  }
  const why = String(r.why ?? "it isn't approved").replace(/([^.!?])$/, "$1.");
  const allowCmd = server ? `node "${join(dirname(fileURLToPath(import.meta.url)), "allow-send.mjs")}" ${server}` : null;
  // Live: say how the person makes this server theirs (the runner stays gated by the board either way).
  const hint = live && allowCmd ? ` This is a live session: if ${server} is your own, allow it for live sessions here with \`${allowCmd}\` (the background runner still only sends text approved on the board).` : "";
  deny(`AgentOrb outbound gate stopped ${tool}: ${why} Use get_approved on the card and send its text exactly, to the approved recipients; anything new goes to the person first with submit_draft.${hint}`);
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

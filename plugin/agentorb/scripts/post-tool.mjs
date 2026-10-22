#!/usr/bin/env node
/*
 * AgentOrb sent ledger (a PostToolUse hook, 0099). When a send tool (OUTBOUND_RE) has just run and the PreToolUse
 * gate (pre-tool.mjs) let it through because the board matched its text to an approved draft, this reports the send
 * on the board ({ sent: true, card, parts, where, ref } to /api/agents/outbound, the same as report_sent) so the card
 * can go done without the agent having to say so itself. The gate leaves what it matched in a marker file
 * (sent-marker.mjs); no marker means the send wasn't the board's to record (an allowlisted own-server send, a board
 * that couldn't be reached, the gate off) and the agent reports it with report_sent.
 *
 * `where` is the tool's server (mcp__<server>__<tool>); `ref` is a message id or link when the tool's answer carries
 * one plainly, else left out. The answer is the sending server's (0103): a hostile one could plant any link on the
 * card, so only an id (message_id, id, ts) or an https link on the server's own domain (gmail → mail.google.com,
 * slack → slack.com, discord → discord.com, x/twitter → x.com, twitter.com, linkedin → linkedin.com) is kept; a
 * server that isn't on that list gets ids only. Never blocks the tool: it has already run. A report that fails prints
 * one line to the person and exits 0; the agent is told to call report_sent itself.
 */
import { readFileSync } from "node:fs";
import { linkedNearby, OUTBOUND_RE, outboundRe, serverOfTool, serverUrl, session } from "./config.mjs";
import { sentMarkerPath, stringsIn, takeSentMarker } from "./sent-marker.mjs";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  /* no stdin */
}
const tool = String(input.tool_name ?? "");
// Only a send tool, only in a folder on a board: out before anything is spawned (the hook runs on every tool call).
// The widest the pattern can be first (the gate's own, or the environment's), the session's own below.
if (/^mcp__(plugin_agentorb_|claude_ai_)?agentorb__/i.test(tool) || !(OUTBOUND_RE.test(tool) || outboundRe(null).re.test(tool))) process.exit(0);
if (!linkedNearby()) process.exit(0);

const me = session();
if (!me.link || !me.key || !outboundRe(me).re.test(tool)) process.exit(0);

// No marker (the gate was off, the server allowlisted, the board unreachable): nothing of the board's to record.
const marker = takeSentMarker(sentMarkerPath(me.key, tool, stringsIn(input.tool_input ?? {})));
if (!marker || marker.tool !== tool) process.exit(0);

/* ---- a reference from the tool's answer, when it is plain and the server's own: an id, or a link on its domain */

const REF_HOSTS = [
  ["gmail", ["mail.google.com"]],
  ["slack", ["slack.com"]],
  ["discord", ["discord.com"]],
  ["twitter", ["x.com", "twitter.com"]],
  ["linkedin", ["linkedin.com"]],
];
/** The domains a server's links may be on: by its name (mcp__<server>__...; "x" only as a whole word). None: ids only. */
function hostsFor(server) {
  const s = String(server ?? "").toLowerCase();
  const out = [];
  for (const [name, hosts] of REF_HOSTS) if (s.includes(name)) out.push(...hosts);
  if (s.split(/[^a-z0-9]+/).includes("x")) out.push("x.com", "twitter.com");
  return out;
}
const HOSTS = hostsFor(serverOfTool(tool));
const urlOk = (u) => {
  try {
    const x = new URL(String(u).trim());
    if (x.protocol !== "https:" || x.username || x.password) return false;
    const h = x.hostname.toLowerCase();
    return HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
};
const URL_KEYS = ["permalink", "permalink_url", "url", "link", "html_url"];
const ID_KEYS = ["message_id", "messageId", "id", "ts"];
const URL_RE = /https:\/\/[^\s"'<>)\]]+/g;
/** An id: one token, no link in it, 200 chars at most. */
const idOf = (x) => {
  if (typeof x === "number" && Number.isFinite(x)) return String(x);
  if (typeof x !== "string") return null;
  const s = x.trim();
  return s && s.length <= 200 && !/\s|:\/\//.test(s) ? s : null;
};
const cleanUrl = (u) => String(u).trim().slice(0, 500);

/** { url, id }: the first link on the server's own domain and the first id, anywhere in the answer. */
function refsIn(v, found = { url: null, id: null }, depth = 0) {
  if (depth > 6 || v == null || (found.url && found.id)) return found;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return found;
    // An MCP tool answers text: often JSON, else prose that may carry a link.
    if (/^[[{]/.test(s)) {
      try {
        return refsIn(JSON.parse(s), found, depth + 1);
      } catch {
        /* not JSON */
      }
    }
    if (!found.url && HOSTS.length) for (const m of s.match(URL_RE) ?? []) if (urlOk(m) && m.length <= 500) { found.url = cleanUrl(m); break; }
    return found;
  }
  if (Array.isArray(v)) {
    for (const x of v) refsIn(x, found, depth + 1);
    return found;
  }
  if (typeof v === "object") {
    for (const k of URL_KEYS) if (!found.url && typeof v[k] === "string" && v[k].length <= 500 && urlOk(v[k])) found.url = cleanUrl(v[k]);
    for (const k of ID_KEYS) if (!found.id && idOf(v[k])) found.id = idOf(v[k]);
    for (const x of Object.values(v)) refsIn(x, found, depth + 1);
  }
  return found;
}

let ref = null;
try {
  const found = refsIn(input.tool_response);
  ref = found.url ?? found.id ?? null;
} catch {
  /* best effort */
}

const where = typeof marker.where === "string" && marker.where ? marker.where : (serverOfTool(tool) ?? tool);
const body = { sent: true, card: marker.card, parts: marker.parts, where, ...(ref ? { ref } : {}) };

async function report() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const url = serverUrl(me.link).replace(/\/api\/mcp(?:\/plugin)?$/, "/api/agents/outbound");
    const res = await fetch(url, { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json", authorization: `Bearer ${me.key}` }, body: JSON.stringify(body) });
    if (!res.ok) return { ok: false, why: `the board answered ${res.status}` };
    const j = await res.json().catch(() => null);
    return j && typeof j === "object" ? j : { ok: false, why: "the board's answer was unreadable" };
  } catch {
    return { ok: false, why: "the board couldn't be reached" };
  } finally {
    clearTimeout(t);
  }
}

const r = await report();
if (r.ok) {
  const n = Array.isArray(r.sent) ? r.sent.length : marker.parts.length;
  const left = Array.isArray(r.left) ? r.left.length : 0;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `AgentOrb recorded this send on the board (${n} approved ${n === 1 ? "part" : "parts"} via ${where}${ref ? `, ref ${ref}` : ""}); no report_sent needed for ${n === 1 ? "it" : "them"}.${left ? ` ${left} approved ${left === 1 ? "part is" : "parts are"} still unreported.` : ""}`,
      },
    }),
  );
} else {
  process.stdout.write(JSON.stringify({ systemMessage: "AgentOrb couldn't record the send; call report_sent yourself", hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `AgentOrb couldn't record this send on the board (${String(r.why ?? "unknown").replace(/\.$/, "")}): call report_sent with card ${marker.card}, parts ${JSON.stringify(marker.parts)}, where "${where}"${ref ? `, ref "${ref}"` : ""} before done.` } }));
}
process.exit(0);

#!/usr/bin/env node
/*
 * The MCP connection's headers (Claude Code's headersHelper). With this repo's own agent key (.agentorb.local.json,
 * found from the session's directory), it trades the key for a 15-minute token at /api/agents/token and sends the
 * token: a header that leaks is good for minutes, not months. The token is cached on this machine (0600) and
 * renewed when it has under three minutes left; Claude Code re-runs this helper when a call is refused (401), so an
 * expired token is replaced on the spot. If the board can't mint one (an older server, no network), it sends the
 * key as before. Without a repo key it prints no headers, and the static "Bearer ${AGENTORB_KEY}" in .mcp.json
 * applies. Never logs the key or the token. It also names this folder's board (x-agentorb-project, 0075).
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serverUrl, session } from "./config.mjs";

const me = session();
// 0075: this folder's board (the nearest .agentorb.json): the server defaults tools, my_work and whats_new to it.
const board = typeof me.link?.project === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(me.link.project) ? { "x-agentorb-project": me.link.project } : {};
// The plugin's version, so a suggestion an agent sends (suggest_to_agentorb) says which plugin it ran on.
const plugin = (() => {
  try {
    const v = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".claude-plugin", "plugin.json"), "utf8")).version;
    return typeof v === "string" && /^[0-9][0-9A-Za-z.-]{0,30}$/.test(v) ? { "x-agentorb-plugin": v } : {};
  } catch {
    return {};
  }
})();
const out = (h) => process.stdout.write(JSON.stringify({ ...h, ...board, ...plugin }));
if (me.keySource !== "repo") {
  out({});
  process.exit(0);
}

const dir = join(homedir(), ".claude", "agentorb", "tokens");
const file = join(dir, `${createHash("sha256").update(me.key).digest("hex").slice(0, 16)}.json`);
const MARGIN_MS = 3 * 60_000;

function cached() {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return typeof j.token === "string" && j.token.startsWith("sst_") && Date.parse(j.expiresAt) - Date.now() > MARGIN_MS ? j.token : null;
  } catch {
    return null;
  }
}

async function mint() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const url = serverUrl(me.link).replace(/\/api\/mcp(?:\/plugin)?$/, "/api/agents/token");
    const res = await fetch(url, { method: "POST", signal: ctl.signal, headers: { authorization: `Bearer ${me.key}` } });
    if (!res.ok) return null;
    const j = await res.json();
    if (typeof j.token !== "string" || !j.token.startsWith("sst_")) return null;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify({ token: j.token, expiresAt: j.expiresAt }), { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch {
      /* best effort: the token still works for this connection */
    }
    return j.token;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const token = cached() ?? (await mint());
out({ Authorization: `Bearer ${token ?? me.key}` });

#!/usr/bin/env node
/*
 * Your own send tools in live sessions (0096). The outbound gate (pre-tool.mjs) lets a send/post tool through in a
 * live session when its MCP server is on this folder's allowlist: `sendAllowed` in the git-ignored .agentorb.local.json
 * (the <server> part of mcp__<server>__<tool>). The background runner (headless) never reads the list: it only ever
 * sends text approved on the board.
 *
 *   node allow-send.mjs                 list the servers allowed here, and whether the gate is off
 *   node allow-send.mjs slack           allow mcp__slack__* send tools in live sessions
 *   node allow-send.mjs --remove slack  take it out again
 *   node allow-send.mjs --gate-off      switch the gate off for every send tool in live sessions here (0103)
 *   node allow-send.mjs --gate-on       switch it back on
 *
 * A full tool name (mcp__slack__post_message) or a mcp__slack prefix is taken as its server. Only edits the list (and
 * the "gate" key); the rest of the file (the key) is left as it is and never printed. This file is the only thing that
 * relaxes the gate in a folder with its own key: AGENTORB_OUTBOUND_GATE=off from the environment (which a cloned repo's
 * committed settings can set) is ignored there. Session start prints one line whenever either is set.
 */
import { basename } from "node:path";
import { sendAllowedIn, serverOfTool, session, writeGate, writeSendAllowed } from "./config.mjs";

const args = process.argv.slice(2);
const remove = args.includes("--remove");
const gateFlag = args.includes("--gate-off") ? "off" : args.includes("--gate-on") ? "on" : null;
const names = args.filter((a) => !["--remove", "--gate-off", "--gate-on"].includes(a));
const say = (s) => process.stdout.write(`${s}\n`);

const me = session();
if (!me.localDir) {
  say("AgentOrb: this folder has no .agentorb.local.json (no agent of its own), so there is no allowlist to edit. Run /agentorb:init here first.");
  process.exit(1);
}
const dir = me.localDir;
const here = basename(dir);
const current = sendAllowedIn(dir);

if (gateFlag) {
  if (names.length || remove) {
    say("--gate-off / --gate-on go alone: node allow-send.mjs --gate-off");
    process.exit(1);
  }
  const written = writeGate(dir, gateFlag === "off");
  if (written === null) {
    say(`AgentOrb: couldn't update ${here}/.agentorb.local.json (not readable as JSON). Nothing changed.`);
    process.exit(1);
  }
  if (written) say(`Outbound gate off for live sessions in ${here}: every send/post tool runs on your say-so, nothing is checked against the board, and nothing is recorded on a card's sent ledger by the hooks (report_sent is the agent's job). The background runner is still gated by the board. Session start says so each time; node allow-send.mjs --gate-on turns it back on.`);
  else say(`Outbound gate on for live sessions in ${here}: send/post tools wait for text approved on the board${current.length ? `, except your own ${current.join(", ")}` : ""}.`);
  process.exit(0);
}

if (!names.length) {
  if (remove) {
    say("Say which server to remove: node allow-send.mjs --remove <server>");
    process.exit(1);
  }
  if (me.gateOff) say(`Outbound gate: off for every send tool in live sessions in ${here} (.agentorb.local.json "gate": "off"; node allow-send.mjs --gate-on turns it back on). The background runner still only sends text approved on the board.`);
  if (current.length) say(`Send tools you may use yourself in live sessions in ${here}: ${current.join(", ")} (mcp__<server>__*). The background runner still only sends text approved on the board.`);
  else if (!me.gateOff) say(`No send tools are allowed for live sessions in ${here} yet: every send/post tool waits for text approved on the board. Allow one of your own with: node allow-send.mjs <server> (the <server> of mcp__<server>__<tool>).`);
  process.exit(0);
}

const servers = [];
for (const raw of names) {
  const s = (serverOfTool(raw) ?? raw.replace(/^mcp__/, "").replace(/__.*$/, "")).trim();
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(s)) {
    say(`"${raw}" isn't a server name (letters, digits, _ . - only; the <server> of mcp__<server>__<tool>).`);
    process.exit(1);
  }
  if (!servers.includes(s)) servers.push(s);
}

const has = (s) => current.some((c) => c.toLowerCase() === s.toLowerCase());
const next = remove ? current.filter((c) => !servers.some((s) => s.toLowerCase() === c.toLowerCase())) : [...current, ...servers.filter((s) => !has(s))];
const written = writeSendAllowed(dir, next);
if (written === null) {
  say(`AgentOrb: couldn't update ${here}/.agentorb.local.json (not readable as JSON). Nothing changed.`);
  process.exit(1);
}
if (remove) {
  const gone = servers.filter(has);
  const missing = servers.filter((s) => !has(s));
  if (gone.length) say(`Removed ${gone.join(", ")} from ${here}'s live-session send allowlist: their send tools wait for approved text again.`);
  if (missing.length) say(`${missing.join(", ")} ${missing.length === 1 ? "wasn't" : "weren't"} on the list.`);
} else {
  const added = servers.filter((s) => !has(s));
  const already = servers.filter(has);
  if (added.length) say(`Allowed ${added.join(", ")} for live sessions in ${here}: mcp__${added.length === 1 ? added[0] : "<server>"}__* send tools are yours to use when you ask here. The background runner still only sends text approved on the board.`);
  if (already.length) say(`${already.join(", ")} ${already.length === 1 ? "was" : "were"} already allowed.`);
}
say(`Allowed now: ${written.length ? written.join(", ") : "none"} (.agentorb.local.json "sendAllowed"; takes effect on the next tool call).`);

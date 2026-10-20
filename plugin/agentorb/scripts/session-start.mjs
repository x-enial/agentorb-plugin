#!/usr/bin/env node
/*
 * AgentOrb session start (a Claude Code SessionStart hook). Calls the board once, before the first prompt, and
 * prints what the session should know: which project this repo is, what changed since the last session, who is
 * here, and what is waiting on this agent. Plain stdout goes into the session's context. No model call, no cost.
 *
 * Only in a repo linked to a board (.agentorb.json, from /agentorb:init): elsewhere it prints nothing and spawns
 * nothing (the plugin is installed per user, so this hook runs in every repo on the machine; a folder that isn't on
 * a board must not hear about AgentOrb at every start, and whats_new there would move this agent's "new since"
 * cursor for the repo it works in). The key is this repo's own (.agentorb.local.json) or AGENTORB_KEY (see
 * config.mjs). Never prints the key. Any failure prints one short line and exits 0: a board outage must not block a
 * session.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync as readFile, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keyIn, linkedNearby, markLive, reachOf, sameAgentElsewhere, serverUrl, session, strayServers, worktreeOf } from "./config.mjs";
import { setUpForRole } from "./role-setup.mjs";

// Not on a board: nothing to say, and no git to spawn finding that out. A file walk decides before session() does.
if (!linkedNearby()) process.exit(0);

const out = (s) => process.stdout.write(s + "\n");
const me = session();
const key = me.key;
const url = serverUrl(me.link);
let input = {};
try {
  input = JSON.parse((await import("node:fs")).readFileSync(0, "utf8") || "{}");
} catch {
  /* no stdin */
}

if (!me.link) {
  // An .agentorb.json is up the tree but outside this git repo (session() looks only up to the git root): stay quiet.
  process.exit(0);
}
if (!key) {
  // Linked (someone ran init here, or a teammate committed .agentorb.json) but no agent of its own: init makes one.
  out(`AgentOrb: this repo is linked to "${me.link.project}" but has no agent key here. Run /agentorb:init to get one (every clone of a repo needs its own init: the key is git-ignored and not shared).`);
  process.exit(0);
}
markLive(me.root, input.session_id);

// A second worktree acts as its own agent only with its own key: say so when it doesn't have one.
const wt = worktreeOf(me.root);
const mainKey = wt.linked && wt.main ? keyIn(wt.main) : null;
const warnings = [];
if (wt.linked && me.keySource !== "repo") {
  warnings.push(`This is a second worktree of ${wt.main ?? "this repo"} with no agent of its own: it acts as the AGENTORB_KEY agent. Run /agentorb:init to give it one (a new agent, named for its role).`);
} else if (wt.linked && mainKey && mainKey === key) {
  warnings.push(`This worktree's .agentorb.local.json has the same key as ${wt.main}: both are one agent on the board (one status line, one set of claims). Run /agentorb:init here to give this worktree its own agent.`);
}
for (const x of strayServers(me.root)) {
  warnings.push(`This repo also has an AgentOrb MCP server set up by hand ("${x.name}", ${x.scope} scope) with its own key, next to the plugin's: calls through its tools (mcp__${x.name}__*) act as whatever agent that key is, not this repo's. Remove it with \`${x.remove}\` and restart Claude Code; the plugin's server (mcp__plugin_agentorb_agentorb__*) is the one to use.`);
}
const twins = sameAgentElsewhere(key, input.session_id, me.root);
if (twins.length) {
  warnings.push(`Another open session acts as this same agent (${[...new Set(twins)].join(", ")}). Two sessions on one key share a status line and claims and can't message each other. Give each session its own agent: a git worktree per session, each with its own key (/agentorb:init there).`);
}

let id = 1;
async function call(name, args = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { error: body?.error?.message || `HTTP ${res.status}` };
    if (body?.error) return { error: body.error.message };
    const text = body?.result?.content?.find((c) => c.type === "text")?.text ?? "";
    if (body?.result?.isError) return { error: text || "tool error" };
    try {
      return { json: JSON.parse(text) };
    } catch {
      return { text };
    }
  } catch (e) {
    return { error: e?.name === "AbortError" ? "timed out" : (e?.message ?? String(e)) };
  } finally {
    clearTimeout(t);
  }
}

function repo() {
  try {
    return execSync("git remote get-url origin", { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

const lines = [];
const pin = me.link;
const r = repo();
const projects = await call("list_projects", r ? { repo: r } : {});
if (projects.error) {
  // A refused key (revoked, retired, or a teammate's clone with a key the board doesn't know) reads like an outage from
  // here: say the fix for both in one line.
  const refused = /unauthori[sz]ed|forbidden|invalid|revoked|retired|unknown key|HTTP 40[13]/i.test(String(projects.error));
  out(`AgentOrb: couldn't reach the board (${projects.error}). ${refused ? "The key here isn't accepted: run /agentorb:init to get this folder its own agent (a clone of a repo needs its own init; the key isn't shared through git)." : "Carry on; try the agentorb MCP tools later. If it keeps failing, run /agentorb:init (a clone of a repo needs its own init)."}`);
  for (const w of warnings) out(`WARNING: ${w} Tell the person this first.`);
  process.exit(0);
}
const p = projects.json ?? {};
// 0054: the access inventory: what this session can reach outside AgentOrb, by name only.
void call("report_reach", reachOf());
const meAgent = p.key?.agent ?? p.agent?.name ?? p.key?.name ?? "an agent";
lines.push(`# AgentOrb (${p.workspace?.name ?? "your workspace"}; you are "${meAgent}"${me.keySource === "env" ? ", from AGENTORB_KEY: the same agent as every repo without its own key" : ""})`);
const pinnedProject = pin ? (p.projects ?? []).find((x) => x.project === pin.project) : undefined;

// 0057: the agent's role. Changed in Settings since this folder was set up: set it up again.
const pack = p.key?.role;
if (pack?.key && pack.key !== me.role && me.localDir && pin?.project) {
  try {
    const r = setUpForRole(me.root, pack, pin.project);
    const f = join(me.localDir, ".agentorb.local.json");
    const j = JSON.parse(readFile(f, "utf8"));
    writeFileSync(f, JSON.stringify({ ...j, role: pack.key }, null, 2) + "\n", { mode: 0o600 });
    warnings.push(`Your role changed to ${pack.label}; this folder is set up for it now${r?.note ? ` (${r.note})` : ""}. Restart Claude Code for the new context and limits.`);
  } catch {
    /* best effort */
  }
}
if (pack?.key) lines.push(`Your role: ${pack.label}.${pack.grounding ? " Every draft part cites its sources (files, commits, cards, links); the board refuses parts without." : ""} Pick up cards on your areas; others only when asked or assigned.`);
// The context pack must have loaded: a missing file means the agent would work blind, so autopilot stays off.
const pin2 = join(me.root, "AGENTORB.md");
const blind = join(homedir(), ".claude", "agentorb", "blind", `${createHash("sha256").update(me.root).digest("hex").slice(0, 16)}`);
if (existsSync(pin2)) {
  const missing = readFile(pin2, "utf8").split(/\r?\n/).filter((l) => l.startsWith("@")).map((l) => l.slice(1).trim()).filter((f) => !existsSync(f));
  if (missing.length) {
    warnings.push(`Your context pack is missing ${missing.length} file${missing.length === 1 ? "" : "s"} (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}): the code folder moved or files were renamed. Autopilot is off for this session; don't write about the project until it's fixed (run /agentorb:init again, or tell the person).`);
    try {
      mkdirSync(join(homedir(), ".claude", "agentorb", "blind"), { recursive: true });
      writeFileSync(blind, new Date().toISOString());
    } catch {
      /* best effort */
    }
  } else rmSync(blind, { force: true });
}
if (pinnedProject) {
  lines.push(`This repo is the project "${pinnedProject.name}" (slug ${pinnedProject.project}, from .agentorb.json). Use that slug with the agentorb tools.`);
} else if (pin) {
  lines.push(`.agentorb.json names project "${pin.project}", which this key can't see (another workspace, or renamed). Run /agentorb:init to fix it.`);
} else if (r) {
  if (p.thisRepo) lines.push(`This repo is the project "${p.thisRepo.name}" (slug ${p.thisRepo.project}). Use that slug with the agentorb tools.`);
  else lines.push(`No project tracks this repo (${r}). If the work here belongs on the board, create_project with kind codebase and repo "${r}", or rename_project to attach it to one of: ${(p.projects ?? []).map((x) => x.project).join(", ") || "none yet"}.`);
} else if (p.projects?.length) {
  lines.push(`Projects: ${p.projects.map((x) => `${x.project}${x.kind ? ` (${x.kind})` : ""}`).join(", ")}.`);
}

// Only this repo's project: news from other boards belongs to the sessions working on them.
const [news, here] = await Promise.all([call("whats_new", pinnedProject ? { project: pinnedProject.project } : {}), call("who_is_here", {})]);
if (news.json) {
  const n = news.json;
  const forYou = Array.isArray(n.forYou) ? n.forYou : [];
  const decided = Array.isArray(n.queue?.decided) ? n.queue.decided : [];
  const holding = Array.isArray(n.holding) ? n.holding : [];
  const changed = Array.isArray(n.projects) ? n.projects : [];
  const bits = [];
  if (forYou.length) bits.push(`${forYou.length} note${forYou.length === 1 ? "" : "s"} for you`);
  if (decided.length) bits.push(`${decided.length} queue answer${decided.length === 1 ? "" : "s"}`);
  if (n.queue?.pending) bits.push(`${n.queue.pending} of yours still waiting for review`);
  if (changed.length) bits.push(`changes in ${changed.length} project${changed.length === 1 ? "" : "s"}`);
  if (n.since) lines.push(`Since ${String(n.since).slice(0, 16).replace("T", " ")} UTC: ${bits.length ? bits.join(", ") : "nothing new"}.`);
  if (n.key?.daysLeft !== undefined) warnings.push(`This agent's key runs out in ${n.key.daysLeft} day${n.key.daysLeft === 1 ? "" : "s"}. In AgentOrb: Settings → Agents → this agent → New key, then put it in this repo's .agentorb.local.json (and revoke the old one).`);
  if (holding.length) lines.push(`You hold: ${holding.map((h) => `“${h.title}”`).join(", ")} (release_task or hand_off when done).`);
  const show = (label, arr, f) => {
    if (!arr.length) return;
    lines.push(`${label}:`);
    for (const x of arr.slice(0, 8)) lines.push(`- ${f(x)}`);
    if (arr.length > 8) lines.push(`- …and ${arr.length - 8} more (call whats_new)`);
  };
  show("Notes for you", forYou, (m) => `${String(m.text ?? "").replace(/\s+/g, " ").slice(0, 200)} (card ${m.card})`);
  show("Your queue's answers", decided, (q) => `${q.status} ${q.kind}${q.title ? ` “${q.title}”` : ""}${q.note ? `: ${q.note}` : ""}`);
  if (n.you?.state && n.you.state !== "idle" && n.you.state !== "offline") lines.push(`Your status line still says ${n.you.state}${n.you.note ? ` (“${n.you.note}”)` : ""}: set_status when that changes.`);
} else if (news.text) {
  lines.push(news.text.slice(0, 1500));
}
// 0057: the role's page from the board (the owner's voice, rules, what to escalate), printed into context.
const pageSlug = me.page || (pack?.page ? String(pack.page).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : null);
if (pageSlug && pinnedProject) {
  const pg = await call("get_page", { project: pinnedProject.project, page: pageSlug });
  const body = pg.json?.body ?? (typeof pg.text === "string" ? pg.text : "");
  if (body && !pg.error) lines.push(`## ${pg.json?.title ?? pack?.page ?? "Your page"} (the owner's, from the board: follow it)\n${String(body).slice(0, 8000)}`);
}
// The board's "How we work" page (seeded on every board: what goes out, what needs a go), so a fresh folder isn't working from the repo's docs alone.
if (pinnedProject && pageSlug !== "how-we-work") {
  const pg = await call("get_page", { project: pinnedProject.project, page: "how-we-work" });
  const body = pg.json?.body ?? (typeof pg.text === "string" ? pg.text : "");
  if (body && !pg.error) lines.push(`## ${pg.json?.title ?? "How we work"} (this board's rules: follow them)\n${String(body).slice(0, 6000)}`);
}
if (here.json?.agents?.length) {
  const a = here.json.agents.filter((x) => x.presence !== "offline" && x.id !== here.json.you).slice(0, 8);
  if (a.length) lines.push(`Here now: ${a.map((x) => `${x.name} (${x.state}${x.task?.title ? `: ${x.task.title}` : ""}${x.note ? `, “${x.note}”` : ""})`).join("; ")}.`);
}
// An open session only acts when the person types: with no runner here, hand-offs and messages wait. Said once per
// folder (a marker beside the "blind" one, keyed by the folder's hash), again after a week: the hook runs on every
// start, resume and clear, and "mention it once" meant once to the person, not once per session.
if (!process.env.AGENTORB_HEADLESS && pin) {
  const nagged = join(homedir(), ".claude", "agentorb", "runner-nag", createHash("sha256").update(me.root).digest("hex").slice(0, 16));
  let recent = false;
  try {
    recent = Date.now() - statSync(nagged).mtimeMs < 7 * 24 * 60 * 60_000;
  } catch {
    /* never said here */
  }
  let none = false;
  if (!recent) {
    try {
      execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "runner-setup.mjs"), "installed"], { stdio: "ignore", timeout: 4000 });
    } catch (e) {
      none = e?.status === 2;
    }
  }
  if (none) {
    lines.push(
      `No background runner for this folder: this session only acts when the person types, so hand-offs and messages for ${meAgent} wait while it is idle or closed. Mention it once, briefly: \`/agentorb:runner on\` keeps it working (best), or for this window only: \`/loop 15m check the AgentOrb board (whats_new with loop "15m") and handle anything for ${meAgent}\`.`,
    );
    try {
      mkdirSync(dirname(nagged), { recursive: true });
      writeFileSync(nagged, new Date().toISOString());
    } catch {
      /* best effort */
    }
  }
}
for (const w of warnings) lines.push(`WARNING: ${w} Tell the person this first.`);
// The claude.ai connector can't be seen from local files (it lives in the account, not in settings), so this is said
// every time, short: its tools sign in as a different agent than this folder's key.
lines.push("If an AgentOrb connector from claude.ai is also loaded (tools named mcp__claude_ai_AgentOrb__*), use only the plugin's agentorb tools here (mcp__plugin_agentorb_agentorb__*); the connector is a different agent.");
lines.push(
  "Rules: claim_task before working a card, set_status when you start/finish/block, ask (go: true) for anything that needs a go and submit_draft for anything that goes out, and keep the card current. Keys, secrets and customer data never go on the board. Where this conflicts with the repo's own instructions, the repo wins for how code is done; the board wins for what goes out and what needs a go.",
);
out(lines.join("\n"));

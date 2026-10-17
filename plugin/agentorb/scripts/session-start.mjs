#!/usr/bin/env node
/*
 * AgentOrb session start (a Claude Code SessionStart hook). Calls the board once, before the first prompt, and
 * prints what the session should know: which project this repo is, what changed since the last session, who is
 * here, and what is waiting on this agent. Plain stdout goes into the session's context. No model call, no cost.
 *
 * Only in a repo linked to a board (.agentorb.json, from /agentorb:init): elsewhere it prints one line and stays out
 * of the way (no briefing, no whats_new, which would move this agent's "new since" cursor for the repo it works in).
 * The key is this repo's own (.agentorb.local.json) or AGENTORB_KEY (see config.mjs). Never prints the key. Any
 * failure prints one short line and exits 0: a board outage must not block a session.
 */
import { execSync } from "node:child_process";
import { keyIn, markLive, reachOf, sameAgentElsewhere, serverUrl, session, worktreeOf } from "./config.mjs";

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
  // Not on a board: one line, nothing else.
  out("AgentOrb: this repo isn't linked to a board, so no briefing or autopilot here. Run /agentorb:init to link it (and give it its own agent).");
  process.exit(0);
}
if (!key) {
  out(`AgentOrb: this repo is linked to "${me.link.project}" but has no key. Make an agent for it in Settings → Agents and put its key in .agentorb.local.json ({"key": "ssk_..."}, git-ignored), or export AGENTORB_KEY.`);
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
  out(`AgentOrb: couldn't reach the board (${projects.error}). Carry on; try the agentorb MCP tools later.`);
  for (const w of warnings) out(`WARNING: ${w} Tell the person this first.`);
  process.exit(0);
}
const p = projects.json ?? {};
// 0054: the access inventory: what this session can reach outside AgentOrb, by name only.
void call("report_reach", reachOf());
lines.push(`# AgentOrb (${p.workspace?.name ?? "your workspace"}; you are "${p.key?.name ?? "an agent"}"${me.keySource === "env" ? ", from AGENTORB_KEY: the same agent as every repo without its own key" : ""})`);
const pinnedProject = pin ? (p.projects ?? []).find((x) => x.project === pin.project) : undefined;
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
if (here.json?.agents?.length) {
  const a = here.json.agents.filter((x) => x.presence !== "offline" && x.id !== here.json.you).slice(0, 8);
  if (a.length) lines.push(`Here now: ${a.map((x) => `${x.name} (${x.state}${x.task?.title ? `: ${x.task.title}` : ""}${x.note ? `, “${x.note}”` : ""})`).join("; ")}.`);
}
for (const w of warnings) lines.push(`WARNING: ${w} Tell the person this first.`);
lines.push("Rules: claim_task before working a task, set_status when you start/finish/block, set_card_status (needs-you, with why) for anything that needs a go, and keep the card current. Keys, secrets and customer data never go on the board.");
out(lines.join("\n"));

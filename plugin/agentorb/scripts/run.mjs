#!/usr/bin/env node
/*
 * AgentOrb runner: starts one headless Claude Code session and reports it to the board as it goes (report_run):
 * the start, each tool step as a short hint (a file name, a query; never content or keys), the Claude plan's windows
 * from the stream, and the end. Before starting it asks the board (my_work): a held agent, or a plan window past 85%
 * for self-started work, means no run at all (an empty run still costs). Prints what `claude -p` would have printed.
 *
 *   node run.mjs --job work|think --prompt "/agentorb:work 1" -- <claude args…>
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { liveHere, serverUrl, session } from "./config.mjs";

// This repo's own agent (.agentorb.local.json) or AGENTORB_KEY; this repo's board only (.agentorb.json).
const me = session();
const key = me.key;
const url = serverUrl(me.link);
const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const own = dash >= 0 ? argv.slice(0, dash) : argv;
const rest = dash >= 0 ? argv.slice(dash + 1) : [];
const opt = (name, d) => {
  const i = own.indexOf(`--${name}`);
  return i >= 0 ? own[i + 1] : d;
};
let job = opt("job", "work");
let prompt = opt("prompt", "/agentorb:work 1");
const force = own.includes("--force");
const log = (s) => process.stderr.write(`${new Date().toISOString()} ${s}\n`);

if (!key) {
  log("no key: put this repo's agent key in .agentorb.local.json or export AGENTORB_KEY");
  process.exit(1);
}
// You're working here yourself: the board's work waits for you (no second session as the same agent).
if (!force && liveHere(me.root)) {
  log("you have a Claude Code session open in this repo; holding off");
  process.exit(0);
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
    if (!res.ok || body?.error || body?.result?.isError) return null;
    const text = body?.result?.content?.find((c) => c.type === "text")?.text ?? "";
    return JSON.parse(text);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Gate: held, or the plan past 85% (self-started work), means no run.
const w = await call("my_work", me.link ? { project: me.link.project } : {});
if (w?.onHold && !force) {
  log(`${job}: on hold; no run`);
  process.exit(0);
}
if (w && w.autopilotPaused && /plan usage/.test(w.autopilotPaused) && !force) {
  log(`${job}: ${w.autopilotPaused}; no run`);
  process.exit(0);
}
// Routines (0042): a due routine of this agent runs before ordinary work, one per run, as its own job.
let routine = null;
if (job === "work" || job === "routine") {
  const r = await call("my_routines");
  routine = r?.due?.[0] ?? null;
  if (routine) {
    job = "routine";
    prompt = `/agentorb:routine ${routine.id}`;
    log(`routine due: ${routine.name}`);
  } else if (job === "routine") {
    log("routine: nothing due; no run");
    process.exit(0);
  }
}
// Messages to this agent and answers to its requests are work too (0047, 0051): the run takes them first.
if (job === "work" && w && !w.suggestion && !w.messages?.length && !w.answers?.length) {
  log("work: nothing to pick up; no run");
  process.exit(0);
}

// A tool call as the board shows it: the tool and a short hint. Never a file's content, a body, or a key.
function stepOf(use) {
  const n = String(use?.name || "");
  const i = use?.input || {};
  const tool = n.replace(/^mcp__[^_]+(?:-[^_]+)*__/, "").slice(0, 80);
  const base = (f) => String(f || "").split(/[\\/]/).filter(Boolean).pop() || "";
  let hint = null;
  if (n === "WebSearch") hint = i.query;
  else if (n === "WebFetch") { try { hint = new URL(i.url).host; } catch { hint = null; } }
  else if (n === "Read" || n === "Write" || n === "Edit") hint = base(i.file_path);
  else if (n === "Grep" || n === "Glob") hint = i.pattern;
  else if (n === "Bash") hint = String(i.command || "").split(/\s+/).slice(0, 3).join(" ");
  else if (/__(claim_task|release_task|set_card_status|update_task|get_card|submit_draft|get_approved)$/.test(n)) hint = i.task || i.card || null;
  else if (/__set_status$/.test(n)) hint = i.state;
  else if (/__(add_card|propose_idea)$/.test(n)) hint = i.title;
  else if (/__(ask|assign_task|hand_off)$/.test(n)) hint = i.to;
  return { tool, hint: hint ? String(hint).replace(/\s+/g, " ").slice(0, 120) : undefined };
}

const NAMES = { five_hour: "5 hours", seven_day: "7 days", seven_day_opus: "7 days (Opus)", seven_day_sonnet: "7 days (Sonnet)" };
const seen = { steps: [], windows: null, status: null, result: "", error: false };
function read(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (o.type === "assistant" && Array.isArray(o.message?.content)) for (const c of o.message.content) if (c?.type === "tool_use") seen.steps.push(stepOf(c));
  if (o.type === "rate_limit_event" && o.rate_limit_info) {
    const uw = o.rate_limit_info.unifiedWindows || {};
    const windows = Object.entries(uw)
      .filter(([, v]) => v && Number.isFinite(v.utilization))
      .map(([k, v]) => ({ name: NAMES[k] || k.replace(/_/g, " "), used: Math.max(0, Math.min(1, v.utilization)), resetsAt: Number.isFinite(v.resetsAt) ? v.resetsAt * 1000 : null }));
    if (windows.length) seen.windows = windows;
    seen.status = o.rate_limit_info.status || seen.status;
  } else if (o.type === "result") {
    seen.result = typeof o.result === "string" ? o.result : "";
    seen.error = !!o.is_error;
  }
}

let chain = Promise.resolve();
const tell = (body) => {
  chain = chain.then(() => call("report_run", { job, ...body })).catch(() => {});
};
const every = Number(process.env.AGENTORB_RUN_EVERY);
if (routine) tell({ started: true });
else tell({ started: true, task: w?.suggestion?.id, ...(Number.isFinite(every) && every >= 60 ? { every: Math.floor(every) } : {}) });
let told = 0;
// AGENTORB_HEADLESS: this run's own hooks don't mark the repo as having you in it.
// The folder's read-only code folders (0057 role setup writes them as additionalDirectories): passed explicitly, since
// project settings that grant access only apply once a folder is trusted. Its deny rules apply regardless.
const addDirs = (() => {
  try {
    const j = JSON.parse(readFileSync(join(process.cwd(), ".claude", "settings.json"), "utf8"));
    return (j.permissions?.additionalDirectories ?? []).filter((d) => typeof d === "string").flatMap((d) => ["--add-dir", d]);
  } catch {
    return [];
  }
})();
const child = spawn("claude", ["-p", prompt, ...rest, ...addDirs, "--output-format", "stream-json", "--verbose"], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, AGENTORB_HEADLESS: "1", AGENTORB_KEY: key } });
// The routine's ring on the card is the routine's own name (routine_done keeps it); the run itself reports under "routine".
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => child.kill(sig));
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    read(buf.slice(0, i));
    buf = buf.slice(i + 1);
  }
  while (told < seen.steps.length) tell({ step: seen.steps[told++] });
});
const code = await new Promise((done) => {
  child.on("close", (c, sig) => done(c ?? (sig ? 143 : 1)));
  child.on("error", () => done(127));
});
if (buf) read(buf);
// Why a run ended (0056), so the runner does the right thing next: ok; limit (the plan's window is spent or the API
// refused for load: wait for the reset, don't retry into it); timeout (the run hit its time box); logic (it ran but
// ended in an error: its own retry won't help, so back off); crash (it died without a result: retry once).
const ok = code === 0 && !seen.error;
const limitHit = /rejected/i.test(seen.status || "") || /usage limit|rate.?limit|\b429\b|overloaded|\b529\b|quota|credit balance/i.test(seen.result || "");
const kind = ok ? "ok" : code === 143 || code === 124 ? "timeout" : limitHit ? "limit" : seen.result && seen.error ? "logic" : "crash";
const resets = (seen.windows || []).filter((w) => w.resetsAt && w.used >= 0.95).map((w) => w.resetsAt);
const retryAt = kind === "limit" ? (resets.length ? Math.min(...resets) : Date.now() + 30 * 60_000) : undefined;
tell({ ended: { ok, kind, ...(retryAt ? { retryAt } : {}), result: (seen.result || "").split("\n").map((l) => l.trim()).filter(Boolean).slice(-1)[0]?.slice(0, 200) }, ...(seen.windows ? { windows: seen.windows, status: seen.status ?? undefined } : {}) });
await Promise.race([chain, new Promise((r) => setTimeout(r, 8000))]);
if (seen.result) process.stdout.write(seen.result + "\n");
// The runner reads the outcome from here (it starts this script through agentorb-run.sh).
try {
  const dir = join(homedir(), ".claude", "agentorb", "runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${createHash("sha256").update(key).digest("hex").slice(0, 16)}.json`), JSON.stringify({ kind, retryAt: retryAt ?? null, at: Date.now() }));
} catch {
  /* best effort */
}
process.exit({ ok: 0, limit: 75, logic: 65, crash: 70, timeout: 124 }[kind]);

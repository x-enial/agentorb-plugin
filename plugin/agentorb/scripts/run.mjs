#!/usr/bin/env node
/*
 * AgentOrb runner: starts one headless Claude Code session and reports it to the board as it goes (report_run):
 * the start, each tool step as a short hint (a file name, a query; never content or keys), the Claude plan's windows
 * from the stream, and the end. Before starting it asks the board (my_work): a held agent, or a plan window past 85%
 * for self-started work, means no run at all (an empty run still costs). Prints what `claude -p` would have printed.
 *
 *   node run.mjs --job work|think --prompt "/agentorb:work 1" -- <claude args…>
 *
 * The engine is Claude Code unless the folder says otherwise (.agentorb.json "engine", or AGENTORB_ENGINE): "codex"
 * runs `codex exec` with the same instructions (the plugin's commands/*.md, which Codex can't run as slash commands),
 * the folder's own key for AgentOrb (the run's MCP connection overrides Codex's own), and Codex's sandbox in place of
 * Claude's tool allowlist (workspace-write by default, AGENTORB_CODEX_SANDBOX to change it). A code folder the role's
 * settings deny Edit/Write on is not added to Codex's writable set; the prompt says it is read-only.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const engine = String(process.env.AGENTORB_ENGINE || me.link?.engine || "claude").toLowerCase() === "codex" ? "codex" : "claude";
const log = (s) => process.stderr.write(`${new Date().toISOString()} ${s}\n`);

if (!key) {
  log("no key: put this repo's agent key in .agentorb.local.json or export AGENTORB_KEY");
  process.exit(1);
}
// You're working here yourself: the board's work waits for you (no second session as the same agent).
if (!force && liveHere(me.root)) {
  log("you were active in this repo in the last 10 minutes; holding off until you stop or close the session");
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

/** 0083: Codex's --json events, read into the same steps and result. */
function readCodex(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const it = o.item || {};
  if (o.type === "item.started") {
    if (it.type === "mcp_tool_call") seen.steps.push(stepOf({ name: `mcp__${it.server || "agentorb"}__${it.tool}`, input: it.arguments || {} }));
    else if (it.type === "command_execution") seen.steps.push(stepOf({ name: "Bash", input: { command: it.command } }));
    else if (it.type === "web_search") seen.steps.push(stepOf({ name: "WebSearch", input: { query: it.query } }));
  } else if (o.type === "item.completed") {
    if (it.type === "file_change") for (const c of (it.changes || []).slice(0, 5)) seen.steps.push(stepOf({ name: "Edit", input: { file_path: c.path } }));
    else if (it.type === "agent_message" && typeof it.text === "string") seen.result = it.text;
  } else if (o.type === "turn.failed" || o.type === "error") {
    seen.error = true;
    seen.result = String(o.error?.message || o.message || "Codex stopped with an error");
  }
}

/** The plugin's instructions for a job (commands/<job>.md without its header), for an engine without slash commands. */
function instructions(p) {
  const m = /^\/agentorb:(work|think|routine)\s*(.*)$/.exec(p.trim());
  if (!m) return p;
  const file = join(dirname(dirname(fileURLToPath(import.meta.url))), "commands", `${m[1]}.md`);
  try {
    const body = readFileSync(file, "utf8").replace(/^---[\s\S]*?---\s*/, "");
    return `${body.replaceAll("$ARGUMENTS", m[2] || (m[1] === "work" ? "1" : ""))}\n\n(Run without a person: never wait for input. The agentorb MCP server is your board.)`;
  } catch {
    return p;
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
// AGENTORB_HEADLESS: this run's own hooks don't mark the repo as having you in it, and the outbound gate (pre-tool.mjs)
// stays whole: send/post tools only with text approved on the board, blocked when the board can't be reached (0096).
// The folder's code folders (0057 role setup writes them as additionalDirectories): passed explicitly, since project
// settings that grant access only apply once a folder is trusted. For Claude Code the deny rules apply regardless
// (Edit/Write on the folder for a read-only role). Codex has no such rules: `--add-dir` under workspace-write makes
// the folder writable, so a folder the settings deny Edit/Write on isn't added there at all; the prompt says it is
// read-only and that cat and git read it fine (the sandbox allows reads anywhere). The flag semantics are taken from
// the code as written, not checked against a live Codex.
const codeDirs = (() => {
  try {
    const j = JSON.parse(readFileSync(join(process.cwd(), ".claude", "settings.json"), "utf8"));
    const p = j.permissions ?? {};
    const norm = (d) => resolve(String(d)).replace(/[\\/]+$/, "");
    // Edit(/path/**), Write(/path/**) or Edit(/path): a rule whose path is the folder or one above it.
    const denied = (p.deny ?? []).filter((r) => typeof r === "string").map((r) => /^(?:Edit|Write)\((.+)\)$/.exec(r)?.[1]).filter(Boolean).map((x) => norm(x.replace(/\/\*\*?$/, "")));
    return (p.additionalDirectories ?? []).filter((d) => typeof d === "string").map((d) => ({ dir: d, readOnly: denied.some((x) => norm(d) === x || norm(d).startsWith(x + "/")) }));
  } catch {
    return [];
  }
})();
const addDirs = codeDirs.flatMap((d) => ["--add-dir", d.dir]);
const codexAddDirs = codeDirs.filter((d) => !d.readOnly).flatMap((d) => ["--add-dir", d.dir]);
const codexReadOnly = codeDirs.filter((d) => d.readOnly).map((d) => d.dir);
const codexPrompt = (p) => (codexReadOnly.length ? `${p}\n\nThe code at ${codexReadOnly.join(", ")} is read-only for you: read it with cat, ls and git (git -C <path> log, git -C <path> show); never edit it or write into it.` : p);
const codexArgs = () => [
  "exec",
  "--json",
  "--skip-git-repo-check",
  "-s",
  process.env.AGENTORB_CODEX_SANDBOX || "workspace-write",
  "-c",
  'approval_policy="never"',
  // The folder's own agent, whatever Codex's own AgentOrb connection signs in as.
  "-c",
  `mcp_servers.agentorb.url=${JSON.stringify(url)}`,
  "-c",
  'mcp_servers.agentorb.bearer_token_env_var="AGENTORB_KEY"',
  ...codexAddDirs,
  codexPrompt(instructions(prompt)),
];
const child =
  engine === "codex"
    ? spawn("codex", codexArgs(), { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, AGENTORB_HEADLESS: "1", AGENTORB_KEY: key } })
    : spawn("claude", ["-p", prompt, ...rest, ...addDirs, "--output-format", "stream-json", "--verbose"], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, AGENTORB_HEADLESS: "1", AGENTORB_KEY: key } });
const parse = engine === "codex" ? readCodex : read;
// The routine's ring on the card is the routine's own name (routine_done keeps it); the run itself reports under "routine".
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => child.kill(sig));
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
  }
  while (told < seen.steps.length) tell({ step: seen.steps[told++] });
});
const code = await new Promise((done) => {
  child.on("close", (c, sig) => done(c ?? (sig ? 143 : 1)));
  child.on("error", () => done(127));
});
if (buf) parse(buf);
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

#!/usr/bin/env node
/*
 * AgentOrb runner: keeps one connection OUT to the board (POST /api/agents/wait, a long poll) and starts the usual
 * scheduled run (agentorb-run.sh: one short headless Claude Code session, its lock, time cap and tool allowlist) the
 * moment the board says there is work. Replaces the polling cron: no inbound ports, nothing exposed, work starts in
 * seconds. Uses your Claude subscription, like the cron did. Hold the agent in Settings → Agents to stop it taking work.
 *
 *   cd /path/to/repo && AGENTORB_KEY=ssk_... node runner.mjs
 *
 * One runner per agent and repo. `runner-setup.mjs install` (/agentorb:runner on) keeps it alive for you: a crontab
 * line on Linux and WSL, a LaunchAgent on macOS, a Task Scheduler task on Windows. By hand, a cron watchdog like
 *   * * * * * cd /path/to/repo && flock -n /tmp/agentorb-runner-<name>.lock node "$(ls -d ~/.claude/plugins/cache/agentorb/agentorb/* | sort -V | tail -1)/scripts/runner.mjs" >> ~/agentorb-runner.log 2>&1
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveHere, serverUrl, session } from "./config.mjs";

const me = session();
const key = me.key;
const base = serverUrl(me.link).replace(/\/api\/mcp(?:\/plugin)?\/?$/, "").replace(/\/$/, "");
const here = dirname(fileURLToPath(import.meta.url));
const log = (s) => process.stdout.write(`${new Date().toISOString()} ${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** ±25% (0056): many runners retrying on the same schedule would hit the board in one burst. */
const jitter = (ms, f = 0.25) => Math.round(ms * (1 - f + Math.random() * 2 * f));

/*
 * A plugin update installs a new version next to this one; the scheduler (cron, launchd, Task Scheduler) starts the
 * newest, but only when no runner holds the lock. So a runner steps aside when it is out of date: before each run and
 * every minute of a wait, if a newer version is installed, Claude Code marked this one old (.orphaned_at), or its
 * files are gone, it exits 0 between runs and the scheduler starts the new one within a minute.
 */
const versionDir = dirname(here);
const cacheDir = dirname(versionDir);
const inCache = /[\\/]plugins[\\/]cache[\\/]agentorb[\\/]agentorb$/.test(cacheDir) || /[\\/]\.agentorb[\\/]runner$/.test(cacheDir);
const mine = basename(versionDir);
const parts = (v) => v.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
const cmp = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};
function outdated() {
  if (!existsSync(join(here, "agentorb-run.sh"))) return "this version's files were removed";
  if (!inCache) return null;
  if (existsSync(join(versionDir, ".orphaned_at"))) return `plugin ${mine} was replaced`;
  try {
    const latest = readdirSync(cacheDir).filter((d) => /^\d/.test(d) && existsSync(join(cacheDir, d, "scripts", "runner.mjs"))).sort(cmp).pop();
    if (latest && cmp(latest, mine) > 0) return `plugin ${mine} → ${latest}`;
  } catch {
    /* can't read the cache: carry on */
  }
  return null;
}
function stepAsideIfOutdated() {
  const why = outdated();
  if (!why) return;
  log(`${why}: restarting on the new version (the scheduler starts it within a minute)`);
  process.exit(0);
}
/** A wait that ends early to step aside for a new version, or on SIGTERM. */
async function nap(ms) {
  const end = Date.now() + ms;
  while (!stopping && Date.now() < end) {
    await sleep(Math.min(60_000, end - Date.now()));
    stepAsideIfOutdated();
  }
}

if (!key) {
  log("no key: put this repo's agent key in .agentorb.local.json or export AGENTORB_KEY");
  process.exit(1);
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => ((stopping = true), log(`${sig}: stopping after this step`)));

async function wait() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 300_000);
  try {
    const res = await fetch(`${base}/api/agents/wait`, { method: "POST", signal: ctl.signal, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(me.link ? { project: me.link.project } : {}) });
    if (res.status === 401) return { fatal: "the key is invalid or revoked" };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

function run() {
  return new Promise((resolve) => {
    const child = spawn("bash", [join(here, "agentorb-run.sh")], { stdio: "inherit", env: { ...process.env, AGENTORB_RUN_EVERY: "0" } });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (e) => (log(`run failed to start: ${e.message}`), resolve(1)));
  });
}

log(`runner connected to ${base} from ${process.cwd()}`);
let backoff = 5_000;
// The same thing waking it again right after a run means the run couldn't move it: back off (15 min, 30, … 2 h)
// instead of spending plan usage on it every few seconds.
let last = "";
let repeats = 0;
let crashes = 0;
/** The last run's outcome, as run.mjs wrote it (kind and, for a plan limit, when it resets). */
function outcome() {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".claude", "agentorb", "runs", `${createHash("sha256").update(me.key).digest("hex").slice(0, 16)}.json`), "utf8"));
  } catch {
    return null;
  }
}
while (!stopping) {
  stepAsideIfOutdated();
  const a = await wait();
  if (a.fatal) {
    log(`stopping: ${a.fatal}`);
    process.exit(1);
  }
  if (a.error) {
    const wait_ = jitter(backoff);
    log(`board unreachable (${a.error}); retrying in ${Math.round(wait_ / 1000)}s`);
    await nap(wait_);
    backoff = Math.min(backoff * 2, 300_000);
    continue;
  }
  backoff = 5_000;
  if (a.held) {
    log("on hold; checking again in a minute");
    await nap(jitter(60_000));
    continue;
  }
  if (!a.wake) continue;
  const what = `${a.why}:${a.what}`;
  repeats = what === last ? repeats + 1 : 0;
  last = what;
  if (repeats) {
    const ms = Math.min(15 * 60_000 * repeats, 2 * 60 * 60_000);
    log(`"${a.what}" is still waiting after the last run; trying again in ${Math.round(ms / 60_000)} min`);
    await nap(jitter(ms));
  }
  if (liveHere(me.root)) {
    log(`work: ${a.why} "${a.what}", but you have a session open in this repo; checking again in 5 min`);
    await nap(jitter(5 * 60_000));
    continue;
  }
  stepAsideIfOutdated();
  log(`work: ${a.why} "${a.what}"; starting a run`);
  const code = await run();
  // 0056: what to do next depends on why it ended.
  if (code === 0) {
    crashes = 0;
    await nap(jitter(5_000));
  } else if (code === 75) {
    // The plan's window is spent (or the API is overloaded): wait for the reset instead of retrying into it.
    const until = outcome()?.retryAt ?? Date.now() + 30 * 60_000;
    const ms = Math.max(60_000, Math.min(until - Date.now(), 6 * 60 * 60_000));
    log(`run hit the plan limit; waiting ${Math.round(ms / 60_000)} min, until it resets`);
    await nap(jitter(ms, 0.05) + 30_000);
  } else if (code === 70) {
    // Died without a result: retry once soon; again, and it is something real, so back off and let the board show it.
    crashes += 1;
    const ms = crashes === 1 ? 60_000 : Math.min(30 * 60_000 * (crashes - 1), 2 * 60 * 60_000);
    log(`run crashed (${crashes} in a row); trying again in ${Math.round(ms / 60_000)} min`);
    await nap(jitter(ms));
  } else {
    // 65 stuck (it ran and ended in an error) or 124 out of time: the same run again won't fix it right away.
    crashes = 0;
    log(`run ended ${code === 124 ? "out of time" : "with an error"} (${code}); next try in 10 min`);
    await nap(jitter(10 * 60_000));
  }
}

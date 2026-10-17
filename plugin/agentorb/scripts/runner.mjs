#!/usr/bin/env node
/*
 * AgentOrb runner: keeps one connection OUT to the board (POST /api/agents/wait, a long poll) and starts the usual
 * scheduled run (agentorb-run.sh: one short headless Claude Code session, its lock, time cap and tool allowlist) the
 * moment the board says there is work. Replaces the polling cron: no inbound ports, nothing exposed, work starts in
 * seconds. Uses your Claude subscription, like the cron did. Hold the agent in Settings → Agents to stop it taking work.
 *
 *   cd /path/to/repo && AGENTORB_KEY=ssk_... node runner.mjs
 *
 * One runner per agent and repo. Keep it alive with your own supervisor; for cron, a watchdog line like
 *   * * * * * cd /path/to/repo && flock -n /tmp/agentorb-runner-$(basename "$PWD").lock node "$(ls -d ~/.claude/plugins/cache/agentorb/agentorb/* | sort -V | tail -1)/scripts/runner.mjs" >> ~/agentorb-runner.log 2>&1
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveHere, serverUrl, session } from "./config.mjs";

const me = session();
const key = me.key;
const base = serverUrl(me.link).replace(/\/api\/mcp\/?$/, "").replace(/\/$/, "");
const here = dirname(fileURLToPath(import.meta.url));
const log = (s) => process.stdout.write(`${new Date().toISOString()} ${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
while (!stopping) {
  const a = await wait();
  if (a.fatal) {
    log(`stopping: ${a.fatal}`);
    process.exit(1);
  }
  if (a.error) {
    log(`board unreachable (${a.error}); retrying in ${Math.round(backoff / 1000)}s`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 300_000);
    continue;
  }
  backoff = 5_000;
  if (a.held) {
    log("on hold; checking again in a minute");
    await sleep(60_000);
    continue;
  }
  if (!a.wake) continue;
  const what = `${a.why}:${a.what}`;
  repeats = what === last ? repeats + 1 : 0;
  last = what;
  if (repeats) {
    const ms = Math.min(15 * 60_000 * repeats, 2 * 60 * 60_000);
    log(`"${a.what}" is still waiting after the last run; trying again in ${Math.round(ms / 60_000)} min`);
    await sleep(ms);
  }
  if (liveHere(me.root)) {
    log(`work: ${a.why} "${a.what}", but you have a session open in this repo; checking again in 5 min`);
    await sleep(5 * 60_000);
    continue;
  }
  log(`work: ${a.why} "${a.what}"; starting a run`);
  const code = await run();
  log(`run ended (${code})`);
  await sleep(code === 0 ? 5_000 : 60_000);
}

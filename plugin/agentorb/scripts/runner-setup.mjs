#!/usr/bin/env node
/*
 * Set up the background runner (runner.mjs) for this folder, so its agent works while nobody is here: it picks up
 * work, messages and due routines. Run by /agentorb:init (after connecting) and /agentorb:runner.
 *
 *   node runner-setup.mjs status | install [--replace] | uninstall
 *
 * - Linux and WSL: one crontab line per folder, every minute, kept to one runner by flock, marked with a trailing
 *   `# agentorb-runner <folder>` comment. Every other line is left exactly as it is.
 * - macOS: a LaunchAgent (~/Library/LaunchAgents/com.agentorb.runner.<hash>.plist), KeepAlive, loaded with launchctl.
 * - Windows (native, no WSL): a Task Scheduler task (schtasks): at logon and every minute, never two at once.
 *
 * The runner reads the folder's own key from .agentorb.local.json, so nothing secret goes into the job. Idempotent;
 * prints plain lines and never a key. For tests, point the system tools at fakes: AGENTORB_CRONTAB, AGENTORB_LAUNCHCTL,
 * AGENTORB_SCHTASKS, AGENTORB_FLOCK, and AGENTORB_RUNNER_PLATFORM (linux, wsl, darwin or win32).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { session } from "./config.mjs";

const say = (s = "") => process.stdout.write(s + "\n");
const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(here);
const me = session();
const folder = me.localDir ?? me.root;
const hash = createHash("sha256").update(folder).digest("hex").slice(0, 12);
const home = homedir();
const logDir = join(home, ".claude", "agentorb", "logs");
const logFile = join(logDir, `runner-${hash}.log`);
const cacheDir = join(home, ".claude", "plugins", "cache", "agentorb", "agentorb");
const inCache = resolve(pluginRoot).startsWith(resolve(cacheDir) + (process.platform === "win32" ? "\\" : "/"));

function platform() {
  const forced = process.env.AGENTORB_RUNNER_PLATFORM;
  if (forced) return forced;
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") {
    if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return "wsl";
    try {
      if (/microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"))) return "wsl";
    } catch {
      /* not readable: plain Linux */
    }
  }
  return "linux";
}

/** Run a tool; { ok, out, err, missing } (missing: the tool isn't installed). Never throws. */
function tool(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", timeout: 15_000, windowsHide: true });
  if (r.error) return { ok: false, out: "", err: r.error.message, missing: r.error.code === "ENOENT" };
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim(), status: r.status };
}

/** Where a command lives on PATH, or null. */
function which(name) {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    for (const e of exts) {
      const p = join(d, name + e);
      try {
        if (d && statSync(p).isFile()) return p;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

const ago = (ms) => (ms < 90_000 ? `${Math.round(ms / 1000)}s ago` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min ago` : ms < 48 * 3600_000 ? `${Math.round(ms / 3600_000)} h ago` : `${Math.round(ms / 86400_000)} days ago`);

/** The last lines of the folder's runner log, with how long ago it was written. */
function logTail(n = 3) {
  try {
    const st = statSync(logFile);
    const lines = readFileSync(logFile, "utf8").split(/\r?\n/).filter((l) => l.trim());
    return { lines: lines.slice(-n).map((l) => l.slice(0, 300)), age: Date.now() - st.mtimeMs };
  } catch {
    return null;
  }
}

/** The key must come from the folder's own file: the scheduled job has none of your shell's environment. */
function keyCheck() {
  if (me.keySource === "repo") return true;
  say(`AgentOrb: ${folder} has no agent key of its own (.agentorb.local.json)${me.keySource === "env" ? "; the AGENTORB_KEY in your shell isn't seen by a scheduled job" : ""}.`);
  say("Connect it first with /agentorb:init, then set up the runner.");
  return false;
}

/** PATH for the job: node's and claude's folders first (nvm, ~/.local/bin aren't on a scheduler's PATH). */
function jobPath(sep) {
  const dirs = [dirname(process.execPath)];
  const claude = which("claude");
  if (claude) dirs.push(dirname(claude));
  return [...new Set(dirs)].join(sep);
}

/* ---------------------------------------------------------------- Linux and WSL: crontab */

const CRONTAB = process.env.AGENTORB_CRONTAB || "crontab";
const FLOCK = process.env.AGENTORB_FLOCK || "flock";
const marker = `# agentorb-runner ${folder}`.replace(/%/g, "\\%");
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const cronEsc = (s) => s.replace(/%/g, "\\%");
const lockFile = `/tmp/agentorb-runner-${hash}.lock`;

function cronLine() {
  const runner = inCache ? `"$(ls -d "$HOME"/.claude/plugins/cache/agentorb/agentorb/*/ | sort -V | tail -1)scripts/runner.mjs"` : sq(join(here, "runner.mjs"));
  const path = `PATH=${sq(jobPath(":"))}:"$PATH"`;
  return cronEsc(`* * * * * cd ${sq(folder)} && ${path} flock -n ${lockFile} node ${runner} >> "$HOME/.claude/agentorb/logs/runner-${hash}.log" 2>&1 `) + marker;
}

function readCrontab() {
  const r = tool(CRONTAB, ["-l"]);
  if (r.missing) return { missing: true };
  // "no crontab for <user>" is an empty crontab, not an error.
  if (!r.ok && /no crontab/i.test(r.err + r.out)) return { lines: [] };
  if (!r.ok) return { error: r.err || `crontab -l failed (${r.status})` };
  const lines = r.out.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return { lines };
}

function writeCrontab(lines) {
  const r = tool(CRONTAB, ["-"], lines.length ? lines.join("\n") + "\n" : "");
  return r.ok ? null : r.err || `crontab - failed (${r.status})`;
}

const ours = (l) => l.endsWith(marker);
/** A runner line someone wrote by hand for this folder (a `cd <folder>` and runner.mjs, without our marker). */
function handMade(l) {
  if (ours(l) || /^\s*#/.test(l) || !l.includes("runner.mjs")) return false;
  const m = l.match(/\bcd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (!m) return false;
  const p = (m[1] ?? m[2] ?? m[3]).replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
  return resolve(p) === resolve(folder);
}

function cronMissing() {
  const p = platform();
  say("AgentOrb: `crontab` isn't installed, so there's nothing to schedule the runner with.");
  say(p === "wsl" ? "Install cron in this WSL distro (Ubuntu or Debian: `sudo apt install cron`), start it (`sudo service cron start`), then run this again." : "Install cron (Debian or Ubuntu: `sudo apt install cron`; Fedora: `sudo dnf install cronie && sudo systemctl enable --now crond`), then run this again.");
}

/** Is a cron daemon running? Read from /proc (no pgrep needed). null when it can't tell. */
function cronRunning() {
  if (process.env.AGENTORB_CRON_RUNNING) return process.env.AGENTORB_CRON_RUNNING === "1";
  try {
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        if (/^(cron|crond|cronie)$/.test(readFileSync(`/proc/${pid}/comm`, "utf8").trim())) return true;
      } catch {
        /* gone */
      }
    }
    return false;
  } catch {
    return null;
  }
}

function wslCronNote() {
  if (platform() !== "wsl") return;
  const up = cronRunning();
  let systemd = false;
  try {
    systemd = readFileSync("/proc/1/comm", "utf8").trim() === "systemd";
  } catch {
    /* unknown */
  }
  if (up === true) say(`cron is running in this WSL distro.${systemd ? "" : " WSL doesn't start it again after a restart: run `sudo service cron start` each time, or turn on systemd in /etc/wsl.conf ([boot] systemd=true) and `sudo systemctl enable cron`."}`);
  else if (up === false) say(`cron is NOT running in this WSL distro, so the runner won't start. Start it: ${systemd ? "`sudo systemctl enable --now cron`" : "`sudo service cron start` (and again after each WSL restart; or turn on systemd in /etc/wsl.conf, [boot] systemd=true, then `sudo systemctl enable cron`)"}.`);
  say("The runner only runs while WSL is up (a WSL terminal open, or WSL kept running).");
}

/** The runner process for this folder on Linux: its pid (a node runner.mjs whose working folder is this one). */
function linuxRunnerPid() {
  try {
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        if (!cmd.some((a) => a.endsWith("runner.mjs")) || !/node/.test(basename(cmd[0] ?? ""))) continue;
        if (resolve(readlinkSync(`/proc/${pid}/cwd`)) === resolve(folder)) return Number(pid);
      } catch {
        /* gone, or not ours to read */
      }
    }
  } catch {
    /* no /proc */
  }
  return null;
}

/** Is the folder's lock held (a runner holds it while it runs)? null when flock can't say. */
function lockHeld() {
  if (!existsSync(lockFile)) return false;
  const r = tool(FLOCK, ["-n", lockFile, "true"]);
  if (r.missing) return null;
  return !r.ok;
}

function cronStatus() {
  const tab = readCrontab();
  if (tab.missing) return cronMissing();
  if (tab.error) return say(`AgentOrb: couldn't read your crontab (${tab.error}).`);
  const mine = tab.lines.filter(ours);
  const hand = tab.lines.filter(handMade);
  if (mine.length) say(`Background runner for ${folder}: installed (a crontab line, every minute; marked "agentorb-runner").`);
  else if (hand.length) say(`Background runner for ${folder}: a crontab line you added by hand starts it (not managed here; \`install --replace\` swaps it for a managed one).`);
  else say(`Background runner for ${folder}: not installed.`);
  const pid = linuxRunnerPid();
  const held = lockHeld();
  say(pid ? `The runner is running (pid ${pid}).` : held ? "The runner is running (its lock is held)." : "The runner isn't running right now.");
  if (mine.length || hand.length) wslCronNote();
  tailReport();
}

function cronInstall(replace) {
  if (!keyCheck()) return 1;
  const tab = readCrontab();
  if (tab.missing) return cronMissing(), 1;
  if (tab.error) return say(`AgentOrb: couldn't read your crontab (${tab.error}). Nothing changed.`), 1;
  if (!which("flock") && !process.env.AGENTORB_FLOCK) say("Note: `flock` isn't on your PATH (it's in util-linux); without it the line won't start. Install util-linux.");
  const line = cronLine();
  const hand = tab.lines.filter(handMade);
  if (hand.length && !replace) {
    say(`AgentOrb: your crontab already starts a runner for ${folder} with a line you added by hand. Left it as it is.`);
    say("A second line would mean two runners for one agent. To swap yours for a managed one, run install with --replace.");
    return 0;
  }
  const kept = tab.lines.filter((l) => !ours(l) && !(replace && handMade(l)));
  const had = tab.lines.filter(ours);
  if (had.length === 1 && had[0] === line && !(replace && hand.length)) {
    say(`Background runner for ${folder}: already installed; nothing changed.`);
  } else {
    mkdirSync(logDir, { recursive: true });
    const err = writeCrontab([...kept, line]);
    if (err) return say(`AgentOrb: couldn't write your crontab (${err}). Nothing changed.`), 1;
    say(`Background runner for ${folder}: installed${had.length ? " (updated the line)" : ""}${replace && hand.length ? ", replacing the line you added by hand" : ""}. Your other crontab lines are unchanged.`);
    say("cron starts it within a minute and keeps it going (one at a time); it takes work, messages and due routines, and holds off while you have a Claude Code session open in this folder.");
  }
  if (!inCache) say(`Note: this plugin isn't in Claude Code's plugin cache, so the line points at ${here} directly; updates elsewhere won't be picked up.`);
  if (!which("claude")) say("Note: `claude` isn't on your PATH here, so runs can't start. Install Claude Code or add it to PATH, then run install again.");
  say(`Log: ${logFile}`);
  wslCronNote();
  say("Turn it off with /agentorb:runner off.");
  return 0;
}

function cronUninstall() {
  const tab = readCrontab();
  if (tab.missing) return cronMissing(), 1;
  if (tab.error) return say(`AgentOrb: couldn't read your crontab (${tab.error}). Nothing changed.`), 1;
  const had = tab.lines.filter(ours);
  if (had.length) {
    const err = writeCrontab(tab.lines.filter((l) => !ours(l)));
    if (err) return say(`AgentOrb: couldn't write your crontab (${err}). Nothing changed.`), 1;
    say(`Background runner for ${folder}: removed its crontab line. Your other lines are unchanged.`);
  } else say(`Background runner for ${folder}: no managed crontab line; nothing to remove.`);
  const hand = tab.lines.filter(handMade);
  if (hand.length) say("A runner line you added by hand for this folder is still in your crontab (left as it is); remove it with `crontab -e` to stop it for good.");
  const pid = linuxRunnerPid();
  if (pid && !hand.length) {
    try {
      process.kill(pid, "SIGTERM");
      say(`Asked the running runner (pid ${pid}) to stop; it finishes the step it's on first (up to a few minutes).`);
    } catch (e) {
      say(`The runner (pid ${pid}) is still running and couldn't be stopped (${e.code ?? e.message}).`);
    }
  }
  return 0;
}

/* ---------------------------------------------------------------- macOS and Windows: a small launcher */

/**
 * launchd and Task Scheduler start a program, not a shell line, so a launcher picks the newest installed plugin (an
 * update takes effect without touching the job) and starts its runner.mjs; with --log it writes the output there.
 */
const launcherFile = join(home, ".claude", "agentorb", "bin", "agentorb-runner.mjs");
function writeLauncher() {
  const src = `// Written by the AgentOrb plugin (runner-setup.mjs): starts the newest installed plugin's runner. Safe to delete with the job.
import { spawn } from "node:child_process";
import { existsSync, openSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const cache = join(homedir(), ".claude", "plugins", "cache", "agentorb", "agentorb");
const num = (v) => v.split(/[.-]/).map((x) => (/^\\d+$/.test(x) ? Number(x) : -1));
const newer = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; };
let dirs = [];
try { dirs = readdirSync(cache).filter((d) => existsSync(join(cache, d, "scripts", "runner.mjs"))).sort(newer); } catch { /* no cache */ }
const runner = dirs.length ? join(cache, dirs[dirs.length - 1], "scripts", "runner.mjs") : ${JSON.stringify(join(here, "runner.mjs"))};
const i = process.argv.indexOf("--log");
const out = i > 0 ? openSync(process.argv[i + 1], "a") : "inherit";
const child = spawn(process.execPath, [runner], { stdio: ["ignore", out, out], windowsHide: true });
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
child.on("exit", (code) => process.exit(code ?? 0));
`;
  mkdirSync(dirname(launcherFile), { recursive: true });
  if (!existsSync(launcherFile) || readFileSync(launcherFile, "utf8") !== src) writeFileSync(launcherFile, src);
}
/** Remove the launcher when no other folder's job uses it. */
function maybeRemoveLauncher(stillUsed) {
  if (!stillUsed) rmSync(launcherFile, { force: true });
}

/* ---------------------------------------------------------------- macOS: launchd */

const LAUNCHCTL = process.env.AGENTORB_LAUNCHCTL || "launchctl";
const label = `com.agentorb.runner.${hash}`;
const agentsDir = join(home, "Library", "LaunchAgents");
const plistFile = join(agentsDir, `${label}.plist`);
const uid = () => (typeof process.getuid === "function" ? process.getuid() : userInfo().uid);
const domain = () => `gui/${uid()}`;
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function plist() {
  const path = `${jobPath(":")}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <!-- agentorb-runner ${xml(folder)} -->
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(launcherFile)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(folder)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(path)}</string>
    <key>PWD</key><string>${xml(folder)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

function launchdState() {
  const r = tool(LAUNCHCTL, ["print", `${domain()}/${label}`]);
  if (r.missing) return { missing: true };
  if (!r.ok) return { loaded: false };
  const pid = r.out.match(/\bpid = (\d+)/)?.[1];
  return { loaded: true, running: /\bstate = running\b/.test(r.out) || Boolean(pid), pid: pid ? Number(pid) : null };
}

function launchdStatus() {
  const s = launchdState();
  const file = existsSync(plistFile);
  say(`Background runner for ${folder}: ${file ? `installed (LaunchAgent ${label})` : "not installed"}${file && s.loaded === false ? ", but not loaded (run install again to load it)" : ""}.`);
  if (s.missing) say("launchctl isn't available, so its state can't be read.");
  else say(s.running ? `The runner is running${s.pid ? ` (pid ${s.pid})` : ""}.` : "The runner isn't running right now.");
  tailReport();
}

function launchdInstall() {
  if (!keyCheck()) return 1;
  writeLauncher();
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const want = plist();
  const same = existsSync(plistFile) && readFileSync(plistFile, "utf8") === want;
  const s = launchdState();
  if (s.missing) return say("AgentOrb: launchctl isn't available, so the runner can't be scheduled."), 1;
  if (same && s.loaded) {
    say(`Background runner for ${folder}: already installed; nothing changed.`);
  } else {
    if (s.loaded) tool(LAUNCHCTL, ["bootout", `${domain()}/${label}`]);
    writeFileSync(plistFile, want);
    const r = tool(LAUNCHCTL, ["bootstrap", domain(), plistFile]);
    if (!r.ok) return say(`AgentOrb: wrote ${plistFile} but launchctl couldn't load it (${r.err || r.status}). Try: launchctl bootstrap ${domain()} "${plistFile}"`), 1;
    say(`Background runner for ${folder}: installed (LaunchAgent ${label}). It starts now and at every login, and restarts if it stops.`);
    say("It takes work, messages and due routines, and holds off while you have a Claude Code session open in this folder.");
  }
  if (!which("claude")) say("Note: `claude` isn't on your PATH here, so runs can't start. Install Claude Code, then run install again.");
  say(`Log: ${logFile}`);
  say("Turn it off with /agentorb:runner off.");
  return 0;
}

function launchdUninstall() {
  const s = launchdState();
  const file = existsSync(plistFile);
  if (s.loaded) tool(LAUNCHCTL, ["bootout", `${domain()}/${label}`]);
  rmSync(plistFile, { force: true });
  let others = false;
  try {
    others = readdirSync(agentsDir).some((f) => f.startsWith("com.agentorb.runner.") && f.endsWith(".plist"));
  } catch {
    /* none */
  }
  maybeRemoveLauncher(others);
  say(file || s.loaded ? `Background runner for ${folder}: stopped and removed (LaunchAgent ${label}).` : `Background runner for ${folder}: not installed; nothing to remove.`);
  return 0;
}

/* ---------------------------------------------------------------- Windows: Task Scheduler */

const SCHTASKS = process.env.AGENTORB_SCHTASKS || "schtasks";
const taskName = `AgentOrb runner ${hash}`;
const taskXmlFile = join(home, ".claude", "agentorb", "bin", `task-${hash}.xml`);

function taskXml() {
  // PowerShell, hidden, waits for node: one window flash at logon, and the task counts as running while the runner
  // does, so the every-minute trigger never starts a second one (IgnoreNew).
  const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const cmd = `$env:PATH = ${ps(jobPath(";"))} + ';' + $env:PATH; & ${ps(process.execPath)} ${ps(launcherFile)} --log ${ps(logFile)}`;
  const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : userInfo().username;
  const start = new Date(Date.now() + 60_000).toISOString().slice(0, 19);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>AgentOrb background runner for ${xml(folder)} (agentorb-runner)</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger>
    <TimeTrigger><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>${xml(`-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "${cmd.replace(/"/g, '\\"')}"`)}</Arguments>
      <WorkingDirectory>${xml(folder)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function taskState() {
  const r = tool(SCHTASKS, ["/Query", "/TN", taskName, "/FO", "LIST"]);
  if (r.missing) return { missing: true };
  if (!r.ok) return { installed: false };
  const status = r.out.match(/^Status:\s*(.+)$/m)?.[1]?.trim() ?? "";
  return { installed: true, running: /running/i.test(status), status };
}

function manualSchtasks() {
  say("Set it up by hand from a Windows terminal (cmd or PowerShell) instead:");
  say(`  schtasks /Create /TN "${taskName}" /XML "${taskXmlFile}" /F`);
}

function taskStatus() {
  const s = taskState();
  if (s.missing) return say("AgentOrb: schtasks isn't available, so the runner's task can't be read."), tailReport();
  say(`Background runner for ${folder}: ${s.installed ? `installed (Task Scheduler task "${taskName}")` : "not installed"}.`);
  if (s.installed) say(s.running ? "The runner is running." : `The runner isn't running right now${s.status ? ` (task: ${s.status})` : ""}.`);
  tailReport();
}

function taskInstall() {
  if (!keyCheck()) return 1;
  if (!which("bash")) say("Note: the runner starts each run with bash (Git for Windows provides it), and bash isn't on your PATH. Install Git for Windows, or use the plugin from WSL instead.");
  writeLauncher();
  mkdirSync(logDir, { recursive: true });
  const want = taskXml();
  // Task Scheduler reads task XML as UTF-16 (little-endian, with a byte-order mark).
  writeFileSync(taskXmlFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(want, "utf16le")]));
  const s = taskState();
  if (s.missing) return say("AgentOrb: schtasks isn't available."), manualSchtasks(), 1;
  const r = tool(SCHTASKS, ["/Create", "/TN", taskName, "/XML", taskXmlFile, "/F"]);
  if (!r.ok) return say(`AgentOrb: Task Scheduler didn't take the task (${r.err || r.status}).`), manualSchtasks(), 1;
  if (!s.installed) tool(SCHTASKS, ["/Run", "/TN", taskName]);
  say(`Background runner for ${folder}: ${s.installed ? "already installed (task refreshed)" : `installed (Task Scheduler task "${taskName}")`}. It runs at logon and is checked every minute, one at a time.`);
  say("It takes work, messages and due routines, and holds off while you have a Claude Code session open in this folder.");
  if (!which("claude")) say("Note: `claude` isn't on your PATH here, so runs can't start. Install Claude Code, then run install again.");
  say(`Log: ${logFile}`);
  say("Turn it off with /agentorb:runner off.");
  return 0;
}

function taskUninstall() {
  const s = taskState();
  if (s.missing) return say("AgentOrb: schtasks isn't available. Remove it by hand:"), say(`  schtasks /End /TN "${taskName}" & schtasks /Delete /TN "${taskName}" /F`), 1;
  if (s.installed) {
    tool(SCHTASKS, ["/End", "/TN", taskName]);
    const r = tool(SCHTASKS, ["/Delete", "/TN", taskName, "/F"]);
    if (!r.ok) return say(`AgentOrb: couldn't remove the task (${r.err || r.status}). Try: schtasks /Delete /TN "${taskName}" /F`), 1;
  }
  rmSync(taskXmlFile, { force: true });
  let others = false;
  try {
    others = readdirSync(dirname(launcherFile)).some((f) => /^task-.*\.xml$/.test(f));
  } catch {
    /* none */
  }
  maybeRemoveLauncher(others);
  say(s.installed ? `Background runner for ${folder}: stopped and removed (task "${taskName}").` : `Background runner for ${folder}: not installed; nothing to remove.`);
  return 0;
}

/* ---------------------------------------------------------------- shared */

function tailReport() {
  const t = logTail(3);
  if (!t) return say("No log yet.");
  say(`Log (${logFile}), last written ${ago(t.age)}:`);
  for (const l of t.lines) say(`  ${l}`);
}

const [cmd = "status", ...flags] = process.argv.slice(2);
const p = platform();
const impl = p === "darwin" ? { status: launchdStatus, install: launchdInstall, uninstall: launchdUninstall } : p === "win32" ? { status: taskStatus, install: taskInstall, uninstall: taskUninstall } : { status: cronStatus, install: () => cronInstall(flags.includes("--replace")), uninstall: cronUninstall };
const alias = { on: "install", off: "uninstall", remove: "uninstall" };
const run = impl[alias[cmd] ?? cmd];
if (!run) {
  say("Usage: runner-setup.mjs status | install [--replace] | uninstall");
  process.exit(1);
}
if (!me.link) say(`Note: ${folder} isn't linked to a board yet (.agentorb.json); /agentorb:init connects it.`);
process.exit((await run()) ?? 0);

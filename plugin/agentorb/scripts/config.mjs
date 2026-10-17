/*
 * Where this session is and who it is, for every script in the plugin (the MCP headers helper, the hooks, the runner).
 *
 * - The repo: CLAUDE_PROJECT_DIR (hooks), else PWD (the shell `claude` was started from; the headers helper runs in the
 *   plugin's folder), else the current directory; then up to its git root.
 * - The link: .agentorb.json at the repo root ({ project, workspace, url }, written by /agentorb:init). A repo without
 *   it isn't on a board: the plugin stays quiet there (no briefing, no autopilot).
 * - The key: .agentorb.local.json at the repo root ({ "key": "ssk_..." }, git-ignored: this repo's own agent), else
 *   AGENTORB_KEY from the environment (one agent for every repo).
 *
 * Never prints the key.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export function startDir() {
  return resolve(process.env.CLAUDE_PROJECT_DIR || sessionDirFromParents() || process.env.PWD || process.cwd());
}

/**
 * The MCP headers helper runs in the plugin's own folder with neither CLAUDE_PROJECT_DIR nor a useful PWD, so find
 * the session's directory from the processes above it: the first one not in the plugin's folder is Claude Code itself,
 * whose working directory is the session's. Linux reads /proc; macOS asks ps and lsof. Only for the helper (hooks
 * have CLAUDE_PROJECT_DIR).
 */
function sessionDirFromParents() {
  if (!process.env.CLAUDE_CODE_MCP_SERVER_NAME) return null;
  const plugin = process.env.CLAUDE_PLUGIN_ROOT ? resolve(process.env.CLAUDE_PLUGIN_ROOT) : resolve(process.cwd());
  const linux = existsSync("/proc/self/stat");
  const parentOf = (pid) => {
    try {
      if (linux) return Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[1]);
      return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"], timeout: 1000 }).toString().trim());
    } catch {
      return 0;
    }
  };
  const cwdOf = (pid) => {
    try {
      if (linux) return readlinkSync(`/proc/${pid}/cwd`);
      const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { stdio: ["ignore", "pipe", "ignore"], timeout: 1500 }).toString();
      return out.split("\n").find((l) => l.startsWith("n"))?.slice(1) || null;
    } catch {
      return null;
    }
  };
  let pid = process.ppid;
  for (let i = 0; i < 6 && pid > 1; i++) {
    const cwd = cwdOf(pid);
    if (cwd && resolve(cwd) !== plugin) return cwd;
    pid = parentOf(pid);
  }
  return null;
}

/** The git root of the session's directory, or the directory itself outside git. */
export function repoRoot(dir = startDir()) {
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim();
    return out || dir;
  } catch {
    return dir;
  }
}

function readJson(f) {
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  } catch {
    return null;
  }
}

/** The folders from the session's directory up to the repo root (where .agentorb files are looked for). */
function upToRoot(dir, root) {
  const out = [];
  let d = resolve(dir);
  for (let i = 0; i < 20; i++) {
    out.push(d);
    if (d === root || dirname(d) === d) break;
    d = dirname(d);
  }
  if (!out.includes(root)) out.push(root);
  return out;
}

/** { root, link, key, keySource }: link is .agentorb.json (or null); keySource is "repo", "env" or null. */
export function session() {
  const dir = startDir();
  const root = repoRoot(dir);
  let link = null;
  let local = null;
  for (const d of upToRoot(dir, root)) {
    link ??= ((j) => (j && typeof j.project === "string" ? j : null))(readJson(join(d, ".agentorb.json")));
    local ??= ((j) => (j && typeof j.key === "string" && j.key.trim().startsWith("ssk_") ? j.key.trim() : null))(readJson(join(d, ".agentorb.local.json")));
  }
  const env = process.env.AGENTORB_KEY?.trim() || null;
  const key = local ?? env;
  return { root, link, key, keySource: local ? "repo" : env ? "env" : null };
}

export const serverUrl = (link) => (process.env.AGENTORB_URL?.trim() || (link?.url ? `${String(link.url).replace(/\/$/, "")}/api/mcp` : "https://app.agent-orb.com/api/mcp")).replace(/\/$/, "");

/* ---- the live-session marker: the runner doesn't start a run in a repo where you have a session open */

const SESSIONS = join(homedir(), ".claude", "agentorb", "sessions");
const markerOf = (root) => join(SESSIONS, `${createHash("sha256").update(root).digest("hex").slice(0, 16)}.json`);
/** A session counts as open for this long after its last sign of life (start, or a stop between turns). */
export const LIVE_MS = 20 * 60_000;

export function markLive(root, sessionId) {
  if (process.env.AGENTORB_HEADLESS) return; // the runner's own runs don't count as you being here
  try {
    mkdirSync(SESSIONS, { recursive: true });
    writeFileSync(markerOf(root), JSON.stringify({ root, session: sessionId ?? null, at: new Date().toISOString() }));
  } catch {
    /* best effort */
  }
}
export function clearLive(root) {
  if (process.env.AGENTORB_HEADLESS) return;
  try {
    rmSync(markerOf(root), { force: true });
  } catch {
    /* best effort */
  }
}
/** Is an interactive session open in this repo (seen in the last LIVE_MS)? */
export function liveHere(root) {
  try {
    return Date.now() - statSync(markerOf(root)).mtimeMs < LIVE_MS;
  } catch {
    return false;
  }
}

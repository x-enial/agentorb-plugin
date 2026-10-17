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
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/**
 * Is this repo a linked git worktree (a second checkout made with `git worktree add`)? Then `main` is the main
 * checkout's folder. Each worktree is its own folder, so it can be its own agent (its own .agentorb.local.json).
 */
export function worktreeOf(root) {
  try {
    const q = (arg) => execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", arg], { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim();
    const gitDir = q("--git-dir");
    const common = q("--git-common-dir");
    if (!gitDir || !common || resolve(gitDir) === resolve(common)) return { linked: false, main: null };
    return { linked: true, main: common.endsWith(".git") ? dirname(common) : null };
  } catch {
    return { linked: false, main: null };
  }
}

/** The key in a folder's .agentorb.local.json, or null. */
export function keyIn(dir) {
  const j = readJson(join(dir, ".agentorb.local.json"));
  return j && typeof j.key === "string" && j.key.trim().startsWith("ssk_") ? j.key.trim() : null;
}

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
export function clearLive(root, key, sessionId) {
  if (process.env.AGENTORB_HEADLESS) return;
  try {
    rmSync(markerOf(root), { force: true });
    if (key && sessionId) rmSync(join(agentDir(key), `${safeName(sessionId)}.json`), { force: true });
  } catch {
    /* best effort */
  }
}

/* ---- one agent, two sessions: each session here marks the agent (by its key's hash) it acts as */

const AGENTS = join(homedir(), ".claude", "agentorb", "agents");
const agentDir = (key) => join(AGENTS, createHash("sha256").update(key).digest("hex").slice(0, 16));
const safeName = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "session";

/**
 * Mark this session as acting with `key`, and say which other open sessions (seen in the last LIVE_MS) act with the
 * same key: those are the same agent on the board (one status line, one set of claims), which is never what you want.
 * Returns their folders. Only sees sessions on this machine.
 */
export function sameAgentElsewhere(key, sessionId, root) {
  if (!key || !sessionId || process.env.AGENTORB_HEADLESS) return [];
  try {
    const dir = agentDir(key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${safeName(sessionId)}.json`), JSON.stringify({ root, at: new Date().toISOString() }));
    const others = [];
    for (const f of readdirSync(dir)) {
      if (f === `${safeName(sessionId)}.json`) continue;
      const path = join(dir, f);
      if (Date.now() - statSync(path).mtimeMs > LIVE_MS) {
        rmSync(path, { force: true });
        continue;
      }
      const j = readJson(path);
      if (j?.root) others.push(j.root);
    }
    return others;
  } catch {
    return [];
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

/* ---- the access inventory (0054): what this session can reach outside AgentOrb, by name only */

// A rule that carries something secret-looking (a long random run of letters and digits) isn't sent at all.
const secretish = (s) => /[A-Za-z0-9_-]{24,}/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);

/**
 * { servers, plugins, allow, deny, mode } from Claude Code's settings: MCP servers by name (user and local from
 * ~/.claude.json, project from .mcp.json), enabled plugins, and the permission rules that allow or deny without
 * asking (user, project and local settings). Never URLs, headers, env or keys. claude.ai connectors aren't in local
 * files, so they don't show here.
 */
export function reachOf(root = session().root) {
  const home = homedir();
  const servers = [];
  const add = (obj, from) => {
    for (const name of Object.keys(obj ?? {})) if (!servers.some((s) => s.name === name)) servers.push({ name: name.slice(0, 100), from });
  };
  const claudeJson = readJson(join(home, ".claude.json")) ?? {};
  add(claudeJson.mcpServers, "user");
  add(claudeJson.projects?.[root]?.mcpServers, "local");
  add(readJson(join(root, ".mcp.json"))?.mcpServers, "project");
  const settings = [join(home, ".claude", "settings.json"), join(root, ".claude", "settings.json"), join(root, ".claude", "settings.local.json")].map(readJson).filter(Boolean);
  const plugins = [...new Set(settings.flatMap((s) => Object.entries(s.enabledPlugins ?? {}).filter(([, on]) => on).map(([k]) => k)))].slice(0, 100);
  const rules = (k) => [...new Set(settings.flatMap((s) => (Array.isArray(s.permissions?.[k]) ? s.permissions[k] : [])))].filter((r) => typeof r === "string" && !secretish(r)).map((r) => r.slice(0, 200)).slice(0, 300);
  const mode = settings.map((s) => s.permissions?.defaultMode).filter(Boolean).pop();
  return { servers: servers.slice(0, 100), plugins, allow: rules("allow"), deny: rules("deny"), ...(mode ? { mode: String(mode).slice(0, 40) } : {}) };
}

/**
 * AgentOrb MCP servers set up by hand next to the plugin's (`claude mcp add ... agentorb`, from before the plugin):
 * each acts as whatever agent its own key is, so a session would be two agents at once (one per server). Names and
 * scopes only, with the command that removes each.
 */
export function strayServers(root = session().root) {
  const home = homedir();
  const out = [];
  const look = (servers, scope) => {
    for (const [name, cfg] of Object.entries(servers ?? {})) {
      const url = String(cfg?.url ?? "");
      if (!/agent-orb\.com\/api\/mcp|\/api\/mcp$/.test(url) || !/agent-?orb/i.test(name + url)) continue;
      out.push({ name, scope, remove: `claude mcp remove ${name} -s ${scope}` });
    }
  };
  const claudeJson = readJson(join(home, ".claude.json")) ?? {};
  look(claudeJson.mcpServers, "user");
  look(claudeJson.projects?.[root]?.mcpServers, "local");
  look(readJson(join(root, ".mcp.json"))?.mcpServers, "project");
  return out;
}

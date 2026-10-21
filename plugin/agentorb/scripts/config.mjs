/*
 * Where this session is and who it is, for every script in the plugin (the MCP headers helper, the hooks, the runner).
 *
 * - The repo: CLAUDE_PROJECT_DIR (hooks), else PWD (the shell `claude` was started from; the headers helper runs in the
 *   plugin's folder), else the current directory; then up to its git root.
 * - The link: .agentorb.json at the repo root ({ project, workspace, url }, written by /agentorb:init). A repo without
 *   it isn't on a board: the plugin stays quiet there (no briefing, no autopilot).
 * - The key: .agentorb.local.json at the repo root ({ "key": "ssk_..." }, git-ignored: this repo's own agent), else
 *   AGENTORB_KEY from the environment (one agent for every repo).
 * - Headless or live: the runner (run.mjs) exports AGENTORB_HEADLESS=1 before starting `claude`/`codex`; without it the
 *   session has a person in it (headless()). The outbound gate is stricter headless (pre-tool.mjs).
 *
 * Never prints the key.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/**
 * Is there an .agentorb.json anywhere from the session's directory up? A file walk only: no git, no JSON parsing.
 * The hooks run in every repo on the machine (the plugin is installed per user), so the ones that would otherwise
 * spawn git or write markers ask this first and leave a folder that isn't on a board alone. session() looks only
 * between the directory and its git root, which this walk covers, so "none here" means session() finds none either.
 */
export function linkedNearby(dir = startDir()) {
  let d = resolve(dir);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(d, ".agentorb.json"))) return true;
    const up = dirname(d);
    if (up === d) return false;
    d = up;
  }
  return false;
}

/** { root, link, key, keySource }: link is .agentorb.json (or null); keySource is "repo", "env" or null. */
export function session() {
  const dir = startDir();
  const root = repoRoot(dir);
  let link = null;
  let local = null;
  let extra = null;
  let home = root;
  for (const d of upToRoot(dir, root)) {
    link ??= ((j) => (j && typeof j.project === "string" ? j : null))(readJson(join(d, ".agentorb.json")));
    if (!local) {
      const j = readJson(join(d, ".agentorb.local.json"));
      if (j && typeof j.key === "string" && j.key.trim().startsWith("ssk_")) {
        local = j.key.trim();
        // 0057: the agent's role and its page, as /agentorb:init (or session start) last set the folder up; and the MCP
        // servers whose send tools are the person's own in live sessions (sendAllowed, see sendAllowedOf).
        extra = { role: typeof j.role === "string" ? j.role : null, page: typeof j.page === "string" ? j.page : null, sendAllowed: sendAllowedOf(j) };
        home = d;
      }
    }
  }
  const env = process.env.AGENTORB_KEY?.trim() || null;
  const key = local ?? env;
  return { root, link, key, keySource: local ? "repo" : env ? "env" : null, role: extra?.role ?? null, page: extra?.page ?? null, localDir: local ? home : null, sendAllowed: extra?.sendAllowed ?? [] };
}

/** The runner's runs (run.mjs exports AGENTORB_HEADLESS=1): no person is watching, so nothing goes out on anyone's say-so. */
export const headless = () => !!process.env.AGENTORB_HEADLESS;

/* ---- send tools that are the person's own in live sessions (.agentorb.local.json "sendAllowed") */

/**
 * The gate's default pattern for a tool that sends, posts or publishes (mcp__<server>__send_message, reply,
 * post_message...). pre-tool.mjs applies it (AGENTORB_OUTBOUND overrides it there); role-setup.mjs uses it to see
 * whether the person's own allow rules name such a tool.
 */
export const OUTBOUND_RE = /^mcp__.+__(?:send|reply|forward|post|publish|tweet|share|send_[a-z_]+|post_[a-z_]+|publish_[a-z_]+|[a-z_]+_send|[a-z_]+_post_message|create_post|create_tweet|reply_[a-z_]+)$/i;

/** The server part of an MCP tool name (mcp__<server>__<tool>), or null for anything else. */
export const serverOfTool = (tool) => /^mcp__(.+?)__/.exec(String(tool))?.[1] ?? null;

const cleanServers = (list) => (Array.isArray(list) ? [...new Set(list.filter((s) => typeof s === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(s)))] : []);
/** The `sendAllowed` list in a parsed .agentorb.local.json: MCP server names (the middle of mcp__<server>__<tool>). */
export const sendAllowedOf = (j) => cleanServers(j?.sendAllowed);
/** The list in a folder's .agentorb.local.json (nothing else in the file is read out). */
export const sendAllowedIn = (dir) => sendAllowedOf(readJson(join(dir, ".agentorb.local.json")));
/**
 * Set a folder's sendAllowed list, keeping everything else in .agentorb.local.json as it is (the key is never printed
 * or moved). Only when the file exists: connect.mjs makes it, with the key, first. Returns the list written, or null.
 */
export function writeSendAllowed(dir, list) {
  const file = join(dir, ".agentorb.local.json");
  if (!existsSync(file)) return null;
  let j;
  try {
    j = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const next = cleanServers(list);
  if (next.length) j.sendAllowed = next;
  else delete j.sendAllowed;
  writeFileSync(file, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  return next;
}

/**
 * Where calls (and the key) go: the plugin's own address of the MCP server (/api/mcp/plugin, 0.32.0). Claude Code
 * keeps one MCP server per URL, so a claude.ai AgentOrb connector on the same account (which uses /api/mcp) used to
 * replace the plugin's server in `claude -p` runs, and the runner's calls went out as the wrong agent.
 * AGENTORB_URL from your own environment wins; else the repo's .agentorb.json url, but
 * only an AgentOrb host over https: a committed file must never be able to send a key somewhere else (a cloned repo
 * could say anything). Anything else is ignored with a warning, and the canonical server is used.
 */
const CANONICAL = "https://app.agent-orb.com";
const ownHost = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && /(^|\.)agent-orb\.com$/i.test(x.hostname);
  } catch {
    return false;
  }
};
let warnedUrl = null;
export const serverUrl = (link) => {
  const env = process.env.AGENTORB_URL?.trim();
  if (env) return env.replace(/\/$/, "");
  if (link?.url) {
    const u = String(link.url).replace(/\/$/, "");
    if (ownHost(u)) return `${u}/api/mcp/plugin`;
    if (warnedUrl !== u) {
      warnedUrl = u;
      console.error(`agentorb: ignoring url ${u} from .agentorb.json (not an agent-orb.com host): the key goes only to AgentOrb. Set AGENTORB_URL yourself to use another server.`);
    }
  }
  return `${CANONICAL}/api/mcp/plugin`;
};

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

/* ---- the live-session marker: the runner doesn't start a run in a repo you're active in (LIVE_MS after your last turn or tool call) */

const SESSIONS = join(homedir(), ".claude", "agentorb", "sessions");
const markerOf = (root) => join(SESSIONS, `${createHash("sha256").update(root).digest("hex").slice(0, 16)}.json`);
/**
 * A session counts as "you're here" for this long after its last sign of life: its start, the end of a turn, or any
 * tool call (touchLive, from the PreToolUse hook). The runner stays out of a repo you're active in (same agent, same
 * files) and takes over this long after you stop; closing the session ends it at once.
 */
export const LIVE_MS = 10 * 60_000;

export function markLive(root, sessionId) {
  if (process.env.AGENTORB_HEADLESS) return; // the runner's own runs don't count as you being here
  try {
    mkdirSync(SESSIONS, { recursive: true });
    writeFileSync(markerOf(root), JSON.stringify({ root, session: sessionId ?? null, at: new Date().toISOString() }));
  } catch {
    /* best effort */
  }
}
/** Refresh the marker from a tool call, at most once a minute (the hook runs on every call). */
export function touchLive(root) {
  if (process.env.AGENTORB_HEADLESS) return;
  try {
    const path = markerOf(root);
    if (Date.now() - statSync(path).mtimeMs < 60_000) return;
    const j = readJson(path);
    writeFileSync(path, JSON.stringify({ root, session: j?.session ?? null, at: new Date().toISOString() }));
  } catch {
    /* no marker yet (not a session-start'd repo): nothing to refresh */
  }
}
/** Minutes since the open session's last sign of life, or null when none is open. */
export function liveAgoMinutes(root) {
  try {
    const ms = Date.now() - statSync(markerOf(root)).mtimeMs;
    return ms < LIVE_MS ? Math.max(0, Math.round(ms / 60_000)) : null;
  } catch {
    return null;
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
/** Are you active in this repo (a session's start, turn or tool call within LIVE_MS)? */
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

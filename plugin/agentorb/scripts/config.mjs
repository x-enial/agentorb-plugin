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
 * - The gate's switches (0103): a folder with its own key is relaxed only by its own git-ignored .agentorb.local.json
 *   ("sendAllowed", "gate": "off"; allow-send.mjs writes both), never by the environment, which a cloned repo's committed
 *   .claude/settings.json can set (AGENTORB_OUTBOUND_GATE=off, AGENTORB_OUTBOUND). See gateOff() and outboundRe().
 *
 * Never prints the key.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function startDir() {
  // The headers helper: Claude Code may hand it a CLAUDE_PROJECT_DIR that isn't the session's folder (seen on 2.1.286:
  // set, yet the helper found no board there and sent an empty key). There the session's folder comes from the
  // processes above it first, and CLAUDE_PROJECT_DIR only counts when it is set up for AgentOrb.
  if (process.env.AGENTORB_HEADERS_HELPER) {
    const given = process.env.CLAUDE_PROJECT_DIR;
    const plugin = process.env.CLAUDE_PLUGIN_ROOT ? resolve(process.env.CLAUDE_PLUGIN_ROOT) : null;
    const usable = given && (!plugin || !resolve(given).startsWith(plugin)) && setUpForAgentOrb(given) ? given : null;
    return resolve(sessionDirFromParents() || usable || process.env.PWD || process.cwd());
  }
  return resolve(process.env.CLAUDE_PROJECT_DIR || sessionDirFromParents() || process.env.PWD || process.cwd());
}

/** Is `d`, or a folder above it, set up for AgentOrb (.agentorb.local.json or .agentorb.json)? */
function setUpForAgentOrb(d) {
  for (let cur = resolve(d), i = 0; i < 12; i++) {
    if (existsSync(join(cur, ".agentorb.local.json")) || existsSync(join(cur, ".agentorb.json"))) return true;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return false;
}

/**
 * The MCP headers helper runs in the plugin's own folder with neither CLAUDE_PROJECT_DIR nor a useful PWD, so find
 * the session's directory from the processes above it: the first one not in the plugin's folder is Claude Code itself,
 * whose working directory is the session's. Linux reads /proc; macOS asks ps and lsof. Only for the helper (hooks
 * have CLAUDE_PROJECT_DIR).
 */
function sessionDirFromParents() {
  // Only the headers helper walks up (headers.mjs sets AGENTORB_HEADERS_HELPER). Some Claude Code builds don't set
  // CLAUDE_CODE_MCP_SERVER_NAME for the helper, and without the walk an interactive session never finds its folder's
  // key: it then sends the empty "Bearer ${AGENTORB_KEY}" and is refused (401).
  if (!process.env.CLAUDE_CODE_MCP_SERVER_NAME && !process.env.AGENTORB_HEADERS_HELPER) return null;
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
  // The first parent whose folder (or a folder above it) is set up for AgentOrb wins; else the first one outside the
  // plugin's folder, as before (a shell between Claude Code and the helper may sit in the home folder).
  const setUp = setUpForAgentOrb;
  let first = null;
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    const cwd = cwdOf(pid);
    if (cwd && resolve(cwd) !== plugin) {
      if (setUp(cwd)) return cwd;
      first ??= cwd;
    }
    pid = parentOf(pid);
  }
  return first;
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
        extra = { role: typeof j.role === "string" ? j.role : null, page: typeof j.page === "string" ? j.page : null, sendAllowed: sendAllowedOf(j), gateOff: j.gate === "off" };
        home = d;
      }
    }
  }
  const env = process.env.AGENTORB_KEY?.trim() || null;
  const key = local ?? env;
  return { root, link, key, keySource: local ? "repo" : env ? "env" : null, role: extra?.role ?? null, page: extra?.page ?? null, localDir: local ? home : null, sendAllowed: extra?.sendAllowed ?? [], gateOff: !!extra?.gateOff };
}

/** The runner's runs (run.mjs exports AGENTORB_HEADLESS=1): no person is watching, so nothing goes out on anyone's say-so. */
export const headless = () => !!process.env.AGENTORB_HEADLESS;

/* ---- send tools that are the person's own in live sessions (.agentorb.local.json "sendAllowed") */

/**
 * The gate's default pattern for a tool that sends, posts or publishes (mcp__<server>__send_message, reply,
 * post_message...). pre-tool.mjs applies it (AGENTORB_OUTBOUND overrides it there); role-setup.mjs uses it to see
 * whether the person's own allow rules name such a tool.
 */
/**
 * The permission rule that allows every AgentOrb board tool (the plugin's server, mcp__plugin_agentorb_agentorb__*).
 * Claude Code needs the server named: a bare mcp__* allows nothing, so an agent folder without this rule had every board
 * call denied in its unattended runs. The runner always passes it, and setup writes it into the folder's settings.
 */
export const BOARD_TOOLS = "mcp__plugin_agentorb_agentorb";
/** A board tool's full name (the plugin's server, or the claude.ai connector's). */
export const BOARD_TOOL_RE = /^mcp__(plugin_agentorb_|claude_ai_)?agentorb__/i;

export const OUTBOUND_RE = /^mcp__.+__(?:send|reply|forward|post|publish|tweet|share|send_[a-z_]+|post_[a-z_]+|publish_[a-z_]+|[a-z_]+_send|[a-z_]+_post_message|create_post|create_tweet|reply_[a-z_]+)$/i;

/** The server part of an MCP tool name (mcp__<server>__<tool>), or null for anything else. */
export const serverOfTool = (tool) => /^mcp__(.+?)__/.exec(String(tool))?.[1] ?? null;

/**
 * Is the outbound gate off for this session (0103)? Never headless: the runner's sends are always the board's to
 * check. Live, a folder with its own key is switched off only by its own .agentorb.local.json ("gate": "off", written
 * by allow-send.mjs --gate-off): AGENTORB_OUTBOUND_GATE=off from the environment is ignored there, since a cloned
 * repo's committed .claude/settings.json can set it. A folder on AGENTORB_KEY alone (no local file) still honours it.
 */
export const gateOff = (me) => !headless() && (!!me?.gateOff || (me?.keySource !== "repo" && process.env.AGENTORB_OUTBOUND_GATE === "off"));

/**
 * The pattern that names a send tool for this session: OUTBOUND_RE, or AGENTORB_OUTBOUND from the environment. In a
 * folder with its own key the environment can only widen it (both patterns apply): narrowed to nothing it would be the
 * gate off by another name. `note` is the one-line notice to print once per session when the override is set; an
 * unreadable pattern is ignored and said so.
 */
export function outboundRe(me) {
  const raw = process.env.AGENTORB_OUTBOUND;
  if (!raw) return { re: OUTBOUND_RE, note: null };
  let env;
  try {
    env = new RegExp(raw, "i");
  } catch {
    return { re: OUTBOUND_RE, note: "AGENTORB_OUTBOUND is set in this environment but isn't a valid pattern; the outbound gate uses its own." };
  }
  if (me?.keySource === "repo") {
    const re = { test: (t) => OUTBOUND_RE.test(t) || env.test(t) };
    return { re, note: "AGENTORB_OUTBOUND is set in this environment: the outbound gate also checks tools matching it (it can't narrow the gate's own pattern in a folder with its own key)." };
  }
  return { re: env, note: "AGENTORB_OUTBOUND is set in this environment: the outbound gate checks tools matching that pattern instead of its own." };
}

/** Set or clear "gate": "off" in a folder's .agentorb.local.json (the rest, the key included, stays as it is). */
export function writeGate(dir, off) {
  const file = join(dir, ".agentorb.local.json");
  if (!existsSync(file)) return null;
  let j;
  try {
    j = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  if (off) j.gate = "off";
  else delete j.gate;
  writeFileSync(file, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  return !!off;
}

/**
 * The one line session start prints when the live-session gate is relaxed here (0103), so a cloned repo's seeded
 * allowlist or a gate someone switched off is seen; null when every send tool waits for approved text.
 */
export function gateLine(me) {
  const cmd = `node "${join(dirname(fileURLToPath(import.meta.url)), "allow-send.mjs")}"`;
  const servers = me?.sendAllowed?.length ? me.sendAllowed.join(", ") : "";
  if (me?.gateOff || (me?.keySource !== "repo" && process.env.AGENTORB_OUTBOUND_GATE === "off")) {
    return `Outbound gate: off in live sessions for every send tool${me?.gateOff ? ' (.agentorb.local.json "gate": "off")' : " (AGENTORB_OUTBOUND_GATE=off in the environment)"}${servers ? `; allowed anyway: ${servers}` : ""} (${cmd} lists and changes this; --gate-on turns it back on). The background runner still only sends text approved on the board.`;
  }
  if (servers) return `Outbound gate: off in live sessions for: ${servers} (${cmd} lists and changes this). Other send tools wait for text approved on the board; the background runner always does.`;
  return null;
}

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

/* ---- an agent's folder beside a repo: add-agent.mjs (every extra agent of a codebase), and connect.mjs when the
 * board approved isn't the repo's code (one agent per git root: the repo stays free for its own Builder). */

/**
 * The roles and the folder each gets. A copy of the app's list (src/lib/agents/roles.ts: keys, labels and `code`);
 * when a role is added or renamed there, change it here too. The board decides what a role may do; this only names
 * the folder (`word`) and picks its shape (`code` "edit": a worktree of its own, from add-agent).
 */
export const ROLES = {
  builder: { label: "Builder", word: "builder", code: "edit" },
  reviewer: { label: "Reviewer / QA", word: "reviewer", code: "read" },
  writer: { label: "Writer", word: "writer", code: "read" },
  marketer: { label: "Marketer / Growth", word: "marketing", code: "read" },
  support: { label: "Support / Community", word: "support", code: "read" },
  researcher: { label: "Researcher / Analyst", word: "research", code: "read" },
  operator: { label: "Operator", word: "ops", code: "read" },
  designer: { label: "Designer", word: "design", code: "read" },
  coordinator: { label: "Coordinator", word: "coordinator", code: "none" },
  assistant: { label: "Assistant", word: "assistant", code: "none" },
  custom: { label: "General", word: "agent", code: "edit" },
};

/** A folder name from a role word or a board slug: lowercase, dashes, at most 40 characters. */
export const folderSlug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "agent";

/** The folder that holds a repo's extra agents: `<repo-parent>/<repo>-agents`. */
export const agentsHome = (repo) => join(dirname(repo), `${basename(repo)}-agents`);

/** A free folder for a new agent beside `repo`: `<repo>-agents/<want>`, or `<want>-2`, `-3`... when taken. Not made. */
export function freeAgentFolder(repo, want) {
  const home = agentsHome(repo);
  const name = folderSlug(want);
  let dir = join(home, name);
  for (let i = 2; existsSync(dir); i++) dir = join(home, `${name}-${i}`);
  return dir;
}

/** Write a folder's board link (.agentorb.json: project, workspace, url) unless it has one already. Returns whether it wrote. */
export function writeLink(dir, link) {
  const file = join(dir, ".agentorb.json");
  if (existsSync(file)) return false;
  writeFileSync(file, JSON.stringify({ project: link.project, ...(link.workspace ? { workspace: link.workspace } : {}), ...(link.url ? { url: link.url } : {}), ...(link.engine ? { engine: link.engine } : {}) }, null, 2) + "\n");
  return true;
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

/**
 * Did this session's AgentOrb MCP connection fail (the last thing Claude Code logged for it, for this session id, is a
 * failed connect)? Read from Claude Code's per-project MCP logs (~/.cache/claude-cli-nodejs on Linux and WSL,
 * ~/Library/Caches/claude-cli-nodejs on macOS). Unknown (no log, another layout) is false: the hook then behaves as before.
 */
export function mcpDown(sessionId, dir = startDir()) {
  if (!sessionId) return false;
  try {
    const want = resolve(dir).replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
    for (const base of [join(homedir(), ".cache", "claude-cli-nodejs"), join(homedir(), "Library", "Caches", "claude-cli-nodejs")]) {
      if (!existsSync(base)) continue;
      for (const proj of readdirSync(base).filter((n) => n.toLowerCase() === want)) {
        const logs = join(base, proj, "mcp-logs-plugin-agentorb-agentorb");
        if (!existsSync(logs)) continue;
        const files = readdirSync(logs).filter((f) => f.endsWith(".jsonl") || f.endsWith(".txt")).sort().slice(-40).reverse();
        for (const f of files) {
          const lines = readFileSync(join(logs, f), "utf8").trim().split("\n").reverse();
          for (const line of lines) {
            let j;
            try {
              j = JSON.parse(line);
            } catch {
              continue;
            }
            if (j.sessionId !== sessionId) continue;
            const text = String(j.debug ?? j.error ?? "");
            if (/Successfully connected/i.test(text)) return false;
            if (j.error && /401|rejected|failed|Connection failed/i.test(text)) return true;
          }
        }
      }
    }
  } catch {
    /* unknown */
  }
  return false;
}

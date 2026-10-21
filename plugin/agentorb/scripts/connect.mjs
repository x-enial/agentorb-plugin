#!/usr/bin/env node
/*
 * Connect this folder to its AgentOrb board in one click (0055; run by /agentorb:init, or by hand). It asks the board
 * for a code and a link, opens the link, and waits while the person approves (which agent, which board; when the
 * repo was acting as another agent, moving that agent's open work here). Then it writes the agent's key into the
 * folder's git-ignored .agentorb.local.json (0600) and the board into .agentorb.json. It never prints the key.
 *
 * Where the agent lives is decided once the approval says which board (one agent per git root):
 *   - not inside a git repo (a docs folder, notes, an empty folder): here;
 *   - inside a git repo whose board is its code (kind codebase, or a board too old to say): the repo, at its git root;
 *   - inside a git repo whose board is something else (a campaign, ops, agents...): a folder beside the repo, the one
 *     add-agent makes (<repo>-agents/<role>), set up like an agent outside the code: the repo's docs imported
 *     read-only, its secrets denied. Nothing is written at the repo's root, and a key already there is left alone, so
 *     the repo stays free for its own Builder. --code <repo> (add-agent chose this folder) keeps the folder as it is.
 *
 * Exit codes: 0 connected, 2 turned down (or not used), 3 expired, 4 approved from another network: run again with
 * --accept to use it (only if the person here says it was them), 1 anything else.
 */
import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { freeAgentFolder, ROLES, serverUrl, session, startDir, strayServers, worktreeOf, writeLink } from "./config.mjs";
import { setUpForRole } from "./role-setup.mjs";

const codeArg = () => {
  const i = process.argv.indexOf("--code");
  return i > 0 ? process.argv[i + 1] : undefined;
};

const me = session();
const site = serverUrl(me.link).replace(/\/api\/mcp(?:\/plugin)?$/, "");
const say = (s) => process.stdout.write(s + "\n");
// Run from inside the repo (a package in a monorepo): the files still go at the git root (one agent per git root
// today), so the board hears which subfolder this came from and doesn't treat the root's agent as the one being
// replaced (the connect page used to pre-tick Retire for it).
const subfolder = (() => {
  const rel = relative(me.root, startDir());
  return rel && !rel.startsWith("..") ? rel.replaceAll("\\", "/") : undefined;
})();

const remote = (() => {
  try {
    return execFileSync("git", ["-C", me.root, "remote", "get-url", "origin"], { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
})();

async function post(path, body, key) {
  const res = await fetch(`${site}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

function open(url) {
  // Best effort: WSL, macOS, Linux desktops. The link is printed either way.
  const tries = process.platform === "darwin" ? [["open", [url]]] : [["wslview", [url]], ["cmd.exe", ["/c", "start", "", url.replace(/&/g, "^&")]], ["xdg-open", [url]]];
  const next = (i) => {
    if (i >= tries.length) return;
    execFile(tries[i][0], tries[i][1], { stdio: "ignore", timeout: 3000 }, (err) => err && next(i + 1));
  };
  next(0);
}

function pendingFile() {
  return join(homedir(), ".claude", "agentorb", "pending", `${createHash("sha256").update(me.root).digest("hex").slice(0, 16)}.json`);
}
function savePending(secret) {
  const f = pendingFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ secret, until: Date.now() + 15 * 60_000 }), { mode: 0o600 });
}

// --accept: use the request approved from another network that a headless run left waiting (15 minutes).
let start;
let answer;
if (process.argv.includes("--accept")) {
  let p = null;
  try {
    p = JSON.parse(readFileSync(pendingFile(), "utf8"));
  } catch {
    /* none */
  }
  rmSync(pendingFile(), { force: true });
  if (!p || p.until < Date.now()) {
    say("AgentOrb: nothing is waiting to be accepted here (or it expired). Run this again for a new link.");
    process.exit(3);
  }
  start = { secret: p.secret };
  answer = await post("/api/connect/poll", { secret: p.secret, accept: true }).catch(() => ({ status: "expired" }));
} else {
  try {
    start = await post("/api/connect/start", { repo: remote, folder: basename(me.root), subfolder, host: hostname(), project: me.link?.project, vendor: process.env.AGENTORB_VENDOR || "claude-code", keySource: me.keySource ?? undefined, suggestedRole: process.env.AGENTORB_SUGGEST_ROLE || undefined, suggestedName: process.env.AGENTORB_SUGGEST_NAME || undefined }, me.key);
  } catch (e) {
    say(`AgentOrb: couldn't start connecting (${e.message}).`);
    process.exit(1);
  }
  say(`Open this link to connect ${basename(me.root)} to AgentOrb, and check the code says ${start.code}:`);
  say(`  ${start.url}`);
  say("Only approve it yourself, from this computer. If anyone else asks you to open a link like this, don't.");
  open(start.url);

  const until = Date.now() + Math.min(start.expiresIn ?? 900, 900) * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, (start.interval ?? 3) * 1000));
    try {
      answer = await post("/api/connect/poll", { secret: start.secret });
    } catch {
      continue; // a blip: keep waiting
    }
    if (answer.status !== "pending") break;
    if (Date.now() > until) {
      answer = { status: "expired" };
      break;
    }
  }
}
// Approved from another network than this computer: maybe someone else got the link. Say who and where; use it only
// when the person here says so (a terminal asks; run headless, --accept within 15 minutes).
if (answer.status === "confirm") {
  say(`AgentOrb: this link was approved from another network, by ${answer.by}, into ${answer.workspace}${answer.project ? ` / ${answer.project}` : ""} as ${answer.agent}.`);
  say("If that wasn't you, someone else has this link: don't use it, and run this again for a new one.");
  let yes = false;
  if (process.stdin.isTTY) {
    const rl = (await import("node:readline")).createInterface({ input: process.stdin, output: process.stdout });
    yes = /^y(es)?$/i.test((await new Promise((r) => rl.question("Use it? [y/N] ", r))).trim());
    rl.close();
  } else {
    savePending(start.secret);
    say("To use it, run this again with --accept within 15 minutes.");
    process.exit(4);
  }
  if (!yes) {
    say("AgentOrb: not used. Nothing was written.");
    process.exit(2);
  }
  answer = await post("/api/connect/poll", { secret: start.secret, accept: true });
}
if (answer.status === "denied") {
  say("AgentOrb: turned down in the browser. Nothing was written.");
  process.exit(2);
}
if (answer.status !== "approved") {
  say(`AgentOrb: the request ${answer.status === "claimed" ? "was already used" : "expired"}. Run it again for a new link.`);
  process.exit(3);
}

// Where the agent lives (see the header). The board's kind arrives with the approval, so this is decided here, before
// anything is written. Inside a git repo whose board isn't its code, the agent's folder goes beside the main checkout
// (a worktree's agents' folder sits beside the main one too), named for its role, or the board when the role is the
// general one; a taken name gets -2, -3... as add-agent does.
const gitRoot = (() => {
  try {
    return execFileSync("git", ["-C", me.root, "rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim() || null;
  } catch {
    return null;
  }
})();
const kind = typeof answer.project?.kind === "string" ? answer.project.kind : null;
const beside = !!gitRoot && !codeArg() && !!kind && kind !== "codebase";
let home = me.root;
let repo = null;
if (beside) {
  repo = gitRoot;
  const wt = worktreeOf(repo);
  if (wt.linked && wt.main) repo = wt.main;
  const roleKey = answer.role?.key;
  const word = roleKey && roleKey !== "custom" ? ROLES[roleKey]?.word : null;
  home = freeAgentFolder(repo, word || answer.project.slug);
  mkdirSync(home, { recursive: true });
}
const engine = (process.env.AGENTORB_VENDOR || "").toLowerCase() === "codex" ? "codex" : null;

// The key: the folder's own git-ignored file, readable only by you; with the agent's role (0057) for session start, the
// record of the permission rules the last setup wrote (`settings`), carried over so role-setup can take them out, and
// the send servers the person allowed for live sessions (`sendAllowed`, 0096), carried over so they stay theirs.
const localFile = join(home, ".agentorb.local.json");
const priorRules = (() => {
  try {
    const j = JSON.parse(readFileSync(localFile, "utf8"));
    return { ...(j?.settings && typeof j.settings === "object" ? { settings: j.settings } : {}), ...(Array.isArray(j?.sendAllowed) && j.sendAllowed.length ? { sendAllowed: j.sendAllowed } : {}) };
  } catch {
    return {};
  }
})();
writeFileSync(localFile, JSON.stringify({ key: answer.key, ...(answer.role ? { role: answer.role.key } : {}), ...(answer.page ? { page: answer.page.slug } : {}), ...priorRules }, null, 2) + "\n", { mode: 0o600 });
chmodSync(localFile, 0o600);
const ignore = join(home, ".gitignore");
const ignored = existsSync(ignore) && readFileSync(ignore, "utf8").split(/\r?\n/).some((l) => l.trim() === ".agentorb.local.json");
if (!ignored) appendFileSync(ignore, `${existsSync(ignore) && !readFileSync(ignore, "utf8").endsWith("\n") ? "\n" : ""}.agentorb.local.json\n`);
// The board link (committed, so every worktree and teammate shares it). With --engine codex (cli.mjs, add-agent.mjs:
// AGENTORB_VENDOR=codex) the link also says the folder's runs use Codex.
const linkFile = join(home, ".agentorb.json");
if (answer.project) {
  const link = { project: answer.project.slug, workspace: answer.workspace.slug, url: site, ...(engine ? { engine } : {}) };
  let had = null;
  try {
    had = JSON.parse(readFileSync(linkFile, "utf8"));
  } catch {
    /* none, or not JSON: written fresh */
  }
  if (!had || typeof had !== "object" || had.project !== link.project) {
    rmSync(linkFile, { force: true });
    writeLink(home, link);
  } else if (engine && had.engine !== engine) writeFileSync(linkFile, JSON.stringify({ ...had, engine }, null, 2) + "\n");
}

// The role's setup: inside the code, its limits; beside it, the context pack (the repo's docs read-only) and the limits.
const pack = answer.role ? setUpForRole(home, answer.role, answer.project?.slug, codeArg() ?? (beside ? repo : undefined)) : null;

if (beside) say(`This board isn't this repo's code, so the agent lives beside it: ${home}. Start Claude Code there; this repo stays free for its own Builder.`);
say(`Connected: ${basename(home)} is now "${answer.agent.name}" on ${answer.project ? `the ${answer.project.name} board` : "your board"} (${answer.workspace.name}).`);
say(`The key is in ${beside ? `${home}${process.platform === "win32" ? "\\" : "/"}` : ""}.agentorb.local.json (git-ignored, readable only by you); .agentorb.json${beside ? " there" : ""} names the board.`);
if (engine) say("This folder's runs use Codex.");
if (subfolder && !beside) say(`Both files are at the repo's root, not in ${subfolder}: one agent per git root is the rule today, so this agent is the whole repo's. For an agent of its own for one part, use add-agent (a folder beside the repo).`);
if (answer.role) say(`Role: ${answer.role.label}.${answer.page ? ` Its ${answer.page.title} page on the board is printed into every session.` : ""}`);
if (pack?.note) say(pack.note);
if (pack?.summary) say(pack.summary);
if (answer.replaced) {
  const r = answer.replaced;
  say(`${r.name}'s ${r.cards} open card${r.cards === 1 ? "" : "s"} on its areas and ${r.routines} routine${r.routines === 1 ? "" : "s"} moved to it; messages to ${r.name} reach it too.${r.rerouted ? ` ${r.rerouted} card${r.rerouted === 1 ? "" : "s"} outside its role went to the agents whose roles cover them.` : ""}${r.unassigned ? ` ${r.unassigned} card${r.unassigned === 1 ? "" : "s"} outside its role ${r.unassigned === 1 ? "is" : "are"} unassigned (no agent's role covers ${r.unassigned === 1 ? "its area" : "their areas"}): assign ${r.unassigned === 1 ? "it" : "them"} on the board.` : ""}${r.retired ? ` ${r.name} is retired.` : ""}`);
  // The agent beside the repo never replaces the repo's own: a Retire ticked on the page took the root's agent away.
  if (r.retired && beside && me.keySource === "repo") say(`${r.name} was this repo's own agent (its key is at the repo's root, untouched). If the repo still needs it, restore it from Settings → Agents within 30 days, or run /agentorb:init in the repo again for a new one.`);
  // A retired key left in the shell would only fail now: point at the lines, so they can come out.
  if (r.retired && me.keySource === "env") {
    const spots = [join(homedir(), ".bashrc"), join(homedir(), ".zshrc"), join(homedir(), ".profile"), join(homedir(), ".config", "agentorb", "env")].flatMap((f) => {
      try {
        return readFileSync(f, "utf8").split(/\r?\n/).map((l, i) => (/AGENTORB_KEY\s*=/.test(l) ? `${f}:${i + 1}` : null)).filter(Boolean);
      } catch {
        return [];
      }
    });
    if (spots.length) say(`Your shell still sets AGENTORB_KEY to ${r.name}'s retired key (${spots.join(", ")}). Those lines can come out.`);
  }
}
for (const x of strayServers(home)) say(`This folder also has an AgentOrb MCP server set up by hand ("${x.name}", ${x.scope} scope) with an older key: it would still act as that agent. Remove it with: ${x.remove}`);
if (beside) {
  say(`Open it: cd "${resolve(home)}" && ${engine === "codex" ? "codex" : "claude"}`);
  say(engine === "codex" ? "Keep it working while you're away: npx -y github:x-enial/agentorb-plugin runner on (in that folder)." : "Keep it working while you're away: /agentorb:runner on, in a session there.");
} else say("Restart Claude Code in this folder (or /mcp, then reconnect agentorb) so the connection uses the new agent.");


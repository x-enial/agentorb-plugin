#!/usr/bin/env node
/*
 * Add another agent to this codebase (0084), run from the main repo by /agentorb:add-agent or `agentorb add-agent`.
 * Every extra agent of a project lives next to the repo, in one folder named after it:
 *
 *   code/MyApp/                    the main repo (its Builder)
 *   code/MyApp-agents/marketing/   a plain folder: reads the code read-only, writes its own notes and drafts
 *   code/MyApp-agents/reviewer/    a git worktree on its own branch, for a role that edits code
 *
 * Next to the repo, not inside it: inside, Claude Code would load the Builder's CLAUDE.md and see the folder as part
 * of the repo. It makes the folder, links it to the repo's board, then runs the usual approval (connect.mjs, with the
 * role and name filled in and the code folder passed on), which sets the folder up for its role. Never prints a key.
 *
 *   node add-agent.mjs --role marketer [--name "MyApp Marketing"] [--folder marketing] [--engine claude|codex] [--worktree|--plain]
 *
 * Exit codes: connect.mjs's (0 connected, 2 turned down, 3 expired, 4 approved from another network), 1 anything else.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freeAgentFolder, ROLES, worktreeOf, writeLink } from "./config.mjs";

const say = (s = "") => process.stdout.write(s + "\n");
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// The roles (keys, labels, folder words, whether they edit code) are ROLES in config.mjs, shared with connect.mjs.
const roleKey = (opt("role") || "").toLowerCase();
const role = ROLES[roleKey];
if (!role) {
  say(`Say which role: --role ${Object.keys(ROLES).join(" | ")}`);
  process.exit(1);
}
const engine = (opt("engine") || "claude").toLowerCase();
if (!["claude", "codex"].includes(engine)) {
  say("--engine is claude or codex.");
  process.exit(1);
}

const git = (dir, a) => execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).toString().trim();
let repo;
try {
  repo = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
} catch {
  say("AgentOrb: run this in the project's main repo (a git checkout), where its first agent works.");
  process.exit(1);
}
// From a worktree, the agents' folder still sits beside the main checkout.
const wt = worktreeOf(repo);
if (wt.linked && wt.main) repo = wt.main;
const link = (() => {
  try {
    return JSON.parse(readFileSync(join(repo, ".agentorb.json"), "utf8"));
  } catch {
    return null;
  }
})();
if (!link?.project) {
  say("AgentOrb: this repo isn't linked to a board yet. Connect its own agent first (/agentorb:init, or `agentorb connect`), then add more.");
  process.exit(1);
}

const dir = freeAgentFolder(repo, opt("folder") || role.word);
const worktree = args.includes("--worktree") || (!args.includes("--plain") && role.code === "edit");

mkdirSync(dirname(dir), { recursive: true });
if (worktree) {
  const branch = `agent/${basename(dir)}`;
  try {
    git(repo, ["worktree", "add", "-b", branch, dir]);
  } catch (e) {
    say(`AgentOrb: couldn't make a worktree at ${dir} (${String(e.stderr || e.message).trim().split("\n").pop()}).`);
    process.exit(1);
  }
  say(`Made ${dir}: a worktree of ${basename(repo)} on branch ${branch}, so this agent has its own checkout.`);
} else {
  mkdirSync(dir, { recursive: true });
  say(`Made ${dir}: this agent's own folder. It reads ${basename(repo)} read-only, beside it.`);
}
// The board link (a worktree may already have it from the repo; a plain folder gets a copy).
writeLink(dir, link);

const name = opt("name") || `${link.project.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} ${role.label.split(" /")[0]}`;
say("");
// connect.mjs finds its folder from CLAUDE_PROJECT_DIR, then PWD (config.mjs startDir), both of which still name the
// repo here: a cwd alone would leave the key at the repo's root. Both say the new folder.
const r = spawnSync(process.execPath, [join(here, "connect.mjs"), "--code", repo], {
  cwd: dir,
  stdio: "inherit",
  env: { ...process.env, CLAUDE_PROJECT_DIR: dir, PWD: dir, AGENTORB_SUGGEST_ROLE: roleKey, AGENTORB_SUGGEST_NAME: name.slice(0, 80), ...(engine === "codex" ? { AGENTORB_VENDOR: "codex" } : {}), AGENTORB_KEY: "" },
});
const code = r.status ?? 1;
if (code !== 0) {
  if (code === 4) say(`To use it (only if that was you): cd "${dir}" and run connect again with --accept.`);
  else say(`The folder is there (${dir}); run connect in it again when you're ready.`);
  process.exit(code);
}
// With --engine codex, connect.mjs (AGENTORB_VENDOR=codex) marks the folder's link `engine: "codex"` itself.
say("");
say(`Open it: cd "${resolve(dir)}" && ${engine === "codex" ? "codex" : "claude"}`);
say(engine === "codex" ? "Keep it working while you're away: npx -y github:x-enial/agentorb-plugin runner on (in that folder)." : "Keep it working while you're away: /agentorb:runner on, in a session there.");

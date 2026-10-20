/*
 * Setting a folder up for its agent's role (0057), from /agentorb:init (connect.mjs) and again at session start when
 * a person changed the role in Settings. For an agent outside the code folder: AGENTORB.md (imported by CLAUDE.md)
 * loads the role's context files from the code folder every session, small ones in full and big ones listed; and
 * .claude/settings.json gives it the code read-only with its git history (or not at all), never its secrets, and send
 * tools only if its role sends. Inside the code folder: only the role's limits, in .claude/settings.local.json.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";


function isGitRepo(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim() || null;
  } catch {
    return null;
  }
}

/** The project's code folder: this one when it is the repo; else --code <path>; else a sibling linked to the same board. */
function codeRootFor(root, project, codeArg) {
  const here = isGitRepo(root);
  if (here) return { root: here, inside: true };
  if (codeArg) {
    const r = isGitRepo(resolve(codeArg));
    if (r) return { root: r, inside: false };
  }
  const parent = dirname(root);
  for (const d of readdirSync(parent, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(parent, d.name);
    if (dir === root) continue;
    try {
      const link = JSON.parse(readFileSync(join(dir, ".agentorb.json"), "utf8"));
      if (link.project === project && isGitRepo(dir)) return { root: isGitRepo(dir), inside: false };
    } catch {
      /* not linked */
    }
  }
  return null;
}

/** The files a role loads: each glob's matches under the code folder, small ones imported, big ones listed. */
function contextFiles(root, globs) {
  const seen = new Set();
  const out = [];
  for (const g of globs) {
    const dir = dirname(g) === "." ? "" : dirname(g);
    const pat = new RegExp("^" + basename(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
    let names = [];
    try {
      names = readdirSync(join(root, dir)).filter((n) => pat.test(n)).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      const file = join(root, dir, n);
      if (seen.has(file)) continue;
      try {
        if (!statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      seen.add(file);
      out.push({ file, size: statSync(file).size });
    }
  }
  return out;
}

const SEND_TOOLS = ["mcp__*__send_message", "mcp__*__send_email", "mcp__*__reply", "mcp__*__forward", "mcp__*__post_message", "mcp__*__create_post", "mcp__*__publish"];

function mergeSettings(file, add) {
  let cur = {};
  try {
    cur = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* new */
  }
  const p = (cur.permissions ??= {});
  const uniq = (a, b) => [...new Set([...(a ?? []), ...b])];
  if (add.additionalDirectories?.length) p.additionalDirectories = uniq(p.additionalDirectories, add.additionalDirectories);
  if (add.allow?.length) p.allow = uniq(p.allow, add.allow);
  if (add.deny?.length) p.deny = uniq(p.deny, add.deny);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cur, null, 2) + "\n");
}

export function setUpForRole(root, role, project, codeArg) {
  const me = { root };
  const code = project ? codeRootFor(root, project, codeArg) : null;
  const deny = role.send ? [] : SEND_TOOLS;
  if (code?.inside) {
    // Working in the code itself: only the role's limits, in the git-ignored local settings.
    if (deny.length) mergeSettings(join(me.root, ".claude", "settings.local.json"), { deny });
    return { note: role.send ? null : "Its send and post tools are off in this folder (its role doesn't send)." };
  }
  if (!code) return { note: `I couldn't find this board's code folder next to this one. If it has one, run this again with --code /path/to/it, so the agent loads the project's context.` };
  const R = code.root;
  // The context pack: small files imported (Claude Code loads them every session), big ones listed to read when needed.
  const files = role.code === "none" ? contextFiles(R, ["CLAUDE.md", "README.md"]) : contextFiles(R, role.context);
  let budget = 150_000;
  const load = [];
  const list = [];
  for (const f of files) {
    if (f.size <= 40_000 && f.size <= budget) {
      load.push(f);
      budget -= f.size;
    } else list.push(f);
  }
  const md = [
    `# ${role.label} context (written by /agentorb:init)`,
    "",
    `This agent's role is **${role.label}**${role.blurb ? `: ${role.blurb}` : "."} The project's code is at \`${R}\`${role.code === "read" ? ", read-only for this agent" : role.code === "none" ? "; this agent doesn't work in it" : ""}. Everything below is loaded into every session; use it before writing anything about the project.`,
    "",
    `What the project is, where it stands and how this team works live on the board, not here: open every session with \`get_brief\` (project \`${project}\`), then \`get_page\` for its "How we work" page and \`my_work\`. Treat the board as the source of truth; when a fact isn't on it or in the files below, ask on the card rather than fill it in.`,
    role.grounding ? "\nEvery draft you submit cites where each part's facts come from (sources: the file, the commit, the card). The board refuses a part without one. When something isn't in these files or the repo history, ask on the card rather than guess." : "",
    "",
    "## Loaded every session",
    "",
    ...load.map((f) => `@${f.file}`),
    ...(list.length ? ["", "## Read when the work touches them (too long to load every time)", "", ...list.map((f) => `- \`${f.file}\` (${Math.round(f.size / 1024)} KB)`)] : []),
    ...(role.code !== "none" ? ["", `Recent history: \`git -C ${R} log --oneline -30\`, and \`git -C ${R} show <commit>\` for one change.`] : []),
    "",
  ].join("\n");
  writeFileSync(join(me.root, "AGENTORB.md"), md);
  // CLAUDE.md imports it (made if missing; the agent's own instructions stay as they are).
  const claude = join(me.root, "CLAUDE.md");
  const had = existsSync(claude) ? readFileSync(claude, "utf8") : "";
  if (!/^@AGENTORB\.md\s*$/m.test(had)) writeFileSync(claude, `@AGENTORB.md\n\n${had}`);
  // Its limits: the code read-only with its history (none for roles that don't use it), no secrets, sends as its role allows.
  const secrets = ["signing.local.json", ".agentorb.local.json", "**/.env*", "**/*.pem", "**/*.key"].map((x) => `Read(/${R}/${x})`);
  mergeSettings(join(me.root, ".claude", "settings.json"), {
    additionalDirectories: role.code === "none" ? [] : [R],
    allow: role.code === "none" ? [] : [`Bash(git -C ${R} log:*)`, `Bash(git -C ${R} show:*)`],
    deny: [`Edit(/${R}/**)`, `Write(/${R}/**)`, "Bash(git push:*)", ...(role.code === "none" ? [`Read(/${R}/**)`] : secrets), ...deny],
  });
  return { note: `Context: ${load.length} file${load.length === 1 ? "" : "s"} from ${basename(R)} load every session (AGENTORB.md, imported by CLAUDE.md)${list.length ? `, ${list.length} more listed to read when needed` : ""}. ${role.code === "none" ? "It doesn't work in the code." : "The code is read-only for it, with its git history."}${role.send ? "" : " Send and post tools are off."}` };
}

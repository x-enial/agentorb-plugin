/*
 * Setting a folder up for its agent's role (0057), from /agentorb:init (connect.mjs) and again at session start when
 * a person changed the role in Settings. For an agent outside the code folder: AGENTORB.md (imported by CLAUDE.md)
 * loads the role's context files from the code folder every session, small ones in full and big ones listed; and
 * .claude/settings.json gives it the code read-only with its git history (or not at all), never its secrets, and send
 * tools only if its role sends. Inside the code folder: no permission rules at all (they would bind the person's own
 * sessions too); the outbound gate and the runner's own --allowedTools/--disallowedTools hold the unattended runs.
 *
 * Every rule this writes is tagged: the list (allow, deny, additionalDirectories, per settings file) is kept in the
 * git-ignored .agentorb.local.json under `settings`. A role change removes exactly those rules first, so the person's
 * own rules stay as they were; a rule they already took out is fine. A tool the person explicitly allowed in the
 * folder's settings (deny wins over allow in Claude Code, so a deny would silently override them) is not denied, and
 * the summary says so. What was written is said once, in plain words, with the file to open to change it.
 *
 * Rule shapes, from Claude Code's permissions reference: a deny rule's tool name is a glob matched against the whole
 * name, so mcp__*__send_message covers that tool on every server (allow globs need a literal server, deny globs don't);
 * `//path` is an absolute path (`/path` is relative to the settings file); Write(path) rules are never consulted (Edit
 * covers edits and new files; a Read deny blocks writes there too).
 *
 * The person's own send tools (0096): inside the code folder, a repo that has its own Slack, Gmail, Discord... MCP
 * server (.mcp.json, or a settings file that enables or allows one) gets no send/post deny rules at all: those tools
 * are the person's, for when they ask in a live session. Their servers are recorded in .agentorb.local.json under
 * `sendAllowed`, so the outbound gate (pre-tool.mjs) agrees; the background runner still only sends approved text.
 * An agent folder beside the repo keeps the deny rules as before.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { OUTBOUND_RE, sendAllowedIn, serverOfTool, writeSendAllowed } from "./config.mjs";


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

/* ---- the rules */

// Tools that send, post or publish, on any server: a deny glob is matched against the whole tool name (see the header).
// The outbound gate (pre-tool.mjs) still stands for roles that send; this takes the tools away from roles that don't.
export const SEND_TOOLS = ["mcp__*__send_message", "mcp__*__send_email", "mcp__*__reply", "mcp__*__forward", "mcp__*__post_message", "mcp__*__create_post", "mcp__*__publish"];
const SECRET_FILES = ["signing.local.json", ".agentorb.local.json", "**/.env*", "**/*.pem", "**/*.key"];
const KINDS = ["allow", "deny", "additionalDirectories"];

/** A folder as a Read/Edit rule path: `//abs/path` on POSIX, `//c/Users/...` for a Windows drive (both absolute to Claude Code). */
function rulePath(dir) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(dir);
  const posix = m ? `/${m[1].toLowerCase()}/${m[2].replaceAll("\\", "/")}` : dir.replaceAll("\\", "/");
  return `/${posix}`.replace(/\/+$/, "");
}

/** The rules for an agent outside the code folder R (settings.json), by what its role may touch. */
function outsideRules(R, role) {
  const P = rulePath(R);
  const none = role.code === "none";
  return {
    additionalDirectories: none ? [] : [R],
    allow: none ? [] : [`Bash(git -C ${R} log:*)`, `Bash(git -C ${R} show:*)`],
    deny: [`Edit(${P}/**)`, "Bash(git push:*)", ...(none ? [`Read(${P}/**)`] : SECRET_FILES.map((x) => `Read(${P}/${x})`)), ...(role.send ? [] : SEND_TOOLS)],
  };
}

/**
 * Before the rules were tagged (plugin versions up to this one), nothing recorded what the plugin wrote. With no record
 * yet, every shape the plugin could have written for this folder counts as its own, once; from then on the record rules.
 */
function legacyRules(R, inside) {
  if (inside) return { deny: SEND_TOOLS };
  if (!R) return {};
  const P = rulePath(R);
  const old = `/${R}`; // the shape before rulePath (the same string on POSIX)
  const paths = [...new Set([P, old])];
  return {
    additionalDirectories: [R],
    allow: [`Bash(git -C ${R} log:*)`, `Bash(git -C ${R} show:*)`],
    deny: [...paths.flatMap((p) => [`Edit(${p}/**)`, `Write(${p}/**)`, `Read(${p}/**)`, ...SECRET_FILES.map((x) => `Read(${p}/${x})`)]), "Bash(git push:*)", ...SEND_TOOLS],
  };
}

/** The record of what the plugin wrote, from the local file's `settings` key (nothing else in the file is read out). */
function readRecord(localFile) {
  try {
    const j = JSON.parse(readFileSync(localFile, "utf8"));
    return j && typeof j.settings === "object" && j.settings && !Array.isArray(j.settings) ? j.settings : null;
  } catch {
    return null;
  }
}

/** Keep the record in the local file (only when the file exists: connect.mjs makes it, with the key, first). Never printed. */
function writeRecord(localFile, settings) {
  if (!existsSync(localFile)) return;
  let j = {};
  try {
    j = JSON.parse(readFileSync(localFile, "utf8")) || {};
  } catch {
    return;
  }
  j.settings = settings; // an empty one still says "recorded": the pre-record sweep runs only once
  writeFileSync(localFile, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(localFile, 0o600);
  } catch {
    /* best effort */
  }
}

/**
 * One settings file: take out `remove` (the rules the plugin wrote last time; ones already gone are fine), put in `add`
 * (once each), leave everything else as it was. Writes only when something changed; makes no file for nothing.
 * Returns { removed, added }: how many rules actually came out and went in.
 */
export function mergeSettings(file, add = {}, remove = {}) {
  let cur = null;
  try {
    cur = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* new, or not JSON */
  }
  const had = cur !== null;
  if (!cur || typeof cur !== "object" || Array.isArray(cur)) cur = {};
  const before = JSON.stringify(cur);
  const p = cur.permissions && typeof cur.permissions === "object" ? cur.permissions : (cur.permissions = {});
  let removed = 0;
  let added = 0;
  for (const k of KINDS) {
    const gone = new Set(remove[k] ?? []);
    const was = Array.isArray(p[k]) ? p[k] : [];
    const list = was.filter((r) => !gone.has(r));
    removed += was.length - list.length;
    for (const r of add[k] ?? []) {
      if (list.includes(r)) continue;
      list.push(r);
      added++;
    }
    if (list.length) p[k] = list;
    else delete p[k];
  }
  if (!Object.keys(p).length) delete cur.permissions;
  if (JSON.stringify(cur) === before) return { removed: 0, added: 0 };
  if (!had && !Object.keys(cur).length) return { removed: 0, added: 0 };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cur, null, 2) + "\n");
  return { removed, added };
}

const globRe = (p) => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");

// An MCP server whose name says it sends: a chat, mail or social service (x only as a whole word: mcp__x__post, "x-api").
const SENDING_NAME = /slack|gmail|discord|mail|twitter|linkedin|telegram|whatsapp|sendgrid|resend|postmark/i;
const sendingName = (name) => SENDING_NAME.test(name) || String(name).toLowerCase().split(/[^a-z0-9]+/).includes("x");

/**
 * The repo's own sending servers (0096): MCP servers configured in the folder's .mcp.json or enabled in its
 * .claude/settings.json / settings.local.json whose names say they send, plus the server of any send-shaped tool
 * (mcp__<server>__send_message...) the person explicitly allowed there. Names only; nothing else in those files is read.
 */
export function ownSendingServers(dir) {
  const read = (f) => {
    try {
      return JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      return null;
    }
  };
  const out = [];
  const add = (s) => {
    if (typeof s === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(s) && !out.includes(s)) out.push(s);
  };
  for (const name of Object.keys(read(".mcp.json")?.mcpServers ?? {})) if (sendingName(name)) add(name);
  for (const f of [".claude/settings.json", ".claude/settings.local.json"]) {
    const j = read(f);
    for (const name of Array.isArray(j?.enabledMcpjsonServers) ? j.enabledMcpjsonServers : []) if (sendingName(name)) add(name);
    for (const a of Array.isArray(j?.permissions?.allow) ? j.permissions.allow : []) {
      if (typeof a !== "string" || !OUTBOUND_RE.test(a) || a.includes("*")) continue;
      add(serverOfTool(a)); // an explicit allow for a send-shaped tool: its server is theirs
    }
  }
  return out;
}

/**
 * The person's own explicit allows for tools our deny list names: a full tool name (mcp__<server>__<tool>, no glob) in
 * the folder's settings.json or settings.local.json that a deny pattern would match. Deny wins over allow in Claude
 * Code, so writing the deny would silently override their choice: that pattern is skipped and the summary names it.
 * A server-wide allow (mcp__<server>__*) doesn't count: it names no tool, and skipping the deny for it would take the
 * limit off every server.
 */
function keptAllows(dir, denies, ours) {
  const allows = new Set();
  for (const f of ["settings.json", "settings.local.json"]) {
    try {
      for (const a of JSON.parse(readFileSync(join(dir, ".claude", f), "utf8")).permissions?.allow ?? []) if (typeof a === "string") allows.add(a);
    } catch {
      /* none */
    }
  }
  for (const a of ours) allows.delete(a);
  const kept = [];
  const deny = [];
  for (const d of denies) {
    const re = globRe(d);
    const hits = [...allows].filter((a) => /^mcp__[^*()\s]+$/.test(a) && re.test(a));
    if (hits.length) kept.push(...hits);
    else deny.push(d);
  }
  return { deny, kept: [...new Set(kept)] };
}

/** The plain-words summary of what was written: which file, how many rules, what is off, where to change it. */
export function permissionsSummary(result, root) {
  const lines = [];
  const rel = (f) => relative(root, f) || f;
  for (const w of result?.settings ?? []) {
    const n = KINDS.reduce((s, k) => s + (w.rules[k]?.length ?? 0), 0);
    if (n) {
      const verb = w.added ? "wrote" : "keeps"; // run again with the same role: nothing changed, say so
      lines.push(`AgentOrb ${verb} ${n} permission rule${n === 1 ? "" : "s"} ${w.added ? "to" : "in"} ${rel(w.file)}: ${w.groups.join(" · ")}.${w.removed ? ` (${w.removed} from its last setup came out first.)` : ""}`);
      if (w.kept.length) lines.push(`Kept your allow for ${w.kept.join(", ")}: not denied here, so your own use of ${w.kept.length === 1 ? "it" : "them"} still works.`);
      lines.push(`To change them, open ${w.file}; AgentOrb only ever removes or rewrites the rules it added (listed in .agentorb.local.json under "settings").`);
    } else if (w.removed) {
      lines.push(`AgentOrb took its ${w.removed} earlier permission rule${w.removed === 1 ? "" : "s"} out of ${rel(w.file)} (this setup doesn't need them); yours are untouched.`);
    }
  }
  return lines.join("\n");
}

/**
 * Set `root` up for `role`. `localFile` is the folder's .agentorb.local.json (the record of the rules written lives
 * there); session start passes the one it found. Returns { note, settings, summary }: settings is what was written per
 * file, summary the block to show the person.
 */
export function setUpForRole(root, role, project, codeArg, localFile = join(root, ".agentorb.local.json")) {
  const me = { root };
  const code = project ? codeRootFor(root, project, codeArg) : null;
  const record = readRecord(localFile);
  const plan = new Map(); // settings file → { rules, groups, kept }
  let note;
  let R = null;
  if (code?.inside) {
    // Working in the code itself: only the role's limits, in the git-ignored local settings.
    // The repo's own Slack/Gmail/... servers (0096): no send/post deny rules here at all (they would take the person's
    // own tools away), and their names go on the gate's live-session allowlist. The runner is still gated by the board.
    const yours = ownSendingServers(me.root);
    if (yours.length) {
      const had = sendAllowedIn(dirname(localFile));
      writeSendAllowed(dirname(localFile), [...had, ...yours.filter((s) => !had.some((h) => h.toLowerCase() === s.toLowerCase()))]);
      note = `Your ${yours.join(", ")} tools stay yours in live sessions; the runner still only sends approved text.`;
    } else if (!role.send) {
      // No deny rules in the person's own repo (0.38.4): settings there apply to their interactive sessions too, and
      // the outbound gate already holds every unattended run to approved text. Rules an older setup wrote here are
      // taken out below (the record).
      note = "Its unattended runs send only text you approved on the board.";
    } else note = null;
  } else if (!code) {
    note = `I couldn't find this board's code folder next to this one. If it has one, run this again with --code /path/to/it, so the agent loads the project's context.`;
  } else {
    R = code.root;
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
    const rules = outsideRules(R, role);
    const groups = [role.code === "none" ? "code: unreadable (its role doesn't use it)" : "code: read-only, with git history", ...(role.code === "none" ? [] : ["secrets: unreadable"]), "git push: off"];
    let kept = [];
    if (!role.send) {
      const k = keptAllows(me.root, SEND_TOOLS, rules.allow);
      rules.deny = rules.deny.filter((d) => !SEND_TOOLS.includes(d) || k.deny.includes(d));
      kept = k.kept;
      groups.push("send/post tools: off");
    }
    plan.set(join(me.root, ".claude", "settings.json"), { rules, groups, kept });
    note = `Context: ${load.length} file${load.length === 1 ? "" : "s"} from ${basename(R)} load every session (AGENTORB.md, imported by CLAUDE.md)${list.length ? `, ${list.length} more listed to read when needed` : ""}. ${role.code === "none" ? "It doesn't work in the code." : "The code is read-only for it, with its git history."}${role.send ? "" : " Send and post tools are off."}`;
  }

  // Out with the last setup's rules (the record; before records, every shape the plugin could have written here), in with this role's.
  const files = new Set([...plan.keys(), ...Object.keys(record ?? {})]);
  if (!record && code) files.add(join(me.root, ".claude", code.inside ? "settings.local.json" : "settings.json"));
  const settings = [];
  const next = {};
  for (const file of files) {
    const want = plan.get(file);
    const remove = record ? (record[file] ?? {}) : legacyRules(R, !!code?.inside);
    const { removed, added } = mergeSettings(file, want?.rules ?? {}, remove);
    if (want && KINDS.some((k) => want.rules[k]?.length)) {
      next[file] = Object.fromEntries(KINDS.filter((k) => want.rules[k]?.length).map((k) => [k, want.rules[k]]));
      settings.push({ file, rules: want.rules, groups: want.groups, kept: want.kept, removed, added });
    } else if (removed) settings.push({ file, rules: {}, groups: [], kept: [], removed, added: 0 });
  }
  writeRecord(localFile, next);
  const result = { note, settings };
  result.summary = permissionsSummary(result, me.root);
  return result;
}

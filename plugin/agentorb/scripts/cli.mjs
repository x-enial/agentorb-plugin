#!/usr/bin/env node
/*
 * The `agentorb` command (0083): AgentOrb's folder setup and background runner without Claude Code, for Codex (and any
 * engine run.mjs knows). From the plugin repo, nothing to install first:
 *
 *   npx -y github:x-enial/agentorb-plugin connect --engine codex   link this folder to its board (approve in the browser)
 *   npx -y github:x-enial/agentorb-plugin runner on                keep it working while you're away
 *   npx -y github:x-enial/agentorb-plugin runner status | off
 *   npx -y github:x-enial/agentorb-plugin run                      one run now
 *   npx -y github:x-enial/agentorb-plugin add-agent --role marketer --engine codex   another agent on this codebase
 *
 * The scripts are copied to ~/.agentorb/runner/<version>/ first, so the scheduled job points at a folder that stays
 * (npx's own copy can be cleaned away), and a newer version copied later is picked up by the runner by itself.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const say = (s = "") => process.stdout.write(s + "\n");
const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(here);
const version = (() => {
  try {
    return JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const homeRunner = join(homedir(), ".agentorb", "runner");
const claudeCache = join(homedir(), ".claude", "plugins", "cache", "agentorb", "agentorb");
const [cmd, ...args] = process.argv.slice(2);

/** The scripts to run: where they already stay (Claude Code's plugin cache, ~/.agentorb/runner), else a copy there. */
function stableScripts() {
  const root = resolve(pluginRoot);
  if (root.startsWith(resolve(claudeCache)) || root.startsWith(resolve(homeRunner))) return here;
  const dest = join(homeRunner, version);
  if (!existsSync(join(dest, "scripts", "runner.mjs"))) {
    mkdirSync(dest, { recursive: true });
    for (const d of ["scripts", "commands", ".claude-plugin"]) if (existsSync(join(pluginRoot, d))) cpSync(join(pluginRoot, d), join(dest, d), { recursive: true });
  }
  return join(dest, "scripts");
}

const node = (script, a = [], env = {}) => spawnSync(process.execPath, [join(stableScripts(), script), ...a], { stdio: "inherit", env: { ...process.env, ...env } }).status ?? 1;

/** Set the folder's engine in .agentorb.json (the board link connect wrote). */
function setEngine(engine) {
  const file = join(process.cwd(), ".agentorb.json");
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (engine === "claude") delete j.engine;
    else j.engine = engine;
    writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (cmd === "connect") {
  const engine = (opt("engine") || "claude").toLowerCase();
  if (!["claude", "codex"].includes(engine)) {
    say("--engine is claude or codex.");
    process.exit(1);
  }
  const code = node("connect.mjs", args.filter((a, i) => a !== "--engine" && args[i - 1] !== "--engine"), engine === "codex" ? { AGENTORB_VENDOR: "codex" } : {});
  if (code === 4) say("If that was you: npx -y github:x-enial/agentorb-plugin connect --accept");
  if (code !== 0) process.exit(code);
  // With --engine codex, connect.mjs marks the link itself (the agent's folder may be beside the repo, not here); for
  // Claude a stale codex marker in this folder's link is cleared.
  if (engine === "claude" && setEngine(engine)) say("This folder's runs use Claude Code.");
  if (engine === "codex") {
    say("");
    say("For your own Codex sessions in the agent's folder, connect Codex to AgentOrb once (pick the same agent under \"One you have\"):");
    say("  codex mcp add agentorb --url https://app.agent-orb.com/api/mcp");
    say("Then keep it working while you're away (in that folder):");
    say("  npx -y github:x-enial/agentorb-plugin runner on");
  }
  process.exit(0);
} else if (cmd === "add-agent") {
  // Another agent on this codebase, in <repo>-agents/<role>/ beside it (add-agent.mjs).
  process.exit(node("add-agent.mjs", args));
} else if (cmd === "engine") {
  const engine = (args[0] || "").toLowerCase();
  if (!["claude", "codex"].includes(engine)) say("agentorb engine claude|codex");
  else say(setEngine(engine) ? `This folder's runs use ${engine}.` : "This folder isn't linked yet: run connect first.");
} else if (cmd === "runner") {
  process.exit(node("runner-setup.mjs", args[0] === "on" ? ["install", ...args.slice(1)] : args[0] === "off" ? ["uninstall"] : ["status"]));
} else if (cmd === "run") {
  process.exit(spawnSync("bash", [join(stableScripts(), "agentorb-run.sh"), ...args], { stdio: "inherit" }).status ?? 1);
} else {
  say(`AgentOrb ${version}`);
  say("  connect [--engine claude|codex]   link this folder to its board (approve in your browser)");
  say("  add-agent --role <role> [--name \"…\"] [--engine codex]   another agent on this codebase, beside the repo");
  say("  engine claude|codex               which agent this folder's runs start");
  say("  runner on | off | status          the background runner for this folder");
  say("  run                               one run now");
  process.exit(cmd ? 1 : 0);
}

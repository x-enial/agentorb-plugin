#!/usr/bin/env bash
# AgentOrb scheduled run: one short headless Claude Code session that picks up the next thing on the board
# (/agentorb:work), from the repo the project tracks. Uses your Claude subscription; needs AGENTORB_KEY and the
# agentorb plugin installed for your user. Set it up yourself on a timer, for example:
#
#   */30 * * * * cd /path/to/repo && bash "$(ls -d ~/.claude/plugins/cache/agentorb/agentorb/* | sort -V | tail -1)/scripts/agentorb-run.sh" >> ~/agentorb-run.log 2>&1
#
# The key is the repo's own (.agentorb.local.json) or AGENTORB_KEY; never put it in the crontab line.
#
# Safety by default: one run at a time per repo (a lock), one task per run, a 20-minute cap, and a narrow tool
# allowlist: read, edit, local git (status, diff, log, add, commit, checkout, switch, stash: no push, so nothing
# leaves the machine without a person) and the repo's own test command (found from package.json and its lockfile,
# pytest, Cargo.toml or go.mod). Widen it on purpose with AGENTORB_RUN_TOOLS (the whole list, e.g. add
# "Bash(git push*)" yourself); anything that publishes, spends or releases stays a needs-you card for a person.
# Extra arguments are passed to `claude`.
set -euo pipefail

# The key: this repo's .agentorb.local.json, else AGENTORB_KEY (run.mjs checks and says so).
MAX="${AGENTORB_RUN_MAX:-1}"
MODE="${AGENTORB_RUN_MODE:-work}"   # work: a due routine, else the next task; think: follow up and propose ideas; routine: only a due routine
# The job's cadence in seconds, for the board's rings (LATE when missed). Set it to match your timer; think runs are uneven, so leave it unset for those.
export AGENTORB_RUN_EVERY="${AGENTORB_RUN_EVERY:-$([ "$MODE" = "work" ] && echo 1800 || echo "")}"
# The repo's test command, from what is in the folder: a package.json "test" script runs with the package manager its
# lockfile says (pnpm, yarn, bun, else npm); pytest from pytest.ini or a pyproject that names it; cargo test; go test.
# Nothing found means no test command (not "npm test" in a repo that has no package.json).
test_tools() {
  local t=""
  if [ -f package.json ] && grep -q '"test"[[:space:]]*:' package.json; then
    local pm=npm
    if [ -f pnpm-lock.yaml ]; then pm=pnpm; elif [ -f yarn.lock ]; then pm=yarn; elif [ -f bun.lockb ] || [ -f bun.lock ]; then pm=bun; fi
    t="$t,Bash($pm test*),Bash($pm run test*)"
  fi
  if [ -f pytest.ini ] || { [ -f pyproject.toml ] && grep -q pytest pyproject.toml; }; then t="$t,Bash(pytest*)"; fi
  [ -f Cargo.toml ] && t="$t,Bash(cargo test*)"
  [ -f go.mod ] && t="$t,Bash(go test*)"
  printf '%s' "$t"
}
# The plugin's own connection names its tools mcp__plugin_agentorb_agentorb__*; mcp__agentorb__* is a server added by hand.
# Local git only: no push (add "Bash(git push*)" through AGENTORB_RUN_TOOLS if you really want unattended pushes).
GIT_TOOLS="Bash(git status*),Bash(git diff*),Bash(git log*),Bash(git show*),Bash(git add*),Bash(git commit*),Bash(git checkout*),Bash(git switch*),Bash(git stash*)"
TOOLS="${AGENTORB_RUN_TOOLS:-mcp__plugin_agentorb_agentorb__*,mcp__agentorb__*,Read,Grep,Glob,Edit,Write,${GIT_TOOLS}$(test_tools)}"
MINUTES="${AGENTORB_RUN_MINUTES:-20}"
LOCK="${TMPDIR:-/tmp}/agentorb-run-$(pwd | tr -c 'a-zA-Z0-9' '_').lock"

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date -Is) another run is still going in $(pwd); skipping"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

echo "$(date -Is) agentorb $MODE run in $(pwd) (max $MAX task, ${MINUTES}m, tools: $TOOLS)"
if [ "$MODE" = "think" ]; then PROMPT="/agentorb:think"; else PROMPT="/agentorb:work $MAX"; fi   # a due routine replaces the prompt inside run.mjs
HERE="$(cd "$(dirname "$0")" && pwd)"
# run.mjs asks the board first (a hold or a plan window past 85% means no run), then reports steps and usage live.
# The run's status goes back to the runner (0056: it decides what to do next from it: 75 plan limit, 65 stuck,
# 70 crashed, 124 out of time).
rc=0
timeout "${MINUTES}m" node "$HERE/run.mjs" --job "$MODE" --prompt "$PROMPT" -- --permission-mode dontAsk --allowedTools "$TOOLS" "$@" || rc=$?
[ "$rc" -ne 0 ] && echo "$(date -Is) run ended with status $rc"
exit "$rc"

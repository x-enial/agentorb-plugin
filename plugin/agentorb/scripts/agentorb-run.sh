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
# allowlist (read, edit, git, tests). Widen it on purpose with AGENTORB_RUN_TOOLS; anything that publishes, spends or
# releases stays a needs-you card for a person. Extra arguments are passed to `claude`.
set -euo pipefail

# The key: this repo's .agentorb.local.json, else AGENTORB_KEY (run.mjs checks and says so).
MAX="${AGENTORB_RUN_MAX:-1}"
MODE="${AGENTORB_RUN_MODE:-work}"   # work: a due routine, else the next task; think: follow up and propose ideas; routine: only a due routine
# The job's cadence in seconds, for the board's rings (LATE when missed). Set it to match your timer; think runs are uneven, so leave it unset for those.
export AGENTORB_RUN_EVERY="${AGENTORB_RUN_EVERY:-$([ "$MODE" = "work" ] && echo 1800 || echo "")}"
TOOLS="${AGENTORB_RUN_TOOLS:-mcp__agentorb__*,Read,Grep,Glob,Edit,Write,Bash(git *),Bash(npm test*),Bash(npm run test*)}"
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
timeout "${MINUTES}m" node "$HERE/run.mjs" --job "$MODE" --prompt "$PROMPT" -- --permission-mode dontAsk --allowedTools "$TOOLS" "$@" || echo "$(date -Is) run ended with status $?"

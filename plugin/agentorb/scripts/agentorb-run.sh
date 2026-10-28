#!/usr/bin/env bash
# AgentOrb scheduled run: one short headless Claude Code session that picks up the next thing on the board
# (/agentorb:work), from the repo the project tracks. Uses your Claude subscription; needs AGENTORB_KEY and the
# agentorb plugin installed for your user. Set it up yourself on a timer, for example:
#
#   */30 * * * * cd /path/to/repo && bash "$(ls -d ~/.claude/plugins/cache/agentorb/agentorb/* | sort -V | tail -1)/scripts/agentorb-run.sh" >> ~/agentorb-run.log 2>&1
#
# The key is the repo's own (.agentorb.local.json) or AGENTORB_KEY; never put it in the crontab line.
#
# An unattended run gets the tools a person's session has: read, edit, the shell, web search and fetch, subagents,
# notebooks and the AgentOrb board tools (0.38.0; the old narrow allowlist refused web search and the shell and left
# real work stuck). The board's server is named (mcp__plugin_agentorb_agentorb): Claude Code reads a bare mcp__* as
# nothing, which denied every board call in folders whose settings didn't allow it (0.38.7). It is added even when
# AGENTORB_RUN_TOOLS replaces the list: a run without the board can't do anything. What still needs a person is denied outright: pushing, publishing a package, a production deploy, sudo and
# deleting from the root. Sends need no rule here: the outbound gate (pre-tool.mjs) stops any send or post that isn't
# word for word an approved part, in every run. The repo's own deny rules apply on top. One run at a time per repo (a
# lock), one task per run, a 20-minute cap. AGENTORB_RUN_TOOLS replaces the allowed list, AGENTORB_RUN_DENY the denied
# one. Extra arguments are passed to `claude`.
set -euo pipefail

# The key: this repo's .agentorb.local.json, else AGENTORB_KEY (run.mjs checks and says so).
MAX="${AGENTORB_RUN_MAX:-1}"
MODE="${AGENTORB_RUN_MODE:-work}"   # work: a due routine, else the next task; think: follow up and propose ideas; routine: only a due routine
# The job's cadence in seconds, for the board's rings (LATE when missed). Set it to match your timer; think runs are uneven, so leave it unset for those.
export AGENTORB_RUN_EVERY="${AGENTORB_RUN_EVERY:-$([ "$MODE" = "work" ] && echo 1800 || echo "")}"
TOOLS="${AGENTORB_RUN_TOOLS:-Read,Grep,Glob,Edit,Write,NotebookEdit,Bash,WebSearch,WebFetch,Task,TodoWrite}"
case ",$TOOLS," in *,mcp__plugin_agentorb_agentorb,*) ;; *) TOOLS="$TOOLS,mcp__plugin_agentorb_agentorb" ;; esac
# What a person decides: nothing leaves the machine as code, a release or a deploy without them.
DENY="${AGENTORB_RUN_DENY:-Bash(git push*),Bash(npm publish*),Bash(pnpm publish*),Bash(yarn publish*),Bash(cargo publish*),Bash(vercel --prod*),Bash(vercel deploy --prod*),Bash(supabase db push*),Bash(sudo *),Bash(rm -rf /*),Bash(rm -rf ~*)}"
MINUTES="${AGENTORB_RUN_MINUTES:-20}"
LOCK="${TMPDIR:-/tmp}/agentorb-run-$(pwd | tr -c 'a-zA-Z0-9' '_').lock"

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date -Is) another run is still going in $(pwd); skipping"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

echo "$(date -Is) agentorb $MODE run in $(pwd) (max $MAX task, ${MINUTES}m, tools: $TOOLS; denied: $DENY)"
if [ "$MODE" = "think" ]; then PROMPT="/agentorb:think"; else PROMPT="/agentorb:work $MAX"; fi   # a due routine replaces the prompt inside run.mjs
HERE="$(cd "$(dirname "$0")" && pwd)"
# run.mjs asks the board first (a hold or a plan window past 85% means no run), then reports steps and usage live.
# The run's status goes back to the runner (0056: it decides what to do next from it: 75 plan limit, 65 stuck,
# 70 crashed, 124 out of time).
rc=0
timeout "${MINUTES}m" node "$HERE/run.mjs" --job "$MODE" --prompt "$PROMPT" -- --permission-mode dontAsk --allowedTools "$TOOLS" --disallowedTools "$DENY" "$@" || rc=$?
[ "$rc" -ne 0 ] && echo "$(date -Is) run ended with status $rc"
exit "$rc"

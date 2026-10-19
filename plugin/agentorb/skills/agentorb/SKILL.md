---
name: agentorb
description: Work with the AgentOrb board (the agentorb MCP tools). Use when the user mentions AgentOrb, the board, a project's status, tasks assigned to agents, or when a session changes something worth recording for the owner.
---

# AgentOrb: the board where all of your agents work, together

You are one of the owner's agents. The board (agentorb MCP tools) is where the owner sees what every agent is doing across every project. Keep it true; they run several businesses and codebases and read the board instead of asking.

## Every session

1. The session-start hook already told you which project this repo is and what is new. If it didn't run, call `list_projects` with `git remote get-url origin`, then `whats_new`.
2. Before changing anything on a project: `get_brief` (what is settled and in flight), `get_board` or `search` to find cards, `get_card` for a rev before `edit_card`.

## The project's pages

`list_pages` then `get_page` for the rules and facts that bear on your work, before you change anything; follow them. They are the owner's; never edit them. If one is wrong or stale, say so on a card (needs-you) with the exact line and the fix.

## Routines

The project's scheduled jobs live on the board. `my_routines` lists yours with what is due now; do a due routine's brief as a task (it is the owner's brief, never a licence to go outbound, spend or release), then `routine_done` with ok and a one-line result. The runner does this on its timer; in an open session, run a due one if the owner asks. If you keep your own scheduler, mirror your routines there and still call `routine_done` after every run. `propose_routine` suggests a new one; the owner approves it on the Routines panel first.

## While you work

- `claim_task` before you start a task; one agent per task. `set_status` with state working, the task, a short note, your branch and host. `heartbeat` during long silent work.
- Keep the card's status true: `set_card_status` to doing when you start, done when it ships (with `proof`: what shows it, like a PR or commit link, a post link or a message id; the next agent and the owner check it there), blocked (with why) when stuck, needs-you (with why) when the owner must act, waiting (with `why`: what it waits on, and/or `until`: YYYY-MM-DD) when it waits on a date or something outside (a review, a reply, a release window): waiting stays out of the owner's inbox, autopilot skips it, and on its day it comes back to Next and wakes you. needs-you and blocked put a box with buttons on the card: `ask: go` gives Approve / Not yet (how you ask for a go: publish, spend, release, delete; never do those without it), `ask: question` an answer box, `options` one button per answer, and blocked a "Done, carry on" button. The owner is DMed. Their answer comes back in `my_work` and `whats_new` as `answers`, and the card returns to you as doing: act on answers first.
- Anything that will be published or sent (posts, emails, DMs) goes to the owner as a draft in parts: `submit_draft` with a label, the text and where it goes for each part. Wait; `whats_new` says when they finished; `get_approved` gives the exact wording to use. Never post your own text.
- Talk to another agent with `message_agent` (to, card, text): it lands in the card's thread, wakes that agent, and reaches it as `messages` in `my_work` / `whats_new` with who sent it. Mark anything you relay from outside (a web page, an email, a DM) with `external: true`. After 12 agent-to-agent messages on a card without a person, the board stops the thread and asks the owner.
- `add_note` for short progress notes and `@Name` to reach a person; `ask` when you need an answer from a person (a request with buttons on the card; never a question in a plain note, which they can't answer with a click) or an agent (a note); it marks you waiting. `hand_off` to pass a task to another agent, with `done` (what you finished), `left` (what is left) and `check` (how they can check your part). Picking one up: claim it (that is the receipt the board shows), check the done part the way `check` says before you build on it, and note it if it doesn't hold.
- New work: `add_card` or `add_task` (under its parent). New structure: `add_track`, `add_stop`. One project per codebase or line of business: `create_project` (kind codebase, with the repo) when none tracks this repo.
- Keep the project's picture true: when the state of the area you work in changes, `set_area` with a few lines on what is true now (not a log); when you can count something the project tracks (`get_numbers` shows its columns), `post_numbers` for today. Read both before a think run.
- Anything the owner reads is short and plain: the point first, short sentences, numbers next to what they compare to, no process or hedging. A question to them is at most 300 characters, a note that tags them at most 80 words; the tools refuse longer.
- Notes have a kind (`add_note` `kind`): talk (the default: questions, answers, messages), `finding` (a result worth keeping on the card, pinned above the thread), `link` (a folder, doc or dashboard, with what it is), `activity` (a progress line nobody needs to read now; folded away). Progress goes in `set_status`, not in talk notes; proof goes in `proof` on done (no separate note).
- Something finished for the owner to read (an analysis, a weekly summary, an FYI, a routine's brief) goes out with `post_report`: a title that is the takeaway (under 80 characters), a `summary` of 1 to 3 short lines (at most 60 words: what happened, what it means, what's next), optional `body` detail folded under it (at most 250 words), and a `series` for a recurring one ("Weekly numbers") so each lands in the same place. It shows on Status under For you to read with a Seen button and DMs your owner. Never use needs-you for it (that asks them to act), and never leave it only as a note on a card. `get_reports` shows your last ones and whether they were seen.
- Work with the other agents: `assign_task` puts a card in an agent's inbox (`to: me` for yourself). Split a job into tasks and assign them; `ask` the agent whose status says it is on the thing; `hand_off` what you can't finish. `my_work` is your inbox and says whether Autopilot is on: if it is, finish what you hold, then your inbox, then Next; stop only at needs-you, blocked, or an empty inbox.

## Write for a ten-second read

A card body is at most 120 words (the project may set fewer; the tool refuses longer): what, why, first step, one line each. The owner reads cards on a phone between meetings. Detail, reasoning and evidence go in `add_note` (short notes, several if needed) or a `submit_draft`, never into the card. Titles under 60 characters. A `why` is one line.

## When you stop

- `set_status` idle with a note of what is left. `release_task` or `hand_off` anything you hold.
- Commit, PR and deploy facts belong in a note on the card ("shipped in abc123 on main"), not in the title.

## Your role

Session start says your role. Pick up cards on your own tracks; take others only when a person or another agent asks you (claim_task warns when a card is outside your role and names who works it). Writing roles (Writer, Marketer, Support): every draft part cites where its facts come from (`sources`: links, or `ref` to a repo file, commit, card or page). The board refuses a part without one; when the facts aren't in your context or the repo history, ask on the card instead of guessing. The role's page on the board (Voice, Support rules...) is printed at session start: follow it.

## Long work: resume, not restart

On a card that takes many steps, call `checkpoint` after each step that would hurt to redo (step N of M, what's done and where, what's next). If your run dies, the next run on the card (yours or another agent's) gets it back from `claim_task` as `resume`: check `resume.done` holds, then start at `resume.next`.

## Guardrails you will meet

- Sending, posting or publishing goes through the outbound gate: use `get_approved` and send its text exactly, to the approved recipients. Anything else is stopped; new wording goes to the person with `submit_draft`.
- You may be limited to some boards: others don't show, and writes there are refused. Don't try to get around it.
- The board refuses anything that looks like a key, token or password. Keep secrets out of notes, cards and drafts.
- Too many archives, changes or refused calls in a few minutes pause you automatically, with the reason on the board. Stop, set your status, and wait for a person.

## Never on the board

Keys, tokens, secrets, customer emails, the owner's real name if they keep it off, or anything from a private channel. Mirror the repo's docs; the board is for status and coordination, not the record.

## Tools in one line each

list_projects(repo?) · get_brief · list_pages · get_page · my_routines · routine_done · propose_routine · get_board · search · get_card · list_decisions · recent_changes · list_proposals · who_is_here · whats_new · my_work · submit_draft · get_approved · get_numbers · post_numbers · get_areas · set_area · post_report · get_reports · set_status · heartbeat · claim_task · assign_task · release_task · hand_off · update_task · set_card_status · add_note · ask · message_agent · reply_to_peer · report_reach · checkpoint · wake_check_url · add_card · add_task · edit_card · move_card · archive_card · add_track · add_stop · create_project · rename_project

# Turnpups Management Operating System

A daily assist system that watches the work so Alex can decide instead of chase.

It surfaces what needs attention across three layers, cuts the time spent routing,
tracking and remembering to check on things, and protects the readout as a required step
rather than an optional one.

**Guiding principle.** The system makes Alex a better watcher and decider. It does not
replace the team closing their own loops.

---

## The three layers

| Layer | What it watches | Source |
|---|---|---|
| **1. Leadership priorities** | the P1s leadership actually cares about. Checked first, every day. | `config/leadership-queue.json` |
| **2. ClickUp** | the sprint. Not Started, In Progress, and what changed since yesterday. | ClickUp API |
| **3. Active tests** | running experiments, compared on results rather than ticket activity. | Intelligems API |
| **Cross layer** | does every person's sprint ladder up to a leadership priority. | both 1 and 2 |

The **daily readout** goes out at 8:00 AM Central, Monday to Friday. It compares the
previous working day's 8 AM snapshot against a fresh snapshot taken that morning and
reports the delta. The **dashboard** reads the same storage and can re-pull on demand.

---

## The one design decision everything else follows from

**Deterministic vs agentic.** No model touches the daily readout.

| | Runs as | Why |
|---|---|---|
| Every API pull, snapshot, delta, cross layer check, readiness gate, P1 band, the report, the dashboard, the 8 AM send | **plain code** | The readout has to be trustworthy and cheap. A model summarizing numbers can drift, hallucinate a metric, or phrase the same fact three ways on three days. Code cannot. |
| The **Strategic Advisor**, when Alex clicks the button on a flagged item | **one Anthropic call** | Judgement is the product. |
| The **Learning Skill**, when Alex replies with feedback in Slack | **one Anthropic call** | Same. |
| **Ideation**, when Alex presses the button on the Ideation tab | **one Anthropic call** over the whole sprint | Same. |
| **Daily Speech**, written by itself straight after the 8 AM readout, and again whenever Alex presses the button | **one Anthropic call** (effort medium), then a plain-code check of every figure in it | The story is judgement. Whether its numbers are real is not: code flags any figure it cannot find in the data. |
| **Overall Impact**, each working morning at 9 Central (and on "Reorganize now") | plain-code harvest, then **one Anthropic call** (effort medium) to regroup the themes | Grouping work into outcomes is judgement. What gets recorded is not: the harvest is code, and code enforces that no item is ever dropped. |

**Expected token spend on a normal day: one Daily Speech after the 8 AM readout, and one
regrouping call for Overall Impact.** Every other token is spent only when Alex asks a question or gives feedback. The readout itself
still spends none.

### Overall Impact

An append-only record of what Alex and the team shipped, grouped into themes and
sub-themes that get regrouped as it grows. `src/impact/ledger.js` harvests from the latest
report: done tickets (ClickUp), tests launched and concluded (Intelligems), shipped rocks,
and one item per day of commits to this repo (needs `GITHUB_TOKEN`). Every item links to
the work. `src/agents/impact.js` runs the daily pass; `skills/impact-curator/SKILL.md` is
the brief. Items are never deleted: anything a regrouping leaves out goes back under its
old theme or into "Not yet sorted". The model sees items under short aliases (`n1`,
`n2`, ...) so writing every id back fits in one answer. Until a regrouping succeeds, new
items are placed by rock and Big Swing, then by keywords in the title (`KEYWORD_THEMES`).
Each day's themes are kept at `impact/history/<date>.json`. On the tab every theme starts
collapsed; biggest first, "Not yet sorted" last.

### Site changelog

What changed on firstday.com in production, from the team's changelog sheet.
`src/collectors/changelog.js` reads it at every pipeline run into `detail.changelog` (the
last `lookbackDays`, default 14), and live when the Daily Speech is written. It reads
each tab in `system.changelog.tabs` from its **public CSV export link**, no credentials,
because the sheet is shared as "anyone with the link can view": **Web Changelog Flow**
(the current log the Slack workflow appends to) and **site_changelog** (the older
day-by-day log). Tabs are merged, and the same change on the same day in both counts once.
Columns are found by their headers, so adding or moving a column changes nothing.
Screenshot links are never read (they carry Slack ids). If the sheet stops being public,
the Update says so; set `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PRIVATE_KEY` and the
Sheets API is used instead (`docs/DEPLOY.md`). It raises no flags and has no baseline;
if it cannot be read, everything else goes out as normal.

The rule of thumb, for anyone extending this: if you can write the logic as an `if`
statement, it is deterministic. If the answer depends on business context that lives in a
skill file, it is agentic.

---

## Layout

```
config/            single source of truth. every threshold, list, field id and rule.
skills/            the skill files. plain-language specs the code implements.
src/
  config.js        loads and validates config, and collects the open questions
  lib/             time and baseline rules, logger with redaction, HTTP with retries, storage, auth
  collectors/      one per source. each returns a snapshot.
  delta/           the rules. snapshots in, flags out.
  render/           flags plus snapshots in, a report out.
  send/            Slack, and inbound signature verification
  agents/          the only places an Anthropic call happens: advisor, learning, ideation
  pipeline.js      collector -> delta -> render -> send
netlify/functions/ the 8 AM trigger, the pipeline, the dashboard API, the Slack endpoints
public/            the dashboard
test/              532 tests, no network, no API keys needed
scripts/           run the pipeline locally, and a syntax check
```

Each stage is a separate function with a clear input and output. Collector returns a
snapshot, delta returns flags, renderer returns a report. That separation is what makes it
testable, and it is why the tests need no network and no credentials.

---

## Run it locally

```bash
npm install
npm test                    # 532 tests. no network, no keys.
npm run check               # parses every source and config file

cp .env.example .env        # then fill in the tokens you have
npm run readout:dry         # full pipeline against the real APIs, no Slack post
npm run dev                 # netlify dev: the dashboard plus all functions
```

`npm run readout:dry` writes snapshots to `.data/` instead of Netlify Blobs, prints the
readout, and lists every decision still open. It works with partial credentials: whichever
collector has no token reports as a missing section rather than failing the run.

Useful flags: `--date=2026-09-11` to pretend it is another day, `--force` to run despite
fatal config problems, `--storage=memory` to leave no trace.

---

## Build order, and where this build stands

The spec's build order, with what is done:

| # | Step | State |
|---|---|---|
| 1 | ClickUp collector and snapshot | built, tested against fixtures |
| 2 | Delta on two snapshots | built, tested |
| 3 | Renderer to plain text, posted to Slack | built, tested |
| 4 | Scheduler | built. **Needs three mornings of watching.** |
| 5 | Intelligems collector | built and **verified against a real payload** |
| 6 | Cross layer checks and the leadership layer | built, tested |
| 7 | Dashboard | built |
| 8 | Strategic Advisor button | built |
| 9 | Learning skill | built last, as specified, since it edits everything else |

Everything is implemented, and both integrations have been checked against the live First
Day accounts rather than against the spec's description of them — which caught a set of
wrong field names that would have left Layer 3 silently reporting nothing. The corrections
are recorded in `docs/INTEGRATIONS.md`; deploy steps are in `docs/DEPLOY.md`.

What has **not** happened is a run against the real APIs with real tokens, since the
pipeline needs credentials this environment does not hold.

---

## What is still owed, and by whom

Most of the original list has been answered by reading the live accounts. What is left is
genuinely a decision or an action, not a lookup.

### To run a dry run against real data

Two secrets, in a `.env` file at the project root:

```bash
cp .env.example .env
```

```bash
# .env  (gitignored, local only)
CLICKUP_TOKEN=pk_...        # ClickUp > avatar > Settings > Apps > API Token
INTELLIGEMS_TOKEN=...       # Intelligems > Integrations > External API > Enable
```

Then `npm run readout:dry`. For the deployed site these same names go in Netlify's
environment variables instead; the `.env` file is never deployed. The sprint list id, the status names, the workspace id, the
Intelligems org and every endpoint are already in `config/` and verified. A missing token
degrades that layer to a labelled missing section rather than failing the run, so either
token alone still produces a readout.

### Blocking, for the system to do what the spec describes

1. ~~Create the `Task Owner` field.~~ Retired 2026-11-17: rock owners are the source of
   truth for ownership, and a ticket's assignees are who it belongs to.
2. **Link each rock to its Big Swing.** Tickets reach rocks through the ClickUp **Big
   Swing** field (decided 2026-10-19), so every active rock needs its Big Swing option set.
   A rock without one is flagged, with a quick fix on the flag. The Leadership Priority
   (`Rock Reference`) field is now read only for its BAU marker.
3. **Confirm the team roster** in `config/people.json`. It is pre-filled with the five
   people currently holding open sprint work, inferred rather than told.

### Decisions only Alex can make

4. ~~The verdict mapping~~ and ~~the mini readout window~~: decided 2026-10-22 (strong
   win Ship, strong loss Kill, directional and mixed Iterate, only past the gate with a
   clear result; shipped rocks 14 days, active rocks 7). LTV references decided 2026-10-26:
   12 month multipliers of first-order revenue, 3.95 subscription and 1.78 one-time, in
   Settings. Still open on the Setup page: the metric lists.
6. **The real leadership queue**, replacing the example item.
7. **Central or Pacific.** The store reports in Pacific; the readout is specified for 8 AM
   Central. Two hours apart, so "yesterday" differs between them.
8. **Business context** for `skills/strategic-advisor/SKILL.md`. The advisor now reads
   every rock as the quarter's goals on each call (decided 2026-10-26), so priorities stay
   current on their own. Still to add: what is deliberately not a priority, constraints,
   past decisions, and risk appetite on a test call.
9. **A Netlify plan check** for Background Functions.

### Answered by reading the accounts, no longer owed

Sprint list id · status names · whether a separate backlog list exists (yes) · whether
300 orders is per group (yes) · whether COGS is configured (no) · the real metric names ·
the full verdict set · Intelligems rate limits · the store's currency and timezone · every
REST endpoint and response field name.

## One thing in the spec that needs a decision, not code

The requirements document lists **Skill 2a, Test Analysis Skill** — and then, under
Skill 2, says "One skill. Pulls the reports, runs the analysis, stores what it learns. **No
separate analysis skill.**" It also says "Five skills", and numbers Learning as 4 and
Strategic Advisor as 5, leaving no slot for a sixth.

This build reads 2a as an earlier draft that Skill 2 supersedes: there are five skills and
the analysis lives inside the Intelligems Manager. Every requirement listed under 2a is
implemented — the per-test metric map, the trade off analysis, the projected
recommendation, the readiness gate — just not as a separate skill.

**If that reading is wrong, it is the one structural thing to correct before building
further.** Splitting it later is a small change; assuming wrong for a month is not.

---

## Reading the readout

Layer 2's whole point is telling **"stalled, needs a question"** apart from **"picked up,
just waiting"**, so that is an explicit per-task signal rather than something the reader
has to infer:

| Signal | Means |
|---|---|
| `moving` | the status changed since the baseline |
| `waiting` | a comment, an assignee change or an update landed, but the status held. Someone has it in hand. |
| `stalled` | In Progress, and untouched for `stalledAfterDays`. **This is where a clarifying question goes.** |
| `idle` | Not Started and untouched. Expected early in a sprint, worth noticing late in one. |

Severities: **p1** (Layer 1 items and material test movement), **attention**,
**prompt** (a test ready for a call with no decision recorded), **info** (hygiene).
Store moves and control-group moves are **context**: shown with the store numbers, never
in a list to act on.

## Using the dashboard

Three tabs across the top. Sprint opens by default.

| Tab | What it is for |
|---|---|
| **Sprint** | The week's commitment: every open ticket, grouped by person or by what it waits on, worst first. Each shows its status, how long it has sat there, its rock, what it is waiting on, and the last ClickUp comment with who said it and when. "Waiting on" is worked out in order: someone you marked waiting on, then someone the last comment @mentions, then a stall, then the status read as a stage (QA, deploy, to start). Done this week (tickets in "done (this sprint)", never "complete", now named "dont use") and what changed sit collapsed below. |
| **Rocks** | The Web team's rocks for this quarter, **read only from the marketing standup's Supabase project** (`system.supabase`, key `SUPABASE_SERVICE_KEY`; the app only ever sends GET there, and `test/supabase-rocks.test.js` fails otherwise). Each rock shows its latest green / amber / red status and why, its milestones, its tactics, and the sprint and backlog tickets that reach it through the Big Swings on it and its tactics. The owner and Big Swing on each rock and tactic are this app's own (`rocks/links.json`), set right on the row. If Supabase cannot be read, the last good copy is shown, labelled. Remove `system.supabase` to go back to the dashboard's own rocks store, planned by month. `#rocks/<id>` opens one. |
| **My stand-up** (Write-ups) | Your own Yesterday / Today / Blockers for #ecomm-team, in your format ("Yesterday: sesame street feedback + planning"). Code gathers numbered facts: your last stand-up in the channel (its Today is what you meant to do) and your recent posts as the style; your ClickUp tickets that closed, moved or got your comment since the previous readout, and your open ones by due date; replies you owe; this week's Quarter plan items; your notes; flags you marked Waiting on (the blockers); and your own Slack messages since the previous working day. One Claude call (`skills/my-standup/SKILL.md`, low effort) writes the three lines citing the facts behind each; code drops any citation that does not exist and marks a line that cites nothing. Written after the 8 AM readout (`system.myStandup.writeAfterReadout: false` turns that off) and on Write a new one; edit in place and Copy. Nothing is posted. Slack needs a user token, `SLACK_USER_TOKEN` with the `search:read` user scope, because the bot cannot be in every channel or see DMs; only messages from you are searched, mentions become names and no Slack id is stored. Without it the draft works from the rest and says so. |
| **Rock course check** | Whether each rock is on course by the evidence, not by its status in the standup (`src/delta/rock-course.js`). Per rock: an earlier month's milestone not done; this month's milestone blocked, open with nothing moving a quarter into the month, or open in the last week of the month; tactics more than 2 days past their check-in (half or more is off course); open tickets none of which moved in a week; no open ticket at all with milestones left; planned items from earlier weeks not done. Tactics with no ClickUp link are listed as "cannot see", never a reason on their own. Off course is a P1 that leads Your queue (`leadership.rock_off_course`), drifting a P2 that escalates after a working week; each names every reason, its fix, and who to decide with, and links to the Quarter plan. It stands in for that rock's At Risk, stalled-work and due-not-moving flags. Thresholds in `system.rockCourse`. |
| **Quarter plan** (Team) | The quarter as months and their weeks (a week belongs to the month its Thursday is in, `public/quarter.js`). The course check up top, then a grid: each rock with its progress bar (quarter gone, milestones done), a milestones line per month, a row per tactic and one for tickets on the rock itself. In each week: the work you planned (+ to add, tick when done, × to remove; a past week's unticked item turns red and counts toward the course check) and the ClickUp tickets done that week or due in it; tickets with no due date sit in the last column. Planned items are this app's (`plan/<quarter>.json`, audited in `plan/audit/`); finished tickets are kept per quarter in `plan/<quarter>-tickets.json` from each 8 AM readout, backfilled once from the stored readouts, so earlier weeks keep their work after a sprint closes. `#plan/<rock id>` jumps to a rock. |
| **Rocks: ClickUp ROCK and TACTIC vs the standup** | ClickUp's ROCK field (formerly Big Swing) should carry each rock's name and TACTIC (formerly Rock Reference) each open tactic's name, 1:1 with the standup. Tickets link by those names every run (`src/collectors/clickup-names.js`), on top of links set by hand; a ticket with only a TACTIC reaches the tactic's rock. A checklist at the top of Rocks shows what matches, what is close (rename to match), and the old values that name nothing, with Copy as a checklist. |
| **Next steps** | At the top of the Sprint tab: every ticket check that ends in something you do, under four actions. **Reply**: someone @mentioned you; you are assigned with others and it sits in QA or ready for deploy; you are on a stalled or stuck ticket. **Nudge**: a question to someone else unanswered 2+ days; sent back from QA or deploy in the last 3 days; due within 2 days and not started; stalled or stuck in its status. **Decide**: overdue; Wednesday onward and still not started (per person); carried over from before this sprint (per person); 3+ in progress at once; a rock due this month with nothing in progress; a rock with no sprint ticket. **Fix**: no assignee; no owner; no Big Swing; in progress with no due date (once 3+ open tickets have one). Same buttons as the readout. Rules live in `src/delta/next-steps.js`; thresholds can be set under `clickup.nextSteps` in `config/clickup.json`. |
| **Who to ask** | Every sprint ticket names who to reach out to. A ticket belongs to its assignees (the Project Owner field was retired 2026-11-17; ownership above the ticket is the rocks'). In order: someone the ticket is waiting on (marked by you, or @mentioned in the last comment); "Reply to" whoever @mentioned you; then the assignees. The Sprint tab groups by person or by what it waits on. |
| **1:1** | One person: talking points to copy, their rocks and target months, each sprint ticket with what it waits on, what is queued for them in the backlog, done this week, tests they own, and open flags. `#people/<clickup id>` links to a person. |
| **Update + Stand-up** | The daily update (every sprint ticket touched since the start of the previous working day, grouped by ROCK, untick and copy), with each person's latest #ecomm-team stand-up folded in. A stand-up line sits under a ticket when it clearly names one of that person's tickets (or a ticket nobody is on): shared words, a word on three or more tickets counting half, or an acronym of the name such as FBB; lines joined with " + " are matched piece by piece. A ticket named in stand-up is added even if ClickUp was not touched. Unmatched lines go under "Also from stand-up", then blockers. Built in `public/update-text.js`, no model. |
| **This week's wins** (Write-ups) | The same write-up as Last week's wins, from tickets in "done (this sprint)": by ROCK, then kudos by person, untick and copy (`buildThisWeekWins` in `public/update-text.js`). |
| **Last week's wins** (Write-ups) | Every "dont use" ticket (formerly "complete": last sprint's work) summed up by the ClickUp ROCK field (formerly Big Swing), one plain-text line per ROCK value, then kudos by person with their wins and rocks. No counts or markdown, so it pastes cleanly anywhere. Untick to leave a ticket out of both; Copy all for the paste. |
| **Stand-up** | What each person posted in #ecomm-team (Yesterday, Today, Blockers), one day at a time with the last two weeks to flip through. Blockers are pulled to the top, and anyone who usually posts but has not yet is named. Read live from Slack (`conversations.history`, read only) each time the tab opens, since most people post after the 8 AM run; nothing is stored, and posters are matched to the roster by name, not Slack id. The bot must be a member of the channel. |
| **Daily Speech** | The day's top-line storyline to give the team, ready to say or paste: a headline under 15 words, the beats (the win, across the business, the stakes, today) and a closing line. On a button press it reads the latest readout (rocks, store numbers, tests, sprint, week in review), the last three days of stand-ups, what Overall Impact recorded as shipped in the last 7 days, the last 7 days of **changes to production** from the site changelog sheet (read live at the press, else the readout's copy), and the **cross-functional (XF)** list, and makes one Claude call (`skills/daily-speech/SKILL.md`). Every figure in the speech is then checked in code against that data, allowing for spoken rounding (12% matches 11.8), and any it cannot find is flagged above the speech with "Check before you say it". "What it rests on" lists each claim and its source. **Notes from the day** sit at the top of the tab: paste or type anything as it comes in (a Slack ask from another team, a meeting takeaway). From Slack, Alex can save to it with **Save to daily notes** (⋯ on any message, in any channel Alex can see; saves who said it, where, and a link) or `/tpnote <text>` (`src/send/slack-notes.js`; Alex only, private reply from Claude). Stored per Central date at `notes/<date>.json` (`src/store/day-notes.js`). Every speech reads all notes and ClickUp comments from people off the roster from local midnight of the previous working day up to the moment the button is pressed, so Monday's reaches back to Friday; the tab says when notes were added after the speech shown. The "Across the business" beat draws on the notes first and is left out when there is nothing from other teams. Reading Slack channels directly (`src/collectors/xf.js`) is built but off (`system.slack.xf.enabled: false`), since it needs the bot in every channel. Stored at `speech/latest.json`, with a copy per day under `speech/history/`. **Ready each morning:** after the official 8 AM run, `run-pipeline-background` calls `morningSpeech` (`src/agents/daily-speech.js`), so the speech is waiting when the tab opens, marked "written automatically". It skips a readout that already has a speech (a retry, or Alex was first), never fails the readout, and is turned off with `system.dailySpeech.writeAfterReadout: false`. Press the button after adding notes to fold them in. |
| **Ideation** | Every sprint ticket except complete: successful, unsuccessful or too early to call, the root cause of why with the evidence it rests on, and three other ways to approach it. On a button press it reads each ticket's description and comment thread from ClickUp (read only), the last week of stand-ups, the Intelligems tests and the rocks, and makes one Claude call (`skills/ideation/SKILL.md`). The answer is stored and shown until the next run. |

The menu (☰) holds the rest:

| Where | What it is for |
|---|---|
| **Today's moves** (top of What needs you) | Two tabs, each with a count badge. **Unblock others** (the default while anyone is waiting) lists the people waiting on Alex: a reply owed in ClickUp, or a ticket waiting on Alex's review; one row each saying who is waiting, opening to the full card. These leave Your queue so nothing shows twice. Alex's tickets in QA, VQA or review are someone's work waiting on Alex, so they sit under Unblock others as **Your QA** ("Akansha is waiting on your QA"), with Delegate asking someone to do the check. **My rock work** starts with Alex's other open tickets: **In flight** (past To Do, not in review, soonest due first), then **To do**, each with **Delegate**, a drafted ask in Alex's voice for a teammate to take it on or help, to copy or schedule in Slack as Alex. Then the rock moves: | Up to 3 things a day that move a rock, picked before the queue (`src/focus/moves.js`, `netlify/functions/focus.mjs`). Suggested from the decision each off-course or drifting rock is waiting on, this week's Quarter plan items, and your own open tickets on a rock; each says why now and what it moves: the rock and its course, this month's milestone, the tactic and its KPI, and the rock's definition of done, all copied from the rocks and ClickUp. Or add your own on a rock. **Start now** adds it and starts it (or **Later today** just adds it); a started move shows how long it has run, the first step, one click to the ClickUp ticket, the rock or the Quarter plan, a note to copy (to the rock owner, or your stand-up line; nothing is sent) and a 25-minute focus timer kept in the browser. The queue below leaves out the rock decisions already offered here. Done ticks it off with the time; the week strip counts rock moves per day and per rock, with the tickets on rocks you shipped. Stored as `focus/<day>.json`; My stand-up reads yesterday's done moves and today's picks. |
| **What needs you** (Today) | The landing page. Pages are in the top bar; the ☰ menu (pinned open on wide screens) lists the open page's sections and Setup (on What needs you: Today's moves and Your queue, each with a one-line what-it-is and a live count), where **Send a test readout** now lives. Resources is grouped: Reporting (Ecom Reporting Hub), Planning (Ecom Roadmap, and **Ecom Rocks**, a page in this app: one board on one screen, a column per active rock: the rock's circle with its owner, ringed by its course, and its tactics hanging below with their owners and open-ticket count (status shown when it is not on track). Click a tactic for its tickets, placed the way the rock check places them; click a rock to fold its tactics, or Fold all) and Testing (AB Testing, the roadmap's tests view: tests ready for a call live there, not here). Each person's rock vs business-as-usual split is raised as a flag when someone has no rock work; there is no separate table. Your queue: every flag in one place, tidy-ups included, with filters: the pile (Open, Waiting, Handled), the kind (P1, P2, Decisions, Tidy-ups, each with a count), person, area and search. Unfiltered, it is ranked with the top 3 in full and the rest one line each; any filter turns it into a flat list to work down. × hides for today and Handled brings anything back (Undo for 8 seconds too). **Noisy rules** and the plain-text Slack readout are on the Setup page. Routine sprint checks at P2 (overdue, not started, carried over, nobody assigned, stuck) fold into one line per person (`public/flag-groups.js`, shared with the Slack readout), with one drafted nudge for all of that person's tickets, Done all, and Hide all for today. P1s, tests and replies owed stay on their own. At the bottom, the **Rule check** (`src/delta/rule-health.js`): for each rule over the last two weeks of readouts, how many flags it raised and how many were acted on, cleared on their own, or sat ignored. A rule you never act on whose flags sit untouched is suggested for Hygiene, and one click moves it there (or back) from the next run; P1 rules cannot be moved. Nothing else sits on the page (store numbers, month to date and the conversion funnel are not shown here: they live in the Ecom Reporting Hub, linked under Resources in the top bar): Done, Snooze, Waiting on, Not a problem, Draft a nudge, and quick fixes on rock flags. A ticket with nobody assigned has a picker on its card (and one for all of them on the grouped line): Assign in ClickUp adds that person as an assignee (`netlify/functions/ticket-assignee.mjs`: only adding an assignee, only roster people, only on tickets the latest readout shows with nobody assigned, each write recorded in `clickup/writes/`) and marks the card Done. A card about tickets with no ROCK (one ticket, or a person with none) lists each such ticket with a rock picker: **Set ROCK** writes the ClickUp ROCK field (`netlify/functions/ticket-rock.mjs`, `src/send/clickup-rock.js`: only that field, only to an active rock with a ClickUp option, only on tickets in the latest readout, each write recorded in `clickup/writes/`) and marks the card Done once none is left. **Nudge drafts** are written the way Alex writes them: topic emojis from the ticket and its rock (:test_tube:, :package:…), @ the person, the ask, what Alex can see (status and days in it, the due date, the last comment and who left it), why (keep it moving, same page), room to adjust, and thanks; every fact from ClickUp. **Schedule a nudge:** under any drafted nudge (one ticket, or one person's sprint items), Schedule in Slack sends the draft as a DM from Alex's own account at the time picked, 9 AM the next working day by default (`netlify/functions/slack-schedule.mjs`, `src/send/slack-schedule.js`). Only to someone on the roster, found in Slack by name at that moment, with "_Drafted with Claude_" added at the end; the card then waits on them, and the toast says which Slack account it is from and offers Cancel. The queue's **Waiting** pile lists everything scheduled in Slack right now (read from Slack each time, with Cancel). A bot token (`xoxb-`) in `SLACK_USER_TOKEN` is refused, since it would send from the bot instead of from Alex. Nothing is stored but the name, time and text (`slack/scheduled/`). Needs `SLACK_USER_TOKEN` to carry the user scopes `users:read`, `im:write` and `chat:write` as well as `search:read`. This is the one thing the app sends to a teammate, and only when Alex presses Schedule. |
| **Tests** | Not in this dashboard: Resources › AB Testing opens the Ecom Roadmap's tests view, and every test link here goes there. An old `#tests` link lands on What needs you. Test flags still come in with the readout (and the Slack readout still carries test results). |
| **Setup** | The LTV multipliers and the decisions still open. |

The system only ever communicates with Alex. Nudges are drafts to copy; nothing is sent
to the team, and the team roster holds no contact details.

---

## Things that are true and worth knowing

- **The baseline never floats.** It is always the previous *working* day's 8 AM snapshot.
  Monday's baseline is Friday's. A refresh at 2 PM uses the same baseline the 8 AM run
  used, which is what makes a mid-day dashboard view a preview of tomorrow's readout.
- **A partial readout beats no readout.** Collectors fail independently. If Intelligems is
  down, the ClickUp readout still goes out with an explicit line naming the missing section
  and why.
- **A failed collector never overwrites a good snapshot.** An empty snapshot is refused, so
  yesterday's baseline survives an outage.
- **Running twice is safe.** The Slack post is keyed on the run date and checked before
  sending, so Netlify's free background-function retry cannot double post.
- **The daily alert can be tested by hand, without touching tomorrow.** *Send a test
  readout* in the hamburger menu posts through the same sender the 8 AM run uses, so it
  proves the parts a dry run cannot reach: channel membership, a scope lost to a
  reinstall, blocks Slack will accept. It runs as mode `test`, which matters twice — only
  an `official` snapshot enters the baseline index, and only an `official` report claims
  the per-date Slack key. A test send therefore cannot leave tomorrow comparing against
  this afternoon, and cannot suppress the real readout. It arms on the first click and
  posts on the second, because it goes to a channel other people read.
- **Time in status is measured, and says when it is only a bound.** ClickUp's
  `time_in_status` endpoint returns an empty history on this plan (verified live), so the
  clock is kept from this system's own daily snapshots and the ledger is rebuilt from
  them if it is ever lost. A ticket already in flight when tracking started shows
  **≥ N days**, floored at its last activity — a true lower bound, since any activity
  including a status change moves that date. Once a transition is witnessed between two
  snapshots the number is exact and the ≥ goes away. Limits are per status, not per
  bucket: a week in progress is work, a week in QA is a queue. Not Started has no limit,
  because a backlog is supposed to sit.
- **Nothing is compared against a value that was not returned.** A missing confidence
  interval skips its band check and says so. A null profit metric renders as "not
  configured", never as zero. Unknown days or orders is unknown, not zero.
- **Dropdowns are matched by option id, not label.** Renaming an option in ClickUp does not
  produce a phantom "priority changed" line, and a rock stores only the option id, so a
  rename never breaks the link. The one thing a rename does affect is the *name shown*,
  which comes from a cached field map — cached for an hour, and always re-fetched for the
  8 AM official run, so the readout never announces a project by a title nobody uses. A
  rock that has no Big Swing set is joined to ClickUp by title match instead, which
  a rename *would* break silently; that is reported as hygiene before it breaks, not
  after.
- **Tokens never reach a log line.** Redaction happens inside the logger, by header name
  and by scrubbing registered secret values out of every string — including error messages,
  which is where a token usually escapes. There is a test for it.
- **The dashboard is not public.** It shows sprint and test data, so it sits behind a shared
  password and a signed, HttpOnly session cookie. Netlify Identity is a drop-in alternative;
  `isAuthorized` in `src/lib/dashboard-auth.js` is the only place that would change.
- **Tests link both ways.** Each test card links out to Intelligems, and the Tests view
  answers deep links: `#tests/<experienceId>` opens with that test expanded and scrolled
  to. A rock's experiment link uses it, so following a big swing lands on the readout for
  the test meant to prove it rather than on a list of nine cards. The console path comes
  from the Intelligems app's own link builder — `/experiment/<id>`, or
  `/personalization/<id>` — and never carries its `?action=edit`, because these are links
  to look at a test, not to change one.
- **Every Slack message identifies itself as Claude.** Not configurable.
- **This system never writes to any platform.** It reads ClickUp and Intelligems and posts
  to Slack. Dropdown drift and field gaps are *flagged*, never auto-corrected. The only
  thing it writes is a pull request against its own repo, and only with Alex's approval.
# app-alex-os

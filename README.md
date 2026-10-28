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

**Expected token spend on a normal day: zero.** Tokens are spent only when Alex asks a
question or gives feedback.

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
test/              117 tests, no network, no API keys needed
scripts/           run the pipeline locally, and a syntax check
```

Each stage is a separate function with a clear input and output. Collector returns a
snapshot, delta returns flags, renderer returns a report. That separation is what makes it
testable, and it is why the tests need no network and no credentials.

---

## Run it locally

```bash
npm install
npm test                    # 117 tests. no network, no keys.
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

1. **Create the `Task Owner` field** in ClickUp (a user-type field on the sprint list).
   It does not exist. Until it does, the whole ownership model is inert and the readout
   says so in one line.
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
| **Sprint** | The week's commitment: every open ticket, grouped by person or by what it waits on, worst first. Each shows its status, how long it has sat there, its rock, what it is waiting on, and the last ClickUp comment with who said it and when. "Waiting on" is worked out in order: someone you marked waiting on, then someone the last comment @mentions, then a stall, then the status read as a stage (QA, deploy, to start). Done this week (tickets in "done (this sprint)", never "complete") and what changed sit collapsed below. |
| **Rocks** | Planning by month. Each rock sits under its target month, set right on the card, with the sprint and backlog tickets that reach it through its Big Swing, Ready ones first. A rock with nothing planned says so. Opens with *Before sprint planning*, and ends with the backlog that ladders up to no rock. `#rocks/<id>` opens one. |
| **Next steps** | At the top of the Sprint tab: every ticket check that ends in something you do, under four actions. **Reply**: someone @mentioned you; you own it and it sits in QA or ready for deploy; you own a stalled or stuck ticket. **Nudge**: a question to someone else unanswered 2+ days; sent back from QA or deploy in the last 3 days; due within 2 days and not started; stalled or stuck in its status. **Decide**: overdue; Wednesday onward and still not started (per person); carried over from before this sprint (per person); 3+ in progress at once; a rock due this month with nothing in progress; a rock with no sprint ticket. **Fix**: no assignee; no owner; no Big Swing; in progress with no due date (once 3+ open tickets have one). Same buttons as the readout. Rules live in `src/delta/next-steps.js`; thresholds can be set under `clickup.nextSteps` in `config/clickup.json`. |
| **Who to ask** | Every sprint ticket names who to reach out to. The Task Owner keeps a ticket moving and is who you go to with questions; the assignee does the work in the current stage. In order: someone the ticket is waiting on (marked by you, or @mentioned in the last comment); "Reply to" whoever @mentioned you; the owner; and, when you own it or nobody does, the assignee. The Sprint tab groups by owner or by assignee. |
| **1:1** | One person: talking points to copy, their rocks and target months, each sprint ticket with what it waits on, what is queued for them in the backlog, done this week, tests they own, and open flags. `#people/<clickup id>` links to a person. |
| **Update** | The daily update, ready to paste: every sprint ticket touched since the start of the previous working day (updated, closed or commented on) in to do, in progress, QA, VQA, ready for deploy or done (this sprint). Complete tickets are left out. Grouped under `**Big Swing**`, one ticket per line: `@Name – Status – Title – last update: MM/DD`, or `✅ @Name – Title – done MM/DD` for done (this sprint). The @name is whoever is doing it (assignee, else owner): their `handle` in `config/people.json`, else their first name. Untick a ticket to leave it out. |
| **Accomplishments** | Every sprint ticket in complete or done (this sprint) over the last 30 days (or 7), by the date it was done, in the same format, newest first. |
| **Ideation** | Every sprint ticket except complete: successful, unsuccessful or too early to call, the root cause of why with the evidence it rests on, and three other ways to approach it. On a button press it reads each ticket's description and comment thread from ClickUp (read only), the Intelligems tests and the rocks, and makes one Claude call (`skills/ideation/SKILL.md`). The answer is stored and shown until the next run. |

The menu (☰) holds the rest:

| Where | What it is for |
|---|---|
| **Daily readout** | Today's 3, the week in review, store numbers, and every flag to triage: Done, Snooze, Waiting on, Not a problem, Draft a nudge, and quick fixes on rock flags. |
| **Tests** | Each test's readout, with the 12 month value projection. `#tests/<experience id>` opens one. |
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

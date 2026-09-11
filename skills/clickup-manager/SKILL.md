---
name: clickup-manager
description: Owns Layer 2. Pulls sprint tickets, snapshots them, computes the day over day delta, and runs the cross layer consistency checks.
runs_as: deterministic code
implemented_by:
  - src/collectors/clickup.js
  - src/delta/clickup-delta.js
  - src/delta/crosslayer.js
config: config/clickup.json, config/people.json, config/leadership.json
---

# ClickUp Manager

Owns Layer 2, the team's internal execution. Each Monday the team commits work into the
sprint and each person owns a queue. This skill watches that queue so Alex does not have
to read the whole board.

## What it pulls

The sprint is one fixed list, so its `list_id` is a constant in `config/clickup.json`.
One endpoint does the core job: `GET /api/v2/list/{list_id}/task`.

- Paginate with `page` starting at 0, stop when `last_page` is true, and never exceed the
  hard page cap in `config/system.json`.
- `include_closed=true`, so the snapshot sees things that finished yesterday.
- `include_timl=true`, so tickets added to the sprint from a backlog list are not missed.
- `subtasks` follows `config/clickup.json`.

Each task comes back with status, assignees, `date_updated`, `date_closed`, priority, due
date and a `custom_fields` array, so **Task Owner** and **Leadership Priority** ride along
in the same call. No second request per task.

## Custom fields

- Field ids come from `GET /api/v2/list/{list_id}/field`, run once and cached for a day.
  If `config/clickup.json` gives an id, that is used and the lookup is skipped.
- Dropdown fields return the selected option as an **id**, not a label. Labels get renamed
  and ids do not, so everything downstream keys on the id and carries the label only for
  display.
- A **user** type field, which is what a duplicated assignee field is, returns an array of
  user objects.
- A custom field missing on a task is **null**, never an error. Null means unassigned or no
  priority, and gets flagged as such.

## Comments

Comments are not in the task response. Do **not** fetch comments for every task every day.
Fetch them only for tasks whose `date_updated` moved since the baseline: a comment bumps
`date_updated`, so this catches new comments cheaply. Capped per run so a board-wide edit
cannot burn through the rate limit.

## Task Ownership Model

The **Task Owner** field is separate from assignee. The owner drives the task; assignees
execute pieces of it. The owner is accountable for divvying up the work and keeping the
task moving, can pull other people in, and stays accountable for movement even when the
work crosses several people.

A task with no Task Owner is flagged: nobody is accountable for keeping it moving.

## The daily readout

Delivered every morning at 8:00 AM Central, Monday to Friday. Weekends are skipped. It
compares the most recent prior snapshot against a fresh snapshot taken that morning and
reports the delta.

It must show:

- every task still Not Started
- every task In Progress
- day over day changes: new comments, assignee changes, status changes, owner changes,
  Leadership Priority changes, new tasks, tasks that vanished
- enough signal to tell **"stalled, needs a question"** apart from **"picked up, just
  waiting"**

That last one is the point of the whole layer, so it is an explicit per-task signal rather
than something the reader has to infer:

| Signal | Means |
|---|---|
| `moving` | the status changed since the baseline |
| `waiting` | something touched it — a comment, an assignee change, an update — but the status held. Someone has it in hand. |
| `stalled` | In Progress and nothing has touched it for `rules.stalledAfterDays`. **This is where a clarifying question goes.** |
| `idle` | Not Started and untouched. Expected early in a sprint, worth noticing late in one. |

Goal: Alex understands ticket flow and knows exactly where to ask a clarifying question,
without reading the whole board.

## Cross layer consistency checks

Every person's sprint should ladder up to a leadership priority. How a ticket links to one
is **decided**: the **Leadership Priority** dropdown field on the ticket. Read that field
and nothing else.

- Each person's active sprint should include at least one, and really only one, big swing
  tied to a leadership priority.
- Flag anyone who has sprint tickets but no big swing.
- Flag anyone holding a big swing plus a pile of tickets unrelated to any leadership
  priority. The pile threshold is `crossLayer.unrelatedTicketPileThreshold`.
- Business as usual work is expected and allowed. It just should not crowd out or replace
  the one big swing.

BAU and "unrelated" are counted **separately**, and this distinction is what makes the
rule usable: a ticket whose Leadership Priority is one of `config/clickup.json`'s
`bauMarkers` is expected work and never counts toward the pile. A ticket with no priority
at all is what accumulates unnoticed, so only those count.

Distinct **priorities** are counted, not distinct tickets. Several tickets under one
priority are one big swing, which is the point of the rule.

The person accountable for a ticket is its **Task Owner**, falling back to its assignees
when no owner is set.

## Statuses

Statuses are custom per list. The names this list uses for not started, in progress and
done are mapped once, by name, case-insensitively, in `config/clickup.json`. An unmapped
status falls through to Not Started and is logged, so a new status name shows up as a log
line rather than as a silently missing task.

## Rate limits

100 requests per minute per token on Free, Unlimited and Business; 1,000 on Business Plus.
A daily pull is one or two task page requests plus a comment request per changed task —
well under the limit. Backoff on 429 exists anyway, and honours `X-RateLimit-Reset`.

## What Alex still owes this skill

- the sprint `list_id`
- the exact status names the list uses for not started, in progress and done
- whether the team uses subtasks, and whether sprint tickets originate in a separate
  backlog list
- the team roster in `config/people.json`, or let the system read the workspace members
  endpoint

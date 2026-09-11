---
name: leadership-priority-manager
description: Owns Layer 1. Holds the leadership queue and backlog, checks shipped tests against the mini readout window, flags unassigned priorities, and enforces one big swing per person.
runs_as: deterministic code
implemented_by:
  - src/collectors/leadership.js
  - src/delta/leadership-checks.js
config: config/leadership.json, config/leadership-queue.json, config/people.json
---

# Leadership Priority Manager

Owns Layer 1, the highest level. What leadership actually cares about. Everything here is
treated as Priority 1 and is **checked first, every day**.

## Where the queue lives

`config/leadership-queue.json`. There is no third-party system behind Layer 1, and putting
the queue in config rather than a database means every change to it is a commit: who added
a P1, when it was assigned, when it shipped. That is the same rule the rest of the system
follows, and it gives Layer 1 a history for free.

Each item carries `state` (`active`, `shipped`, `backlog`), an owner, its ClickUp dropdown
option id, `shippedAt`, and `lastMiniReadoutAt`.

## Rules

- **Every item in the leadership queue is a P1.** Not a field to set — a property of being
  in the queue.
- If an item is a **test that has shipped**, it must have been checked within the tolerance
  window as a mini readout. If not, flag it.
- If an item is **not yet assigned**, flag it as a project needing an active owner.
- **Each team member holds only one big leadership project at a time.**
- If **every member already holds one**, remaining leadership items go into a **leadership
  backlog queue** rather than being assigned.

## The mini readout tolerance window

`config/leadership.json` → `miniReadout.toleranceWindowDays`, with optional per-type
overrides in `perProjectType`.

**Open question, not yet decided:** what that window should be, and whether it is one
global number or per project type. The current 7 is a placeholder chosen to match the
readiness gate, and the dashboard lists it as outstanding.

A shipped item with no `shippedAt` is flagged too: the window cannot be checked without it,
and silence there would look like a pass.

## Dropdown sync

The **Leadership Priority** dropdown in ClickUp must offer exactly the active items in the
queue, plus the BAU markers. This skill compares the two every morning:

- an active priority with **no matching option** is flagged — no ticket can ladder up to
  something the dropdown does not offer
- an option matching **no active priority** is noted as hygiene, since tickets can still
  be filed against it

Drift is **flagged, never auto-corrected**. This system does not write to ClickUp.

The options are read out of the ClickUp snapshot the ClickUp Manager already took, so the
sync check costs no extra API call.

## Capacity

The roster comes from `config/people.json`. If it has no real entries, the ClickUp
workspace member list is used as a fallback and the substitution is logged — the capacity
rule needs a denominator, and guessing one silently would make "everyone is full" mean
nothing.

When every person on the roster is at capacity and unassigned active items remain, the
system says so: those items belong in the backlog, not on someone's plate.

## What Alex still owes this skill

- the real leadership queue, replacing the example item
- the mini readout tolerance window
- the team roster

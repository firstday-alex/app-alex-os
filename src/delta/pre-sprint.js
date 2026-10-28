// Before sprint planning. The backlog tickets marked Ready to Start = Ready are the pool
// for the next sprint; this checks that pool against the rocks while it is still cheap
// to change, rather than finding the gaps after the sprint has started.
//
// Three questions, each a list a planner can act on:
//   people        does each person get a big swing tied to a live rock, from the pool or
//                 carried over in the current sprint
//   rocks         does every active rock have work queued, in the pool or still open
//   tickets       which Ready tickets ladder up to nothing, or have nobody on them
//
// Planning information, not flags: it is shown on the Sprint view and in the Friday
// roll-up, not raised in the daily readout. Read only.

import { accountableFor } from "./crosslayer.js";
import { ownsSwing } from "../collectors/leadership.js";

export function preSprintCheck({ backlogReady, sprintTasks = [], leadership, config, error = null }) {
  if (!Array.isArray(backlogReady)) {
    return { available: false, reason: error ?? "the backlog's Ready tickets were not collected" };
  }

  const bau = (config.clickup.bauMarkers ?? []).map((m) => String(m).trim().toLowerCase());
  const isBau = (t) => [t.leadershipPriority?.label, t.bigSwing?.label].some((l) => l && bau.includes(String(l).trim().toLowerCase()));

  const activeRocks = (leadership?.queue ?? []).filter((r) => r.state === "active");
  const rockFor = (task) => {
    const swing = task.bigSwing;
    if (!swing?.optionId) return null;
    return (
      activeRocks.find((r) => ownsSwing(r, swing.optionId)) ??
      activeRocks.find((r) => String(r.title).trim().toLowerCase() === String(swing.label ?? "").trim().toLowerCase()) ??
      null
    );
  };

  const pool = backlogReady.filter((t) => t.bucket !== "done");
  const openSprint = sprintTasks.filter((t) => t.bucket !== "done");
  const brief = (t) => ({ id: t.id, name: t.name, url: t.url, swing: t.bigSwing?.label ?? null });

  // Per person: what the pool gives them, and what they carry over.
  const roster = (config.people?.team ?? []).filter((p) => p.clickupUserId != null && p.countsTowardCapacity !== false);
  const people = new Map(roster.map((p) => [String(p.clickupUserId), { id: String(p.clickupUserId), name: p.name, ready: 0, rocks: new Set(), carryover: new Set() }]));
  const seed = (who) => {
    if (!people.has(who.id)) people.set(who.id, { id: who.id, name: who.name, ready: 0, rocks: new Set(), carryover: new Set(), offRoster: true });
    return people.get(who.id);
  };
  for (const t of pool) {
    const rock = isBau(t) ? null : rockFor(t);
    for (const who of accountableFor(t)) {
      const row = seed(who);
      row.ready += 1;
      if (rock) row.rocks.add(rock.title);
    }
  }
  for (const t of openSprint) {
    const rock = isBau(t) ? null : rockFor(t);
    if (!rock) continue;
    for (const who of accountableFor(t)) if (people.has(who.id)) people.get(who.id).carryover.add(rock.title);
  }
  const peopleOut = [...people.values()]
    .map((p) => ({ id: p.id, name: p.name, ready: p.ready, rocks: [...p.rocks], carryover: [...p.carryover], offRoster: Boolean(p.offRoster), noBigSwing: p.rocks.size === 0 && p.carryover.size === 0 }))
    .sort((a, b) => Number(b.noBigSwing) - Number(a.noBigSwing) || String(a.name).localeCompare(String(b.name)));

  // Per rock: anything queued or still open on it.
  const touches = (rock) => (t) => rockFor(t)?.id === rock.id && !isBau(t);
  const rocks = activeRocks.map((rock) => ({
    id: rock.id,
    title: rock.title,
    owner: rock.owner?.name ?? null,
    ready: pool.filter(touches(rock)).length,
    open: openSprint.filter(touches(rock)).length,
  }));

  return {
    available: true,
    readyCount: pool.length,
    people: peopleOut,
    rocks,
    unqueuedRocks: rocks.filter((r) => r.ready === 0 && r.open === 0),
    noSwing: pool.filter((t) => !isBau(t) && !t.bigSwing?.optionId).map(brief),
    unclaimedSwing: pool.filter((t) => !isBau(t) && t.bigSwing?.optionId && !rockFor(t)).map(brief),
    unowned: pool.filter((t) => accountableFor(t).length === 0).map(brief),
  };
}

// Cross layer consistency. The three layers must tie together.
//
// Every person's sprint should ladder up to a leadership priority. The system flags when
// it does not:
//   - at least one, and really only one, big swing tied to a leadership priority
//   - flag anyone with sprint tickets but no big swing
//   - flag anyone holding a big swing plus a pile of tickets unrelated to any leadership
//     priority
//
// Business as usual work is expected and allowed. It just should not crowd out or replace
// the big swing. That is why BAU and "unrelated" are counted separately: a ticket marked
// BAU in the Leadership Priority dropdown is expected, and a ticket tied to no rock is
// what piles up unnoticed.
//
// How a ticket links to a rock is DECIDED: the Big Swing dropdown field on the ticket,
// matched to the Big Swing option on the rock. Alex set this on 2026-10-19. The
// Leadership Priority field is read for one thing only, the BAU marker.

import { makeFlag } from "./flags.js";

/** The person accountable for a ticket: the Task Owner field, falling back to assignees. */
export function accountableFor(task) {
  if (task.taskOwners?.length) return task.taskOwners.map((u) => ({ id: String(u.id), name: u.username ?? u.id, via: "owner" }));
  if (task.assignees?.length) return task.assignees.map((u) => ({ id: String(u.id), name: u.username ?? u.id, via: "assignee" }));
  return [];
}

/**
 * What a ticket is, for the purposes of the big swing rule.
 *
 * The Big Swing field says which project a ticket belongs to, and a rock claims a big
 * swing through its own Big Swing option. That is the whole link. A ticket with no Big
 * Swing is tied to no rock, whatever its Leadership Priority says, except that a BAU
 * marker there makes it expected work.
 */
export function classifyTicketLink(task, { activeTitles, activeBigSwingIds, bauMarkers }) {
  const priority = task.leadershipPriority;
  const swing = task.bigSwing;
  const priorityLabel = String(priority?.label ?? "").toLowerCase();

  // BAU is expected work and is never a big swing, however it is tagged, and it can be
  // tagged in either field: the Big Swing dropdown carries a BAU option too.
  if (priority && bauMarkers.includes(priorityLabel)) {
    return { link: "bau", label: priority.label };
  }
  if (swing && bauMarkers.includes(String(swing.label ?? "").trim().toLowerCase())) {
    return { link: "bau", label: swing.label };
  }

  if (!swing?.optionId) return { link: "none", label: priority?.label ?? null };

  const swingLabel = String(swing.label ?? "").toLowerCase();
  const byId = activeBigSwingIds.has(String(swing.optionId));
  // A title match is a fallback for a rock whose Big Swing option is not set yet. It fails
  // silently the next time someone renames the option, so the readout says when a link
  // is resting on one rather than waiting for it to vanish.
  const byTitle = !byId && swingLabel && activeTitles.has(swingLabel);
  return {
    link: "bigSwing",
    swing: swing.label ?? swing.optionId,
    swingId: swing.optionId,
    label: byId || byTitle ? swing.label ?? null : null,
    // Named a big swing, but no active rock claims it. Real work on a real project that
    // nothing at leadership level is currently tracking.
    untethered: !byId && !byTitle,
    linkedBy: byId ? "id" : byTitle ? "title" : null,
  };
}

export function crossLayerCheck({ clickupDelta, leadership, config, dateKey }) {
  const lc = config.leadership.crossLayer ?? {};
  const bauMarkers = (config.clickup.bauMarkers ?? []).map((s) => s.toLowerCase());

  const activeItems = (leadership.queue ?? []).filter((i) => i.state === "active");
  // Which rocks claim tickets: active ones, and shipped ones, whose follow-up work is
  // still tracked through the mini readout. Only a backlog rock claims nothing.
  const claimingItems = (leadership.queue ?? []).filter((i) => i.state === "active" || i.state === "shipped");
  // The Big Swing option id is the real link. Matching on title is a fallback for a rock
  // that has not been linked yet, and it breaks the moment somebody renames the option.
  const activeTitles = new Set(claimingItems.map((i) => String(i.title).trim().toLowerCase()));
  const activeBigSwingIds = new Set(claimingItems.map((i) => i.clickupBigSwingOptionId).filter(Boolean).map(String));

  // For an unclaimed big swing, the rock it would have matched if that rock were live, so
  // the readout can say "its rock is in the backlog" rather than "nothing tracks this".
  const parked = [...(leadership.backlog ?? []), ...(leadership.queue ?? []).filter((i) => i.state === "backlog")];
  const parkedRockFor = (ref) =>
    parked.find(
      (i) =>
        (ref.swingId && i.clickupBigSwingOptionId && String(i.clickupBigSwingOptionId) === String(ref.swingId)) ||
        String(i.title).trim().toLowerCase() === String(ref.swing ?? "").trim().toLowerCase(),
    ) ?? null;

  const openTasks = (clickupDelta.tasks ?? []).filter((t) => t.bucket !== "done");

  /** person id -> tallies */
  const people = new Map();
  const seed = (person) => {
    if (!people.has(person.id)) {
      people.set(person.id, {
        id: person.id,
        name: person.name,
        bigSwings: [],
        bauTickets: [],
        unrelatedTickets: [],
        untetheredSwings: [],
        totalTickets: 0,
      });
    }
    return people.get(person.id);
  };

  // Everyone on the roster appears, even with an empty sprint, so "has tickets but no big
  // swing" and "has nothing at all" stay distinguishable.
  for (const member of leadership.roster ?? []) {
    seed({ id: String(member.clickupUserId), name: member.name });
  }

  for (const task of openTasks) {
    const link = classifyTicketLink(task, { activeTitles, activeBigSwingIds, bauMarkers });
    const accountable = accountableFor(task);
    if (accountable.length === 0) continue; // no owner and no assignee: Layer 2's problem, not this check's

    for (const person of accountable) {
      const row = seed(person);
      row.totalTickets += 1;
      const ref = {
        id: task.id, name: task.name, url: task.url, status: task.status,
        priorityLabel: link.label ?? null,
        swing: link.swing ?? null, swingId: link.swingId ?? null,
        linkedBy: link.linkedBy ?? null,
      };
      if (link.link === "bigSwing") {
        row.bigSwings.push(ref);
        if (link.untethered) row.untetheredSwings.push(ref);
      } else if (link.link === "bau") row.bauTickets.push(ref);
      else row.unrelatedTickets.push(ref);
    }
  }

  const flags = [];
  const add = (spec) => flags.push(makeFlag(spec, { dateKey }));
  const pile = lc.unrelatedTicketPileThreshold ?? 5;

  // Links resting on a title match rather than an option id. These work until somebody
  // renames the dropdown option in ClickUp, at which point they stop working silently
  // and the tickets look like work that ladders up to nothing. Said once, with the rocks
  // to fix, rather than once per ticket.
  const onTitle = new Set();
  for (const row of people.values()) {
    for (const ref of row.bigSwings) if (ref.linkedBy === "title" && ref.priorityLabel) onTitle.add(ref.priorityLabel);
  }
  if (onTitle.size) {
    add({
      id: "crosslayer.linked_by_title",
      layer: "cross",
      severity: "info",
      rule: "crosslayer.linked_by_title",
      message: `${onTitle.size === 1 ? "One rock is" : `${onTitle.size} rocks are`} linked to ClickUp by matching title rather than by Big Swing option: ${[...onTitle].join(", ")}. That match breaks the moment the Big Swing option is renamed. Set the Big Swing on ${onTitle.size === 1 ? "the rock" : "those rocks"} to make the link survive a rename.`,
    });
  }

  for (const row of people.values()) {
    // Distinct big swings, not distinct tickets. Several tickets on one project are one
    // big swing, which is the point of the rule. Fall back to the rock label for a
    // ticket that names a priority but no Big Swing.
    const distinctSwings = new Set(row.bigSwings.map((t) => t.swingId ?? t.swing ?? t.priorityLabel ?? t.id));
    row.distinctBigSwings = distinctSwings.size;

    if (lc.requireOneBigSwingPerPerson !== false) {
      if (row.totalTickets > 0 && distinctSwings.size === 0) {
        add({
          layer: "cross",
          rule: "crosslayer.no_big_swing",
          severity: "p1",
          subject: { type: "person", id: row.id, label: row.name },
          message: `${row.name} has ${row.totalTickets} open sprint ticket(s) but none tied to a live leadership priority. There is no big swing in their sprint.`,
          values: { totalTickets: row.totalTickets, bau: row.bauTickets.length, unrelated: row.unrelatedTickets.length },
        });
      }
      // No cap on how many big swings a person carries in the sprint. Alex removed that
      // rule for everyone on 2026-10-19; the cap on rocks a person owns still applies.
    }

    // A big swing plus a pile of unrelated tickets. BAU does not count toward the pile:
    // it is expected work. Only tickets tied to no priority at all do.
    if (distinctSwings.size >= 1 && row.unrelatedTickets.length >= pile) {
      add({
        layer: "cross",
        rule: "crosslayer.unrelated_pile",
        severity: "attention",
        subject: { type: "person", id: row.id, label: row.name },
        message: `${row.name} holds a big swing plus ${row.unrelatedTickets.length} tickets tied to no leadership priority and not marked business as usual. That is enough to crowd out the big swing.`,
        values: {
          bigSwings: [...distinctSwings],
          unrelatedCount: row.unrelatedTickets.length,
          threshold: pile,
          bauCount: row.bauTickets.length,
          unrelated: row.unrelatedTickets.slice(0, 10).map((t) => t.name),
        },
      });
    }

    if (row.untetheredSwings.length > 0) {
      const swings = [...new Set(row.untetheredSwings.map((t) => t.swing))];
      // Say why each is unclaimed: a rock that exists but is in the backlog is a different
      // fix from a big swing no rock names at all.
      const why = swings.map((swing) => {
        const rock = parkedRockFor(row.untetheredSwings.find((t) => t.swing === swing));
        return rock ? `"${swing}" (its rock "${rock.title}" is in the backlog)` : `"${swing}"`;
      });
      add({
        layer: "cross",
        rule: "crosslayer.big_swing_without_rock",
        severity: "attention",
        subject: { type: "person", id: `${row.id}:untethered`, label: row.name },
        message: `${row.name} is working on ${why.join(", ")}, which no active or shipped rock claims. Link the rock's Big Swing to it, or bring the rock out of the backlog, so the work is tracked.`,
        values: { swings, tickets: row.untetheredSwings.length },
      });
    }
  }

  // A leadership priority nobody is actually working on. The queue says it is active and
  // owned, but no open ticket ladders up to it.
  const laddered = new Set();
  for (const row of people.values()) {
    for (const swing of row.bigSwings) if (swing.priorityLabel) laddered.add(String(swing.priorityLabel).toLowerCase());
  }
  for (const item of activeItems) {
    // Worked on means an open ticket names the rock's Big Swing, or, for a rock with no
    // Big Swing set yet, names a Big Swing with the rock's title.
    const hit =
      laddered.has(String(item.title).toLowerCase()) ||
      openTasks.some((t) => t.bigSwing?.optionId && item.clickupBigSwingOptionId && String(t.bigSwing.optionId) === String(item.clickupBigSwingOptionId));
    if (!hit) {
      add({
        layer: "cross",
        rule: "crosslayer.priority_without_work",
        severity: "attention",
        subject: { type: "priority", id: item.id, label: item.title },
        message: `"${item.title}" is an active leadership priority with no open sprint ticket pointing at it.`,
        values: { owner: item.owner?.name ?? null, state: item.state },
      });
    }
  }

  return {
    flags,
    people: [...people.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    summary: {
      peopleChecked: people.size,
      withBigSwing: [...people.values()].filter((p) => p.distinctBigSwings >= 1).length,
      withoutBigSwing: [...people.values()].filter((p) => p.totalTickets > 0 && p.distinctBigSwings === 0).length,
    },
  };
}

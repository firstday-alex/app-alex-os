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
// the one big swing. That is why BAU and "unrelated" are counted separately: a ticket
// marked BAU in the Leadership Priority dropdown is expected, and a ticket with no
// priority at all is what piles up unnoticed.
//
// How a ticket links to a leadership priority is DECIDED: the Leadership Priority
// dropdown field on the ticket. We read that field and nothing else.

import { makeFlag } from "./flags.js";

/** The person accountable for a ticket: the Task Owner field, falling back to assignees. */
export function accountableFor(task) {
  if (task.taskOwners?.length) return task.taskOwners.map((u) => ({ id: String(u.id), name: u.username ?? u.id, via: "owner" }));
  if (task.assignees?.length) return task.assignees.map((u) => ({ id: String(u.id), name: u.username ?? u.id, via: "assignee" }));
  return [];
}

export function classifyTicketLink(task, { activeOptionIds, activeTitles, bauMarkers }) {
  const priority = task.leadershipPriority;
  if (!priority) return { link: "none" };

  const label = String(priority.label ?? "").toLowerCase();
  if (bauMarkers.includes(label)) return { link: "bau", label: priority.label };

  const byId = priority.optionId && activeOptionIds.has(String(priority.optionId));
  const byLabel = label && activeTitles.has(label);
  if (byId || byLabel) return { link: "leadership", label: priority.label, optionId: priority.optionId };

  // A priority is set but it matches no ACTIVE leadership item. Either the item shipped
  // or moved to the backlog, or the dropdown has drifted. Either way the ticket is not
  // laddering up to a live priority today.
  return { link: "stale", label: priority.label, optionId: priority.optionId };
}

export function crossLayerCheck({ clickupDelta, leadership, config, dateKey }) {
  const lc = config.leadership.crossLayer ?? {};
  const bauMarkers = (config.clickup.bauMarkers ?? []).map((s) => s.toLowerCase());

  const activeItems = (leadership.queue ?? []).filter((i) => i.state === "active");
  // The option id is the real link. Matching on title is a fallback for a rock that has
  // not been linked yet, and it breaks the moment somebody renames the dropdown option.
  const activeOptionIds = new Set(activeItems.map((i) => i.clickupOptionId).filter(Boolean).map(String));
  const activeTitles = new Set(activeItems.map((i) => String(i.title).toLowerCase()));

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
        staleTickets: [],
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
    const link = classifyTicketLink(task, { activeOptionIds, activeTitles, bauMarkers });
    const accountable = accountableFor(task);
    if (accountable.length === 0) continue; // no owner and no assignee: Layer 2's problem, not this check's

    for (const person of accountable) {
      const row = seed(person);
      row.totalTickets += 1;
      const ref = { id: task.id, name: task.name, url: task.url, status: task.status, priorityLabel: link.label ?? null };
      if (link.link === "leadership") row.bigSwings.push(ref);
      else if (link.link === "bau") row.bauTickets.push(ref);
      else if (link.link === "stale") row.staleTickets.push(ref);
      else row.unrelatedTickets.push(ref);
    }
  }

  const flags = [];
  const add = (spec) => flags.push(makeFlag(spec, { dateKey }));
  const pile = lc.unrelatedTicketPileThreshold ?? 5;

  for (const row of people.values()) {
    // Distinct leadership priorities, not distinct tickets. Several tickets under one
    // priority are one big swing, which is the point of the rule.
    const distinctSwings = new Set(row.bigSwings.map((t) => t.priorityLabel ?? t.id));
    row.distinctBigSwings = distinctSwings.size;

    if (lc.requireOneBigSwingPerPerson !== false) {
      if (row.totalTickets > 0 && distinctSwings.size === 0) {
        add({
          layer: "cross",
          rule: "crosslayer.no_big_swing",
          severity: "p1",
          subject: { type: "person", id: row.id, label: row.name },
          message: `${row.name} has ${row.totalTickets} open sprint ticket(s) but none tied to a live leadership priority. There is no big swing in their sprint.`,
          values: { totalTickets: row.totalTickets, bau: row.bauTickets.length, unrelated: row.unrelatedTickets.length, stale: row.staleTickets.length },
        });
      }

      if (distinctSwings.size > 1) {
        add({
          layer: "cross",
          rule: "crosslayer.multiple_big_swings",
          severity: "p1",
          subject: { type: "person", id: row.id, label: row.name },
          message: `${row.name} is carrying ${distinctSwings.size} big swings at once. The rule is one at a time.`,
          values: { priorities: [...distinctSwings], ticketCount: row.bigSwings.length },
        });
      }
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

    if (row.staleTickets.length > 0) {
      add({
        layer: "cross",
        rule: "crosslayer.stale_priority_link",
        severity: "info",
        advisable: false,
        subject: { type: "person", id: `${row.id}:stale`, label: row.name },
        message: `${row.name} has ${row.staleTickets.length} ticket(s) pointing at a leadership priority that is no longer active.`,
        values: { tickets: row.staleTickets.slice(0, 10).map((t) => ({ name: t.name, priority: t.priorityLabel })) },
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
    const hit =
      laddered.has(String(item.title).toLowerCase()) ||
      openTasks.some((t) => t.leadershipPriority?.optionId && item.clickupOptionId && String(t.leadershipPriority.optionId) === String(item.clickupOptionId));
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
      overloaded: [...people.values()].filter((p) => p.distinctBigSwings > 1).length,
    },
  };
}

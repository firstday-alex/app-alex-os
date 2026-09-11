// Layer 1. The highest level. Checked first, every day.
//
// Rules, straight from the spec:
//   - Every item in the leadership queue is a P1.
//   - A shipped test must have been checked within the tolerance window as a mini
//     readout. If not, flag it.
//   - An unassigned item is flagged as a project needing an active owner.
//   - Each team member holds only one big leadership project at a time.
//   - When every member already holds one, remaining items belong in the backlog rather
//     than being assigned.

import { makeFlag } from "./flags.js";
import { daysBetween } from "../lib/time.js";

function toleranceFor(item, leadershipConfig) {
  const perType = leadershipConfig.miniReadout?.perProjectType ?? {};
  if (item.type && perType[item.type] != null) return perType[item.type];
  return leadershipConfig.miniReadout?.toleranceWindowDays ?? 7;
}

export function leadershipChecks({ leadership, clickup = null, config, dateKey, nowIso }) {
  const flags = [];
  const lc = config.leadership;
  const queue = leadership.queue ?? [];
  const backlog = leadership.backlog ?? [];
  const roster = leadership.roster ?? [];

  const add = (spec) => flags.push(makeFlag(spec, { dateKey }));

  /* --- shipped tests owe a mini readout inside the tolerance window --- */
  for (const item of queue.filter((i) => i.state === "shipped")) {
    const tolerance = toleranceFor(item, lc);
    const since = daysBetween(item.lastMiniReadoutAt ?? item.shippedAt, nowIso);

    if (!item.shippedAt) {
      add({
        layer: 1,
        rule: "leadership.shipped_without_date",
        severity: "attention",
        subject: { type: "priority", id: item.id, label: item.title },
        message: `"${item.title}" is marked shipped but carries no shipped date, so the mini readout window cannot be checked.`,
        values: { state: item.state },
      });
      continue;
    }

    if (since == null) {
      add({
        layer: 1,
        rule: "leadership.mini_readout_unknown",
        severity: "attention",
        subject: { type: "priority", id: item.id, label: item.title },
        message: `"${item.title}" shipped but has never had a mini readout recorded.`,
        values: { shippedAt: item.shippedAt, toleranceWindowDays: tolerance },
      });
    } else if (since > tolerance) {
      add({
        layer: 1,
        rule: "leadership.mini_readout_overdue",
        severity: "p1",
        subject: { type: "priority", id: item.id, label: item.title },
        message: `"${item.title}" shipped and was last checked ${since} days ago. The tolerance window is ${tolerance} days.`,
        values: { daysSinceLastCheck: since, toleranceWindowDays: tolerance, lastMiniReadoutAt: item.lastMiniReadoutAt, shippedAt: item.shippedAt },
      });
    }
  }

  /* --- unassigned P1s need an active owner --- */
  for (const item of queue.filter((i) => i.state === "active")) {
    if (!item.owner?.clickupUserId) {
      add({
        layer: 1,
        rule: "leadership.unassigned",
        severity: "p1",
        subject: { type: "priority", id: item.id, label: item.title },
        message: `"${item.title}" is an active leadership priority with no owner. It needs an active owner or it belongs in the backlog.`,
        values: { state: item.state, type: item.type },
      });
    }
  }

  /* --- one big leadership project per person, overflow goes to the backlog --- */
  const perPerson = new Map();
  for (const item of queue.filter((i) => i.state === "active" && i.owner?.clickupUserId)) {
    const key = item.owner.clickupUserId;
    if (!perPerson.has(key)) perPerson.set(key, { owner: item.owner, items: [] });
    perPerson.get(key).items.push(item);
  }

  const cap = lc.capacity?.bigSwingsPerPerson ?? 1;
  for (const { owner, items } of perPerson.values()) {
    if (items.length > cap) {
      add({
        layer: 1,
        rule: "leadership.over_capacity",
        severity: "p1",
        subject: { type: "person", id: owner.clickupUserId, label: owner.name },
        message: `${owner.name} holds ${items.length} active leadership priorities. The rule is ${cap} at a time. The extras belong in the leadership backlog.`,
        values: { held: items.map((i) => i.title), cap },
      });
    }
  }

  const peopleAtCapacity = [...perPerson.values()].filter((p) => p.items.length >= cap).length;
  const everyoneFull = roster.length > 0 && peopleAtCapacity >= roster.length;
  const unassignedActive = queue.filter((i) => i.state === "active" && !i.owner?.clickupUserId);

  if (everyoneFull && unassignedActive.length > 0) {
    add({
      layer: 1,
      rule: "leadership.should_be_backlogged",
      severity: "attention",
      subject: { type: "queue", id: "leadership-queue", label: "Leadership queue" },
      message: `Every one of the ${roster.length} team members already holds a big leadership project, so the ${unassignedActive.length} unassigned item(s) should sit in the leadership backlog rather than being assigned.`,
      values: { rosterSize: roster.length, peopleAtCapacity, unassigned: unassignedActive.map((i) => i.title) },
    });
  }

  /* --- the dropdown must match the live queue --- */
  if (lc.dropdownSync?.enforce && clickup) {
    const bauMarkers = (config.clickup.bauMarkers ?? []).map((s) => s.toLowerCase());
    const optionsById = new Map((leadership.dropdownOptions ?? []).map((o) => [String(o.id), o]));
    const optionLabels = new Set((leadership.dropdownOptions ?? []).map((o) => String(o.label).toLowerCase()));

    const missing = queue
      .filter((i) => i.state === "active")
      .filter((i) => (i.clickupOptionId ? !optionsById.has(i.clickupOptionId) : !optionLabels.has(String(i.title).toLowerCase())));

    if (missing.length) {
      add({
        layer: 1,
        rule: "leadership.dropdown_missing_option",
        severity: "attention",
        subject: { type: "field", id: "leadership-priority-field", label: "Leadership Priority dropdown" },
        message: `${missing.length} active leadership priority(ies) have no matching option in the ClickUp Leadership Priority dropdown, so no ticket can ladder up to them.`,
        values: { missing: missing.map((i) => i.title) },
      });
    }

    const queueLabels = new Set(queue.filter((i) => i.state === "active").map((i) => String(i.title).toLowerCase()));
    const queueOptionIds = new Set(queue.map((i) => i.clickupOptionId).filter(Boolean));
    const orphaned = (leadership.dropdownOptions ?? []).filter(
      (o) =>
        !queueOptionIds.has(String(o.id)) &&
        !queueLabels.has(String(o.label).toLowerCase()) &&
        !bauMarkers.includes(String(o.label).toLowerCase()),
    );

    if (orphaned.length) {
      add({
        layer: 1,
        rule: "leadership.dropdown_orphan_option",
        severity: "info",
        advisable: false,
        subject: { type: "field", id: "leadership-priority-field-orphans", label: "Leadership Priority dropdown" },
        message: `${orphaned.length} dropdown option(s) in ClickUp match no active leadership priority. Tickets can still be filed against them.`,
        values: { orphaned: orphaned.map((o) => o.label) },
      });
    }
  }

  return {
    flags,
    queue,
    backlog,
    roster,
    summary: {
      activeCount: queue.filter((i) => i.state === "active").length,
      shippedCount: queue.filter((i) => i.state === "shipped").length,
      backlogCount: backlog.length,
      unassignedCount: unassignedActive.length,
      peopleAtCapacity,
      rosterSize: roster.length,
      everyoneFull,
    },
  };
}

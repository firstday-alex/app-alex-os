// The Friday roll-up: the week, from what is already stored.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWeekly, weeklyLines } from "../src/delta/weekly.js";

const now = new Date("2026-10-23T13:00:00Z"); // a Friday
const daysAgo = (n) => new Date(now.getTime() - n * 86_400_000);

test("the week reads the rocks audit, the tickets closed, alignment against last week, and the flags", () => {
  const w = buildWeekly({
    now,
    audit: [
      { at: daysAgo(2).toISOString(), changes: [{ change: "updated", title: "Quiz", diff: { state: { from: "active", to: "shipped" } } }] },
      { at: daysAgo(3).toISOString(), changes: [{ change: "updated", title: "Mobile App", diff: { status: { from: "on_track", to: "at_risk" } } }] },
      { at: daysAgo(4).toISOString(), changes: [{ change: "created", title: "AB Testing" }] },
      { at: daysAgo(10).toISOString(), changes: [{ change: "updated", title: "Old", diff: { state: { from: "active", to: "shipped" } } }] },
    ],
    rocks: [
      { title: "Mobile App", state: "active", status: "at_risk" },
      { title: "AB Testing", state: "active", status: "on_track" },
    ],
    tasks: [
      { id: "t1", bucket: "done", dateClosed: daysAgo(1).getTime(), taskOwners: [{ id: "u1", username: "Robson" }], assignees: [] },
      { id: "t2", bucket: "done", dateClosed: daysAgo(2).getTime(), taskOwners: [{ id: "u1", username: "Robson" }], assignees: [] },
      { id: "t3", bucket: "done", dateClosed: daysAgo(12).getTime(), taskOwners: [{ id: "u2", username: "Blake" }], assignees: [] },
      { id: "t4", bucket: "inProgress", taskOwners: [{ id: "u2", username: "Blake" }], assignees: [] },
    ],
    cross: { withBigSwing: 4, withoutBigSwing: 1, peopleChecked: 5 },
    lastWeek: { dateKey: "2026-10-16", crossSummary: { withBigSwing: 2, withoutBigSwing: 3, peopleChecked: 5 } },
    ledgerEntries: {
      a: { triage: { status: "done", at: daysAgo(1).toISOString() } },
      b: { triage: { status: "dismissed", at: daysAgo(3).toISOString() } },
      c: { triage: { status: "done", at: daysAgo(20).toISOString() } },
      d: { triage: { status: "snoozed", at: daysAgo(1).toISOString() } },
    },
    flags: [
      { severity: "p1", rule: "x" },
      { severity: "attention", rule: "crosslayer.rock_work_stalled", subject: { label: "AB Testing" }, escalated: true },
      { severity: "prompt", rule: "intelligems.decision_due", subject: { label: "Sticky ATC" } },
    ],
    statusLabels: { on_track: "On Track", at_risk: "At Risk" },
  });

  assert.deepEqual(w.rocks.shipped, ["Quiz"], "a ship from ten days ago is last week's");
  assert.deepEqual(w.rocks.statusChanges, [{ title: "Mobile App", from: "On Track", to: "At Risk" }]);
  assert.deepEqual(w.rocks.created, ["AB Testing"]);
  assert.deepEqual(w.rocks.atRisk, ["Mobile App"]);
  assert.deepEqual(w.rocks.stalled, ["AB Testing"]);
  assert.equal(w.tickets.closed, 2);
  assert.deepEqual(w.tickets.byPerson, [{ name: "Robson", count: 2 }]);
  assert.equal(w.flags.handled, 2, "done and not-a-problem this week; a snooze is not handled");
  assert.deepEqual(w.tests.decisionsDue, ["Sticky ATC"]);

  const lines = weeklyLines(w).join("\n");
  assert.match(lines, /Shipped: "Quiz"\./);
  assert.match(lines, /Status changes: "Mobile App" On Track to At Risk\./);
  assert.match(lines, /2 ticket\(s\) closed: Robson 2\./);
  assert.match(lines, /Big swing on a live rock: 4 of 5 people \(a week ago 2 of 5\)\./);
  assert.match(lines, /Flags: 2 handled this week, 2 still open \(1 P1, 1 escalated\)\./);
  assert.match(lines, /Tests waiting on a decision: "Sticky ATC"\./);
});

test("with no history yet, the week still reads, without a comparison it cannot make", () => {
  const lines = weeklyLines(buildWeekly({ now, cross: { withBigSwing: 3, withoutBigSwing: 0, peopleChecked: 3 } })).join("\n");
  assert.match(lines, /0 ticket\(s\) closed\./);
  assert.match(lines, /Big swing on a live rock: 3 of 3 people\./);
  assert.ok(!lines.includes("a week ago"));
});

// Rocks off course, by the evidence; the Quarter plan; and assigning someone from the card.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rockCourse, placeTicket } from "../src/delta/rock-course.js";
import { quarterWeeks, weekStartOf, monthOfWeek } from "../public/quarter.js";
import { QuarterPlanStore } from "../src/store/quarter-plan.js";
import { createBackend } from "../src/lib/storage.js";
import { setAssignee } from "../src/send/clickup-assignee.js";

const rock = (over = {}) => ({
  id: "r1",
  title: "Bundles 2.0",
  state: "active",
  status: "on_track",
  statusColor: "green",
  owner: { name: "Blake Tucker" },
  clickupBigSwingOptionIds: ["s1"],
  clickupTacticOptionIds: [],
  milestones: [
    { month: "2026-10", deliverable: "Launch builder", done: true },
    { month: "2026-11", deliverable: "Upsell test live", done: false },
  ],
  tactics: [
    { id: "t1", title: "Builder", status: "on_track", checkInDate: "2026-12-01", clickupBigSwingOptionId: "s1" },
    { id: "t2", title: "Checkout upsell", status: "on_track", checkInDate: "2026-12-01", clickupBigSwingOptionId: "s2" },
  ],
  ...over,
});
const ticket = (over = {}) => ({ id: "k1", name: "Build it", bucket: "inProgress", idleDays: 1, bigSwing: { optionId: "s1", label: "Bundles" }, ...over });

test("weeks belong to the month their Thursday is in; Q4 2026 has 14", () => {
  const weeks = quarterWeeks("2026-Q4");
  assert.equal(weeks.length, 14);
  assert.deepEqual([weeks[0].start, weeks[0].month], ["2026-09-28", "2026-10"]);
  assert.deepEqual([weeks.at(-1).start, weeks.at(-1).month], ["2026-12-28", "2026-12"]);
  assert.equal(weekStartOf("2026-11-17"), "2026-11-16");
  assert.equal(monthOfWeek("2026-11-30"), "2026-12");
});

test("a green rock with work moving and nothing late is on course and raises nothing", () => {
  const out = rockCourse({ rocks: [rock()], tasks: [ticket()], dateKey: "2026-11-10" });
  assert.equal(out.rocks[0].course, "on");
  assert.equal(out.flags.length, 0);
});

test("marked On Track with nothing moving a quarter into the month is off course: a P1 that says why and what to decide", () => {
  const out = rockCourse({ rocks: [rock()], tasks: [ticket({ bucket: "notStarted", idleDays: 2 })], dateKey: "2026-11-17", alexName: "Alex Turney" });
  assert.equal(out.rocks[0].course, "off");
  const [f] = out.flags;
  assert.equal(f.severity, "p1");
  assert.equal(f.rule, "leadership.rock_off_course");
  assert.match(f.message, /^"Bundles 2\.0" is marked On Track, but looks off course: 57% of November is gone and nothing on this rock is moving toward "Upsell test live"\. Decide with Blake: put a ticket in progress this week, or move the milestone\.$/);
});

test("an earlier month's milestone not done, or half the tactics past check-in, is off course; Alex's own rock says Decide:", () => {
  const late = rock({ owner: { name: "Alex Turney" }, milestones: [{ month: "2026-10", deliverable: "Launch builder", done: false }] });
  const out = rockCourse({ rocks: [late], tasks: [ticket()], dateKey: "2026-11-05", alexName: "Alex Turney" });
  assert.match(out.flags[0].message, /October's milestone "Launch builder" is not done\. Decide: finish it/);

  const tactics = rock({ tactics: rock().tactics.map((t, i) => (i === 0 ? { ...t, checkInDate: "2026-11-02" } : t)) });
  const two = rockCourse({ rocks: [tactics], tasks: [ticket()], dateKey: "2026-11-05" });
  assert.match(two.flags[0].message, /1 of 2 tactics is past the check-in date: "Builder" \(3 days past Nov 2\)/);
  assert.equal(two.flags[0].severity, "p1");
  // Two days late is inside the grace: the standup is often a day behind.
  const grace = rockCourse({ rocks: [tactics], tasks: [ticket()], dateKey: "2026-11-04" });
  assert.equal(grace.flags.length, 0);
});

test("stalled work and slipped plan items make a rock drift: a P2 with every reason", () => {
  const out = rockCourse({
    rocks: [rock({ milestones: [] })],
    tasks: [ticket({ bucket: "inProgress", idleDays: 9 })],
    plan: [{ rockId: "r1", week: "2026-11-02", text: "Ship the upsell copy", done: false }],
    dateKey: "2026-11-10",
  });
  assert.equal(out.rocks[0].course, "drift");
  assert.equal(out.flags[0].severity, "attention");
  assert.match(out.flags[0].message, /none of its 1 open ticket has moved in 9 days.*1 planned item from earlier weeks not done: "Ship the upsell copy"/);
  // A ticket finished in the last week means the rock is moving after all.
  const moving = rockCourse({
    rocks: [rock({ milestones: [] })],
    tasks: [ticket({ idleDays: 9 })],
    history: [{ rockId: "r1", doneOn: "2026-11-08" }],
    dateKey: "2026-11-10",
  });
  assert.ok(!moving.rocks[0].signals.some((s) => s.kind === "work_stalled"));
});

test("an unlinked tactic is listed as something the check cannot see, never a reason on its own", () => {
  const blind = rock({ tactics: [{ id: "t9", title: "Untracked", status: "on_track", checkInDate: "2026-12-01" }] });
  const out = rockCourse({ rocks: [blind], tasks: [ticket()], dateKey: "2026-11-10" });
  assert.equal(out.rocks[0].course, "on");
  assert.equal(out.rocks[0].signals[0].level, "gap");
  assert.equal(out.flags.length, 0);
});

test("the course flag stands in for the rock's At Risk, stalled and due-not-moving flags", async () => {
  const { computeFlags } = await import("../src/delta/index.js");
  const { flags } = computeFlags({
    snapshots: {
      clickup: { items: [], fieldMap: {} },
      leadership: { queue: [rock({ status: "at_risk", statusColor: "amber" })], backlog: [] },
    },
    baselines: { clickup: {}, intelligems: {} },
    config: { system: { timezone: "America/Chicago" }, clickup: { statusMap: {} }, leadership: {}, people: { team: [] } },
    dateKey: "2026-11-17",
    nowIso: "2026-11-17T14:00:00Z",
  });
  const rules = flags.filter((f) => String(f.subject?.id).startsWith("r1:")).map((f) => f.rule);
  assert.ok(rules.includes("leadership.rock_off_course"));
  assert.ok(!rules.includes("leadership.rock_at_risk"));
  assert.ok(!rules.includes("nextstep.rock_due_not_moving"));
  assert.ok(!flags.some((f) => /owner_field_missing|task_owner/.test(f.rule)), "the retired Project Owner field raises nothing");
});

test("a ticket lands on its tactic through the tactic's ROCK option, else on the rock", () => {
  assert.deepEqual(placeTicket([rock()], ticket({ bigSwing: { optionId: "s2" } })), null, "s2 is a tactic option the rock does not hold");
  const r = rock({ clickupBigSwingOptionIds: ["s1", "s2"] });
  assert.deepEqual(placeTicket([r], ticket({ bigSwing: { optionId: "s2" } })), { rockId: "r1", tacticId: "t2" });
  assert.deepEqual(placeTicket([rock({ tactics: [] })], ticket()), { rockId: "r1", tacticId: null });
});

test("the plan adds, ticks off and removes items, refuses a stale version and a week outside the quarter", async () => {
  const store = new QuarterPlanStore(await createBackend({ mode: "memory" }));
  let doc = await store.apply("2026-Q4", { add: { week: "2026-11-16", rockId: "r1", tacticId: "t1", text: "Ship the upsell copy" } }, { expectedVersion: 0 });
  const id = doc.items[0].id;
  doc = await store.apply("2026-Q4", { update: { id, done: true } }, { expectedVersion: 1 });
  assert.equal(doc.items[0].done, true);
  await assert.rejects(store.apply("2026-Q4", { remove: id }, { expectedVersion: 1 }), /changed since you loaded it/);
  await assert.rejects(store.apply("2026-Q4", { add: { week: "2027-01-04", rockId: "r1", text: "x" } }), /not in this quarter/);
  doc = await store.apply("2026-Q4", { remove: id }, { expectedVersion: 2 });
  assert.equal(doc.items.length, 0);
});

test("the ticket ledger keeps finished work after it leaves the sprint, dated the day it was first seen done", () => {
  let doc = { tickets: {} };
  doc = QuarterPlanStore.fold(doc, [ticket({ bucket: "inProgress" })], [rock()], "2026-11-09", "America/Chicago");
  doc = QuarterPlanStore.fold(doc, [ticket({ bucket: "done" })], [rock()], "2026-11-10", "America/Chicago");
  doc = QuarterPlanStore.fold(doc, [], [rock()], "2026-11-11", "America/Chicago");
  assert.deepEqual(
    { rockId: doc.tickets.k1.rockId, tacticId: doc.tickets.k1.tacticId, firstSeen: doc.tickets.k1.firstSeen, doneOn: doc.tickets.k1.doneOn },
    { rockId: "r1", tacticId: "t1", firstSeen: "2026-11-09", doneOn: "2026-11-10" },
  );
});

/* ------------------------------ assignee write ------------------------------ */

const assignSetup = async (tasks) => {
  const backend = await createBackend({ mode: "memory" });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const store = { backend, getLatestReport: async () => ({ detail: { clickup: { tasks } } }) };
  const config = {
    system: { http: { maxAttempts: 1 } },
    clickup: { apiBase: "https://api.clickup.test", customFields: {} },
    people: { team: [{ name: "Sam Rivera", clickupUserId: 42 }], alex: { name: "Alex Turney", clickupUserId: 7 } },
  };
  return { backend, calls, fetchImpl, store, config };
};

test("assigning adds one roster person to tickets the readout shows with nobody assigned, and records it", async () => {
  const s = await assignSetup([{ id: "abc", assignees: [] }, { id: "own", assignees: [{ id: 1 }] }]);
  const out = await setAssignee({ ...s, token: "pk", taskIds: ["abc", "own"], assigneeId: "42" });
  assert.deepEqual(out.set, ["abc"]);
  assert.match(out.failed[0].error, /left alone/);
  const write = s.calls.find((c) => c.method === "PUT");
  assert.equal(write.url, "https://api.clickup.test/task/abc");
  assert.deepEqual(write.body, { assignees: { add: [42], rem: [] } });
  assert.equal((await s.backend.keys("clickup/writes/")).length, 1);
});

test("an assignee off the roster, or a ticket that already has one, is refused before ClickUp is called", async () => {
  const s = await assignSetup([{ id: "own", assignees: [{ id: 1 }] }]);
  await assert.rejects(setAssignee({ ...s, token: "pk", taskIds: ["own"], assigneeId: "999" }), /roster/);
  await assert.rejects(setAssignee({ ...s, token: "pk", taskIds: ["own"], assigneeId: "42" }), /nobody assigned/);
  assert.equal(s.calls.length, 0);
});

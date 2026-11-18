// Today's rock moves: suggestions that say what they move and why, picks that are kept and
// ticked off, and a week that counts them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestions, shippedOnRocks, FocusStore, weekTally, impactOf } from "../src/focus/moves.js";
import { createBackend } from "../src/lib/storage.js";
import { standupFacts } from "../src/agents/my-standup.js";

const TZ = "America/Chicago";
const alex = { name: "Alex Turney", clickupUserId: "7" };
const rock = (over = {}) => ({
  id: "r1",
  title: "Bundles 2.0",
  state: "active",
  statusColor: "green",
  owner: { name: "Blake Tucker" },
  kpi: "Bundle attach rate 12% by Dec 31",
  clickupBigSwingOptionIds: ["s1"],
  milestones: [{ month: "2026-11", deliverable: "Upsell test live", done: false }],
  tactics: [{ id: "t1", title: "Builder", kpi: "+2% CVR", clickupBigSwingOptionId: "s1" }],
  ...over,
});
const report = (over = {}) => ({
  detail: {
    leadership: { queue: [rock(), rock({ id: "r2", title: "Subs", owner: { name: "Alex Turney" }, clickupBigSwingOptionIds: ["s9"], tactics: [] })] },
    rockCourse: [
      { id: "r1", course: "off", signals: [{ level: "off", kind: "tactics_past_checkin", text: "2 of 4 tactics are past the check-in date", fix: "check in on each in the standup" }] },
      { id: "r2", course: "on", signals: [] },
    ],
    clickup: {
      tasks: [
        { id: "k1", name: "Build upsell", bucket: "inProgress", status: "in-progress", assignees: [{ id: "7" }], bigSwing: { optionId: "s1" }, url: "https://app.clickup.com/t/k1" },
        { id: "k2", name: "Someone else's", bucket: "inProgress", status: "in-progress", assignees: [{ id: "42" }], bigSwing: { optionId: "s1" } },
        { id: "k3", name: "Not on a rock", bucket: "inProgress", status: "in-progress", assignees: [{ id: "7" }], bigSwing: null },
        { id: "k4", name: "Shipped bundle page", bucket: "done", status: "done (this sprint)", assignees: [{ id: "7" }], bigSwing: { optionId: "s1" }, dateDone: Date.parse("2026-11-17T16:00:00Z") },
      ],
    },
    ...over,
  },
});

test("suggestions: an off-course rock's decision first; work on an off-course rock beats work on one on course; each says what it moves", () => {
  const plan = { items: [{ id: "p1", week: "2026-11-16", rockId: "r2", text: "Draft subs offer", done: false }] };
  const out = suggestions({ report: report(), plan, dateKey: "2026-11-17", timeZone: TZ, alex });
  assert.deepEqual(out.map((m) => m.id), ["course:r1:tactics_past_checkin", "ticket:k1", "plan:p1"]);
  const [lead, ticket] = out;
  assert.equal(lead.text, "Bundles 2.0 — check in on each in the standup (with Blake)");
  assert.equal(lead.why, "2 of 4 tactics are past the check-in date");
  assert.deepEqual(lead.impact.milestone, { month: "2026-11", label: "November", deliverable: "Upsell test live" });
  assert.equal(lead.impact.definitionOfDone, "Bundle attach rate 12% by Dec 31");
  assert.equal(lead.impact.course, "off");
  assert.deepEqual(ticket.impact.tactic, { id: "t1", title: "Builder", kpi: "+2% CVR" });
  assert.ok(!out.some((m) => m.id === "ticket:k2" || m.id === "ticket:k3"), "someone else's ticket, or one on no rock, is not Alex's rock move");
  const after = suggestions({ report: report(), plan, dateKey: "2026-11-17", timeZone: TZ, alex, picked: [{ id: "plan:p1" }] });
  assert.ok(!after.some((m) => m.id === "plan:p1"), "a picked move is not suggested again");
});

test("picks are kept for the day, at most three open, ticked off and counted for the week by rock", async () => {
  const store = new FocusStore(await createBackend({ mode: "memory" }));
  const impact = impactOf(rock(), { course: "off" }, "2026-11-17");
  for (const n of [1, 2, 3]) await store.apply("2026-11-17", { pick: { id: `m${n}`, text: `Move ${n}`, impact } });
  await assert.rejects(store.apply("2026-11-17", { pick: { id: "m4", text: "Move 4", impact } }), /3 open moves/);
  await assert.rejects(store.apply("2026-11-17", { pick: { id: "m5", text: "No rock" } }), /Which rock/);
  let doc = await store.apply("2026-11-17", { start: "m2" });
  assert.ok(doc.picks[1].startedAt && !doc.picks[0].startedAt, "started is kept per move");
  const started = doc.picks[1].startedAt;
  doc = await store.apply("2026-11-17", { start: "m2" }, { now: new Date(Date.now() + 60000) });
  assert.equal(doc.picks[1].startedAt, started, "starting again keeps the first start");
  doc = await store.apply("2026-11-17", { done: "m1" });
  assert.ok(doc.picks[0].doneAt);
  doc = await store.apply("2026-11-17", { pick: { id: "m4", text: "Move 4", impact } });
  assert.equal(doc.picks.length, 4, "a done move frees a slot");
  doc = await store.apply("2026-11-16", { pick: { id: "x", text: "Monday move", impact }, start: true });
  assert.ok(doc.picks[0].startedAt, "picked and started at once");
  await store.apply("2026-11-16", { done: "x" });
  const week = await store.week("2026-11-17");
  assert.deepEqual(week.days.map((d) => [d.dateKey, d.done]), [["2026-11-16", 1], ["2026-11-17", 1]]);
  assert.deepEqual(week.rocks, [{ title: "Bundles 2.0", n: 2 }]);
  doc = await store.apply("2026-11-17", { remove: "m2" });
  assert.ok(!doc.picks.some((p) => p.id === "m2"));
});

test("tickets on rocks Alex shipped this week are counted, with the rock", () => {
  const out = shippedOnRocks({ report: report(), from: "2026-11-16", to: "2026-11-17", timeZone: TZ, alex });
  assert.deepEqual(out.map((t) => [t.id, t.rockTitle, t.doneOn]), [["k4", "Bundles 2.0", "2026-11-17"]]);
  assert.equal(weekTally([]).done, 0);
});

test("My stand-up reads yesterday's done rock moves and today's picks; week and waiting no longer share an id", () => {
  const config = { system: { timezone: TZ, schedule: { workingWeekdays: [1, 2, 3, 4, 5] } }, people: { alex } };
  const impact = { rockTitle: "Bundles 2.0" };
  const out = standupFacts({
    config,
    now: new Date("2026-11-17T20:00:00Z"),
    report: { detail: { clickup: { tasks: [] } }, flags: [] },
    plan: { items: [{ week: "2026-11-16", text: "QA bundle builder", done: false }] },
    waiting: [{ waitingOn: "Robson", at: "2026-11-16T15:00:00Z", what: "Quiz copy" }],
    focus: {
      yesterday: { dateKey: "2026-11-16", picks: [{ text: "Decide upsell scope with Blake", doneAt: "x", impact }] },
      today: { dateKey: "2026-11-17", picks: [{ text: "Check in on Builder", doneAt: null, impact }] },
    },
  });
  const text = out.facts.map((f) => `[${f.id}] ${f.text}`).join("\n");
  assert.match(text, /\[f1\] Done 2026-11-16, a rock move Alex picked: Decide upsell scope with Blake \(moves Bundles 2\.0\)/);
  assert.match(text, /\[f2\] Picked as today's rock move: Check in on Builder/);
  assert.match(text, /\[k1\] Planned this week/);
  assert.match(text, /\[w1\] Waiting on Robson/);
});

// Delta. Given two snapshots, every kind of change is detected, and no changes produces an
// empty delta. These are the places a quiet bug produces a confident wrong readout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { clickupDelta, classifyMovement } from "../src/delta/clickup-delta.js";
import { task, snapshot, NOW, DAY } from "./fixtures/tasks.js";
import { testConfig } from "./fixtures/config.js";

const config = testConfig();
const run = (before, after) => clickupDelta(snapshot(before), snapshot(after), { config, now: NOW });

test("status change is detected", () => {
  const delta = run([task({ status: "to do", bucket: "notStarted" })], [task({ status: "in progress", bucket: "inProgress" })]);
  assert.equal(delta.changes.statusChanges.length, 1);
  assert.equal(delta.changes.statusChanges[0].from, "to do");
  assert.equal(delta.changes.statusChanges[0].to, "in progress");
  assert.equal(delta.changes.statusChanges[0].signal, "moving");
});

test("assignee change is detected", () => {
  const delta = run([task()], [task({ assignees: [{ id: "u2", username: "rey" }] })]);
  assert.equal(delta.changes.assigneeChanges.length, 1);
  assert.equal(delta.changes.assigneeChanges[0].from, "dana");
  assert.equal(delta.changes.assigneeChanges[0].to, "rey");
});

test("owner change is detected, separately from assignee", () => {
  const delta = run([task()], [task({ taskOwners: [{ id: "u2", username: "rey" }] })]);
  assert.equal(delta.changes.ownerChanges.length, 1);
  assert.equal(delta.changes.assigneeChanges.length, 0, "an owner change is not an assignee change");
});

test("leadership priority change is detected", () => {
  const delta = run([task()], [task({ leadershipPriority: { optionId: "opt_ship", label: "Shipping threshold test" } })]);
  assert.equal(delta.changes.priorityChanges.length, 1);
  assert.equal(delta.changes.priorityChanges[0].from, "Subscription upsell");
  assert.equal(delta.changes.priorityChanges[0].to, "Shipping threshold test");
});

test("a dropdown renamed in ClickUp is not reported as a priority change", () => {
  // The option id is stable, the label is not. Mapping by id is what keeps a rename quiet.
  const delta = run([task()], [task({ leadershipPriority: { optionId: "opt_sub", label: "Subscription upsell v2" } })]);
  assert.equal(delta.changes.priorityChanges.length, 0);
});

test("new comments are detected and counted", () => {
  const delta = run([task({ commentCount: 2 })], [task({ commentCount: 5, dateUpdated: NOW - 1000 })]);
  assert.equal(delta.changes.newComments.length, 1);
  assert.equal(delta.changes.newComments[0].added, 3);
});

test("a new task appears", () => {
  const delta = run([task()], [task(), task({ id: "t2", name: "Task two" })]);
  assert.equal(delta.changes.newTasks.length, 1);
  assert.equal(delta.changes.newTasks[0].id, "t2");
});

test("a closed task is reported as both a status change and closed", () => {
  const delta = run([task()], [task({ status: "complete", bucket: "done", closed: true, dateClosed: NOW })]);
  assert.equal(delta.changes.closed.length, 1);
  assert.equal(delta.changes.statusChanges.length, 1);
  assert.equal(delta.counts.done, 1);
});

test("a task that disappeared from the list is reported", () => {
  const delta = run([task(), task({ id: "t2" })], [task()]);
  assert.equal(delta.changes.disappeared.length, 1);
  assert.equal(delta.changes.disappeared[0].id, "t2");
});

test("no changes produces an empty delta", () => {
  const delta = run([task(), task({ id: "t2" })], [task(), task({ id: "t2" })]);
  assert.equal(delta.counts.changed, 0);
  for (const list of Object.values(delta.changes)) assert.equal(list.length, 0);
});

test("first run has no baseline and reports no new tasks", () => {
  const delta = clickupDelta(null, snapshot([task(), task({ id: "t2" })]), { config, now: NOW });
  assert.equal(delta.hasBaseline, false);
  assert.equal(delta.changes.newTasks.length, 0, "on a first run every task is not 'new'");
  assert.equal(delta.counts.total, 2);
});

test("stalled is told apart from picked-up-and-waiting", () => {
  const before = task({ dateUpdated: NOW - 5 * DAY });
  const stalled = classifyMovement(task({ dateUpdated: NOW - 5 * DAY }), before, { stalledAfterDays: 3, now: NOW });
  assert.equal(stalled.signal, "stalled");
  assert.equal(stalled.idleDays, 5);

  const waiting = classifyMovement(task({ dateUpdated: NOW - 1000, commentCount: 4 }), task({ commentCount: 2 }), {
    stalledAfterDays: 3,
    now: NOW,
  });
  assert.equal(waiting.signal, "waiting", "a fresh comment means someone has it in hand");

  const moving = classifyMovement(task({ status: "in review" }), task({ status: "in progress" }), { stalledAfterDays: 3, now: NOW });
  assert.equal(moving.signal, "moving");
});

test("a not-started task that nobody has touched is idle, not stalled", () => {
  const idle = classifyMovement(
    task({ status: "to do", bucket: "notStarted", dateUpdated: NOW - 9 * DAY }),
    task({ status: "to do", bucket: "notStarted", dateUpdated: NOW - 9 * DAY }),
    { stalledAfterDays: 3, now: NOW },
  );
  assert.equal(idle.signal, "idle");
});

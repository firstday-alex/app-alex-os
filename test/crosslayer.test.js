// Cross layer check. Person with zero big swings is flagged. Person with two is flagged.
// Person with one plus BAU passes. Person with one plus unrelated tickets is flagged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { crossLayerCheck } from "../src/delta/crosslayer.js";
import { clickupDelta } from "../src/delta/clickup-delta.js";
import { task, snapshot, NOW } from "./fixtures/tasks.js";
import { testConfig } from "./fixtures/config.js";

const config = testConfig();

const LEADERSHIP = {
  queue: [
    { id: "p_sub", title: "Subscription upsell", state: "active", owner: { clickupUserId: "u1", name: "dana" }, clickupOptionId: "opt_sub" },
    { id: "p_ship", title: "Shipping threshold test", state: "active", owner: { clickupUserId: "u2", name: "rey" }, clickupOptionId: "opt_ship" },
  ],
  backlog: [],
  roster: [
    { clickupUserId: "u1", name: "dana" },
    { clickupUserId: "u2", name: "rey" },
  ],
  dropdownOptions: [
    { id: "opt_sub", label: "Subscription upsell" },
    { id: "opt_ship", label: "Shipping threshold test" },
    { id: "opt_bau", label: "Business as usual" },
  ],
};

const owner = (id, username) => ({ taskOwners: [{ id, username }], assignees: [{ id, username }] });
const SUB = { optionId: "opt_sub", label: "Subscription upsell" };
const SHIP = { optionId: "opt_ship", label: "Shipping threshold test" };
const BAU = { optionId: "opt_bau", label: "Business as usual" };

function check(tasks, leadership = LEADERSHIP) {
  const delta = clickupDelta(null, snapshot(tasks), { config, now: NOW });
  return crossLayerCheck({ clickupDelta: delta, leadership, config, dateKey: "2026-09-10" });
}

const rulesFor = (result, name) => result.flags.filter((f) => f.subject.label === name).map((f) => f.rule);

test("person with tickets but zero big swings is flagged", () => {
  const result = check([
    { ...task({ id: "a", leadershipPriority: null }), ...owner("u1", "dana") },
    { ...task({ id: "b", leadershipPriority: null }), ...owner("u1", "dana") },
  ]);
  assert.ok(rulesFor(result, "dana").includes("crosslayer.no_big_swing"));
});

test("person with two big swings is flagged", () => {
  const result = check([
    { ...task({ id: "a", leadershipPriority: SUB }), ...owner("u1", "dana") },
    { ...task({ id: "b", leadershipPriority: SHIP }), ...owner("u1", "dana") },
  ]);
  const rules = rulesFor(result, "dana");
  assert.ok(rules.includes("crosslayer.multiple_big_swings"));
  assert.ok(!rules.includes("crosslayer.no_big_swing"));
});

test("several tickets under ONE priority is one big swing, not several", () => {
  const result = check([
    { ...task({ id: "a", leadershipPriority: SUB }), ...owner("u1", "dana") },
    { ...task({ id: "b", leadershipPriority: SUB }), ...owner("u1", "dana") },
    { ...task({ id: "c", leadershipPriority: SUB }), ...owner("u1", "dana") },
  ]);
  assert.equal(result.people.find((p) => p.name === "dana").distinctBigSwings, 1);
  assert.ok(!rulesFor(result, "dana").includes("crosslayer.multiple_big_swings"));
});

test("person with one big swing plus BAU passes", () => {
  const result = check([
    { ...task({ id: "a", leadershipPriority: SUB }), ...owner("u1", "dana") },
    { ...task({ id: "b", leadershipPriority: BAU }), ...owner("u1", "dana") },
    { ...task({ id: "c", leadershipPriority: BAU }), ...owner("u1", "dana") },
    { ...task({ id: "d", leadershipPriority: BAU }), ...owner("u1", "dana") },
    { ...task({ id: "e", leadershipPriority: BAU }), ...owner("u1", "dana") },
    { ...task({ id: "f", leadershipPriority: BAU }), ...owner("u1", "dana") },
    { ...task({ id: "g", leadershipPriority: BAU }), ...owner("u1", "dana") },
  ]);
  const rules = rulesFor(result, "dana");
  assert.deepEqual(rules, [], "business as usual is expected and allowed, however much of it there is");
});

test("person with one big swing plus a pile of unrelated tickets is flagged", () => {
  const unrelated = ["b", "c", "d", "e", "f"].map((id) => ({
    ...task({ id, leadershipPriority: null }),
    ...owner("u1", "dana"),
  }));
  const result = check([{ ...task({ id: "a", leadershipPriority: SUB }), ...owner("u1", "dana") }, ...unrelated]);
  const rules = rulesFor(result, "dana");
  assert.ok(rules.includes("crosslayer.unrelated_pile"));
  assert.ok(!rules.includes("crosslayer.no_big_swing"), "they do have a big swing");
});

test("the unrelated pile threshold is a threshold, not any unrelated ticket at all", () => {
  const result = check([
    { ...task({ id: "a", leadershipPriority: SUB }), ...owner("u1", "dana") },
    { ...task({ id: "b", leadershipPriority: null }), ...owner("u1", "dana") },
  ]);
  assert.ok(!rulesFor(result, "dana").includes("crosslayer.unrelated_pile"));
});

test("a person on the roster with no tickets at all is not flagged for having no big swing", () => {
  const result = check([{ ...task({ id: "a", leadershipPriority: SUB }), ...owner("u1", "dana") }]);
  const reyFlags = rulesFor(result, "rey");
  assert.ok(!reyFlags.includes("crosslayer.no_big_swing"), "no tickets is a different problem from tickets with no big swing");
});

test("the Task Owner drives accountability, falling back to assignee", () => {
  const result = check([
    { ...task({ id: "a", leadershipPriority: SUB }), taskOwners: [{ id: "u2", username: "rey" }], assignees: [{ id: "u1", username: "dana" }] },
  ]);
  assert.equal(result.people.find((p) => p.name === "rey").distinctBigSwings, 1, "the owner holds the big swing");
  assert.equal(result.people.find((p) => p.name === "dana").distinctBigSwings, 0, "the assignee executes a piece of it");
});

test("a ticket pointing at a priority that is no longer active is stale, not a big swing", () => {
  const leadership = { ...LEADERSHIP, queue: [{ ...LEADERSHIP.queue[0], state: "shipped" }] };
  const result = check([{ ...task({ id: "a", leadershipPriority: SUB }), ...owner("u1", "dana") }], leadership);
  const rules = rulesFor(result, "dana");
  assert.ok(rules.includes("crosslayer.no_big_swing"));
  assert.equal(result.people.find((p) => p.name === "dana").staleTickets.length, 1);
});

test("an active leadership priority with no open ticket pointing at it is flagged", () => {
  const result = check([{ ...task({ id: "a", leadershipPriority: SUB }), ...owner("u1", "dana") }]);
  const orphan = result.flags.find((f) => f.rule === "crosslayer.priority_without_work");
  assert.ok(orphan);
  assert.equal(orphan.subject.label, "Shipping threshold test");
});

test("done tickets do not count toward anyone's sprint", () => {
  const result = check([
    { ...task({ id: "a", leadershipPriority: SUB, status: "complete", bucket: "done" }), ...owner("u1", "dana") },
    { ...task({ id: "b", leadershipPriority: null }), ...owner("u1", "dana") },
  ]);
  assert.equal(result.people.find((p) => p.name === "dana").totalTickets, 1);
});

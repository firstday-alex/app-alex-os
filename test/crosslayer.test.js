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

/* ------------------- the Big Swing field, once it exists ------------------- */

const SWING_QUIZ = { optionId: "00eaa598", label: "New Problem Based Bundle Buy Box" };
const SWING_CARPE = { optionId: "23eba93e", label: "Carpe Bundle Builder Inspired Funnel" };

const LEADERSHIP_WITH_SWINGS = {
  ...LEADERSHIP,
  queue: [
    { ...LEADERSHIP.queue[0], clickupBigSwingOptionId: "00eaa598" },
    { ...LEADERSHIP.queue[1], clickupBigSwingOptionId: null },
  ],
};

test("a person's big swings are counted from the Big Swing field, not the rock label", () => {
  const result = check(
    [
      { ...task({ id: "a", bigSwing: SWING_QUIZ, leadershipPriority: SUB }), ...owner("u1", "dana") },
      { ...task({ id: "b", bigSwing: SWING_QUIZ, leadershipPriority: null }), ...owner("u1", "dana") },
      { ...task({ id: "c", bigSwing: SWING_QUIZ, leadershipPriority: SHIP }), ...owner("u1", "dana") },
    ],
    LEADERSHIP_WITH_SWINGS,
  );
  // Three tickets, three different rock labels, but ONE project. That is one big swing.
  assert.equal(result.people.find((p) => p.name === "dana").distinctBigSwings, 1);
  assert.ok(!rulesFor(result, "dana").includes("crosslayer.multiple_big_swings"));
});

test("two different Big Swings on one person is still flagged", () => {
  const result = check(
    [
      { ...task({ id: "a", bigSwing: SWING_QUIZ }), ...owner("u1", "dana") },
      { ...task({ id: "b", bigSwing: SWING_CARPE }), ...owner("u1", "dana") },
    ],
    LEADERSHIP_WITH_SWINGS,
  );
  assert.ok(rulesFor(result, "dana").includes("crosslayer.multiple_big_swings"));
});

test("a big swing no active rock claims is flagged as untethered", () => {
  const result = check(
    [{ ...task({ id: "a", bigSwing: SWING_CARPE, leadershipPriority: null }), ...owner("u1", "dana") }],
    LEADERSHIP_WITH_SWINGS,
  );
  const flag = result.flags.find((f) => f.rule === "crosslayer.big_swing_without_rock");
  assert.ok(flag, "real work on a real project that leadership is not tracking");
  assert.deepEqual(flag.values.swings, ["Carpe Bundle Builder Inspired Funnel"]);
  // It still counts as a big swing: they are not idle, they are unaligned.
  assert.equal(result.people.find((p) => p.name === "dana").distinctBigSwings, 1);
});

test("BAU still wins over a Big Swing value, because BAU is expected work", () => {
  const result = check(
    [{ ...task({ id: "a", bigSwing: SWING_QUIZ, leadershipPriority: BAU }), ...owner("u1", "dana") }],
    LEADERSHIP_WITH_SWINGS,
  );
  const dana = result.people.find((p) => p.name === "dana");
  assert.equal(dana.bauTickets.length, 1);
  assert.equal(dana.distinctBigSwings, 0);
});

test("a rock is considered worked on when a ticket names its Big Swing", () => {
  const result = check(
    [{ ...task({ id: "a", bigSwing: SWING_QUIZ, leadershipPriority: null }), ...owner("u1", "dana") }],
    LEADERSHIP_WITH_SWINGS,
  );
  const orphans = result.flags.filter((f) => f.rule === "crosslayer.priority_without_work").map((f) => f.subject.label);
  assert.ok(!orphans.includes("Subscription upsell"), "its Big Swing is being worked on");
});

/* --------------------- surviving a ClickUp option rename --------------------- */

test("a renamed dropdown option does not break a rock linked by option id", async () => {
  const { crossLayerCheck } = await import("../src/delta/crosslayer.js");

  const config = { leadership: { crossLayer: {} }, clickup: { bauMarkers: [] } };
  const leadership = {
    roster: [{ clickupUserId: 1, name: "Dana" }],
    queue: [{ state: "active", title: "ncAOV", clickupOptionId: "opt-1", clickupBigSwingOptionId: "swing-1" }],
  };
  const task = {
    id: "t1",
    name: "Ship the buy box",
    bucket: "inProgress",
    status: "in-progress",
    assignees: [{ id: 1, username: "dana" }],
    taskOwners: [],
    // The option was renamed in ClickUp this morning. The id did not change.
    bigSwing: { optionId: "swing-1", label: "New Problem Based Bundle Buy Box v2" },
    leadershipPriority: { optionId: "opt-1", label: "ncAOV" },
  };

  const out = crossLayerCheck({ clickupDelta: { tasks: [task] }, leadership, config, dateKey: "2026-09-11" });
  const dana = out.people.find((p) => p.name === "Dana");
  assert.equal(dana.distinctBigSwings, 1, "the link held through the rename");
  assert.equal(dana.bigSwings[0].linkedBy, "id");
  assert.equal(dana.untetheredSwings.length, 0);
});

test("a rock linked only by title is reported, because a rename would break it silently", async () => {
  const { crossLayerCheck } = await import("../src/delta/crosslayer.js");

  const config = { leadership: { crossLayer: {} }, clickup: { bauMarkers: [] } };
  const leadership = {
    roster: [{ clickupUserId: 1, name: "Dana" }],
    // No clickupOptionId: the only thing joining this rock to ClickUp is its title.
    queue: [{ state: "active", title: "ncAOV", clickupOptionId: null }],
  };
  const task = {
    id: "t1",
    name: "Ship the buy box",
    bucket: "inProgress",
    status: "in-progress",
    assignees: [{ id: 1, username: "dana" }],
    taskOwners: [],
    bigSwing: null,
    leadershipPriority: { optionId: "opt-1", label: "ncAOV" },
  };

  const out = crossLayerCheck({ clickupDelta: { tasks: [task] }, leadership, config, dateKey: "2026-09-11" });
  assert.equal(out.people.find((p) => p.name === "Dana").bigSwings[0].linkedBy, "title");

  const flag = out.flags.find((f) => f.rule === "crosslayer.linked_by_title");
  assert.ok(flag, "the fragile link is named before it breaks, not after");
  assert.match(flag.message, /ncAOV/);
  assert.match(flag.message, /renamed/);
});

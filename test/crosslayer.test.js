// Cross layer check. Person with zero big swings is flagged. Any number of big swings is
// fine: that cap was removed for everyone on 2026-10-19.
// Person with one plus BAU passes. Person with one plus unrelated tickets is flagged.
//
// Tickets reach rocks through the Big Swing field only. SUB and SHIP below are Big Swing
// options, claimed by the two rocks; the Leadership Priority field carries only BAU.

import { test } from "node:test";
import assert from "node:assert/strict";
import { crossLayerCheck } from "../src/delta/crosslayer.js";
import { clickupDelta } from "../src/delta/clickup-delta.js";
import { task, snapshot, NOW } from "./fixtures/tasks.js";
import { testConfig } from "./fixtures/config.js";

const config = testConfig();

const LEADERSHIP = {
  queue: [
    { id: "p_sub", title: "Subscription upsell", state: "active", owner: { clickupUserId: "u1", name: "dana" }, clickupBigSwingOptionId: "opt_sub" },
    { id: "p_ship", title: "Shipping threshold test", state: "active", owner: { clickupUserId: "u2", name: "rey" }, clickupBigSwingOptionId: "opt_ship" },
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

const rulesFor = (result, name) => result.flags.filter((f) => f.subject?.label === name).map((f) => f.rule);

test("person with tickets but zero big swings is flagged", () => {
  const result = check([
    { ...task({ id: "a", leadershipPriority: null }), ...owner("u1", "dana") },
    { ...task({ id: "b", leadershipPriority: null }), ...owner("u1", "dana") },
  ]);
  assert.ok(rulesFor(result, "dana").includes("crosslayer.no_big_swing"));
});

test("several tickets under ONE priority is one big swing, not several", () => {
  const result = check([
    { ...task({ id: "a", bigSwing: SUB }), ...owner("u1", "dana") },
    { ...task({ id: "b", bigSwing: SUB }), ...owner("u1", "dana") },
    { ...task({ id: "c", bigSwing: SUB }), ...owner("u1", "dana") },
  ]);
  assert.equal(result.people.find((p) => p.name === "dana").distinctBigSwings, 1);
  assert.ok(!rulesFor(result, "dana").includes("crosslayer.multiple_big_swings"));
});

test("person with one big swing plus BAU passes", () => {
  const result = check([
    { ...task({ id: "a", bigSwing: SUB }), ...owner("u1", "dana") },
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
  const result = check([{ ...task({ id: "a", bigSwing: SUB }), ...owner("u1", "dana") }, ...unrelated]);
  const rules = rulesFor(result, "dana");
  assert.ok(rules.includes("crosslayer.unrelated_pile"));
  assert.ok(!rules.includes("crosslayer.no_big_swing"), "they do have a big swing");
});

test("the unrelated pile threshold is a threshold, not any unrelated ticket at all", () => {
  const result = check([
    { ...task({ id: "a", bigSwing: SUB }), ...owner("u1", "dana") },
    { ...task({ id: "b", leadershipPriority: null }), ...owner("u1", "dana") },
  ]);
  assert.ok(!rulesFor(result, "dana").includes("crosslayer.unrelated_pile"));
});

test("a person on the roster with no tickets at all is not flagged for having no big swing", () => {
  const result = check([{ ...task({ id: "a", bigSwing: SUB }), ...owner("u1", "dana") }]);
  const reyFlags = rulesFor(result, "rey");
  assert.ok(!reyFlags.includes("crosslayer.no_big_swing"), "no tickets is a different problem from tickets with no big swing");
});

test("the Task Owner drives accountability, falling back to assignee", () => {
  const result = check([
    { ...task({ id: "a", bigSwing: SUB }), taskOwners: [{ id: "u2", username: "rey" }], assignees: [{ id: "u1", username: "dana" }] },
  ]);
  assert.equal(result.people.find((p) => p.name === "rey").distinctBigSwings, 1, "the owner holds the big swing");
  assert.equal(result.people.find((p) => p.name === "dana").distinctBigSwings, 0, "the assignee executes a piece of it");
});

test("a shipped rock still claims the follow-up work on its Big Swing", () => {
  const leadership = { ...LEADERSHIP, queue: [{ ...LEADERSHIP.queue[0], state: "shipped" }, LEADERSHIP.queue[1]] };
  const result = check([{ ...task({ id: "a", bigSwing: SUB }), ...owner("u1", "dana") }], leadership);
  assert.ok(!rulesFor(result, "dana").includes("crosslayer.big_swing_without_rock"));
  assert.equal(result.people.find((p) => p.name === "dana").distinctBigSwings, 1);
});

test("a ticket on a backlog rock's Big Swing is untethered, and the message says the rock is in the backlog", () => {
  const leadership = { ...LEADERSHIP, queue: [LEADERSHIP.queue[1]], backlog: [{ ...LEADERSHIP.queue[0], state: "backlog" }] };
  const result = check([{ ...task({ id: "a", bigSwing: SUB }), ...owner("u1", "dana") }], leadership);
  const flag = result.flags.find((f) => f.rule === "crosslayer.big_swing_without_rock");
  assert.ok(flag);
  assert.match(flag.message, /"Subscription upsell" \(its rock "Subscription upsell" is in the backlog\)/);
});

test("a Big Swing set to BAU is business as usual, not an untracked project", () => {
  const result = check([{ ...task({ id: "a", bigSwing: { optionId: "sw_bau", label: "BAU" } }), ...owner("u1", "dana") }]);
  const dana = result.people.find((p) => p.name === "dana");
  assert.equal(dana.bauTickets.length, 1);
  assert.equal(dana.distinctBigSwings, 0);
  assert.ok(!result.flags.some((f) => f.rule === "crosslayer.big_swing_without_rock"));
});

test("a Leadership Priority with no Big Swing does not tie a ticket to a rock", () => {
  const result = check([{ ...task({ id: "a", leadershipPriority: SUB }), ...owner("u1", "dana") }]);
  const dana = result.people.find((p) => p.name === "dana");
  assert.equal(dana.distinctBigSwings, 0);
  assert.equal(dana.unrelatedTickets.length, 1);
  assert.ok(rulesFor(result, "dana").includes("crosslayer.no_big_swing"));
});

test("an active leadership priority with no open ticket pointing at it is flagged", () => {
  const result = check([{ ...task({ id: "a", bigSwing: SUB }), ...owner("u1", "dana") }]);
  const orphan = result.flags.find((f) => f.rule === "crosslayer.priority_without_work");
  assert.ok(orphan);
  assert.equal(orphan.subject.label, "Shipping threshold test");
});

test("done tickets do not count toward anyone's sprint", () => {
  const result = check([
    { ...task({ id: "a", bigSwing: SUB, status: "complete", bucket: "done" }), ...owner("u1", "dana") },
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
    // No Big Swing option: the only thing joining this rock to ClickUp is its title.
    queue: [{ state: "active", title: "ncAOV", clickupBigSwingOptionId: null }],
  };
  const task = {
    id: "t1",
    name: "Ship the buy box",
    bucket: "inProgress",
    status: "in-progress",
    assignees: [{ id: 1, username: "dana" }],
    taskOwners: [],
    bigSwing: { optionId: "swing-9", label: "ncAOV" },
    leadershipPriority: null,
  };

  const out = crossLayerCheck({ clickupDelta: { tasks: [task] }, leadership, config, dateKey: "2026-09-11" });
  assert.equal(out.people.find((p) => p.name === "Dana").bigSwings[0].linkedBy, "title");

  const flag = out.flags.find((f) => f.rule === "crosslayer.linked_by_title");
  assert.ok(flag, "the fragile link is named before it breaks, not after");
  assert.match(flag.message, /ncAOV/);
  assert.match(flag.message, /renamed/);
});

test("no one is flagged for carrying several big swings at once", () => {
  const result = check(
    [
      { ...task({ id: "a", bigSwing: SWING_QUIZ }), ...owner("u1", "dana") },
      { ...task({ id: "b", bigSwing: SWING_CARPE }), ...owner("u1", "dana") },
      { ...task({ id: "c", bigSwing: SUB }), ...owner("u1", "dana") },
    ],
    LEADERSHIP_WITH_SWINGS,
  );
  assert.equal(result.people.find((p) => p.name === "dana").distinctBigSwings, 3);
  assert.ok(!result.flags.some((f) => f.rule === "crosslayer.multiple_big_swings"));
  assert.ok(!rulesFor(result, "dana").includes("crosslayer.no_big_swing"));
});

test("an unclaimed Big Swing carries what is needed to add it as a rock in one click", () => {
  const leadership = { ...LEADERSHIP, backlog: [{ id: "p_back", title: "Carpe Bundle Builder Inspired Funnel", state: "backlog" }] };
  const result = check(
    [
      { ...task({ id: "a", bigSwing: { optionId: "sw_ab", label: "AB Testing" } }), ...owner("u1", "dana") },
      { ...task({ id: "b", bigSwing: SWING_CARPE }), ...owner("u1", "dana") },
    ],
    leadership,
  );
  const flag = result.flags.find((f) => f.rule === "crosslayer.big_swing_without_rock");
  assert.equal(flag.values.ownerId, "u1", "the new rock's owner is the person doing the work");
  assert.deepEqual(flag.values.swingRefs, [
    { label: "AB Testing", optionId: "sw_ab", parkedRockId: null },
    { label: "Carpe Bundle Builder Inspired Funnel", optionId: "23eba93e", parkedRockId: "p_back" },
  ]);
});

/* ------------------------------ a rock whose work stopped ------------------------------ */

const DAY = 86_400_000;
const nowMs = typeof NOW === "number" ? NOW : new Date(NOW).getTime();
const touched = (daysAgo) => nowMs - daysAgo * DAY;
const ROCKS_ON_TRACK = {
  ...LEADERSHIP,
  queue: LEADERSHIP.queue.map((r) => ({ ...r, status: "on_track" })),
};

test("an On Track rock whose open tickets have all stopped moving is flagged, naming the freshest one", () => {
  const result = check(
    [
      { ...task({ id: "a", name: "Upsell copy", bigSwing: SUB, bucket: "inProgress", dateUpdated: touched(9) }), ...owner("u1", "dana") },
      { ...task({ id: "b", name: "Upsell design", bigSwing: SUB, bucket: "notStarted", dateUpdated: touched(14) }), ...owner("u1", "dana") },
    ],
    ROCKS_ON_TRACK,
  );
  const flag = result.flags.find((f) => f.rule === "crosslayer.rock_work_stalled");
  assert.ok(flag);
  assert.equal(flag.subject.label, "Subscription upsell");
  assert.equal(flag.message, '"Subscription upsell" is marked On Track, but none of its 2 open tickets have moved in 9 days. The most recent was "Upsell copy".');
});

test("one ticket touched this week is enough to keep a rock off the stalled list", () => {
  const result = check(
    [
      { ...task({ id: "a", bigSwing: SUB, bucket: "inProgress", dateUpdated: touched(2) }), ...owner("u1", "dana") },
      { ...task({ id: "b", bigSwing: SUB, bucket: "inProgress", dateUpdated: touched(20) }), ...owner("u1", "dana") },
    ],
    ROCKS_ON_TRACK,
  );
  assert.ok(!result.flags.some((f) => f.rule === "crosslayer.rock_work_stalled"));
});

test("a ticket whose last touch is unknown never makes a rock look stalled", () => {
  const result = check([{ ...task({ id: "a", bigSwing: SUB, bucket: "inProgress", dateUpdated: null }), ...owner("u1", "dana") }], ROCKS_ON_TRACK);
  assert.ok(!result.flags.some((f) => f.rule === "crosslayer.rock_work_stalled"));
});

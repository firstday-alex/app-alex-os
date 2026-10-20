// A ticket reaches a rock through its Big Swing, so the hygiene note for a ticket that
// ladders up to nothing is about Big Swing, not Leadership Priority. BAU work, marked in
// either field, needs no Big Swing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFlags } from "../src/delta/index.js";
import { task, snapshot, NOW } from "./fixtures/tasks.js";
import { testConfig } from "./fixtures/config.js";

const config = testConfig();
const fieldMap = { taskOwner: { id: "f_owner" }, leadershipPriority: { id: "f_priority" }, bigSwing: { id: "f_swing" }, options: {} };

function flagsFor(tasks, map = fieldMap) {
  const snap = { ...snapshot(tasks), fieldMap: map };
  const { flags } = computeFlags({
    snapshots: { clickup: snap, errors: {} },
    baselines: { clickup: { snapshot: null }, intelligems: { snapshot: null }, leadership: { snapshot: null }, shopify: { snapshot: null } },
    config,
    dateKey: "2026-09-10",
    nowIso: new Date(NOW).toISOString(),
  });
  return flags;
}
const swingNotes = (flags) => flags.filter((f) => f.rule === "clickup.no_big_swing_set").map((f) => f.subject.label);

test("a ticket with a Leadership Priority but no Big Swing is noted as laddering up to no rock", () => {
  const flags = flagsFor([task({ id: "a", name: "V4 Family Bundle Builder (1 step version)", leadershipPriority: { optionId: "o", label: "CVR" }, bigSwing: null })]);
  assert.deepEqual(swingNotes(flags), ["V4 Family Bundle Builder (1 step version)"]);
  assert.match(flags.find((f) => f.rule === "clickup.no_big_swing_set").message, /has no Big Swing set, so it ladders up to no rock/);
  assert.ok(!flags.some((f) => f.rule === "clickup.no_leadership_priority"), "the old Leadership Priority note is gone");
});

test("a ticket with a Big Swing, or marked BAU in either field, is not noted", () => {
  const flags = flagsFor([
    task({ id: "a", name: "Has a swing", bigSwing: { optionId: "s1", label: "Family Bundle Builder" }, leadershipPriority: null }),
    task({ id: "b", name: "BAU by swing", bigSwing: { optionId: "s2", label: "BAU" }, leadershipPriority: null }),
    task({ id: "c", name: "BAU by priority", bigSwing: null, leadershipPriority: { optionId: "o", label: "BAU" } }),
  ]);
  assert.deepEqual(swingNotes(flags), []);
});

test("with no Big Swing field on the list, one P1 names the field instead of a note per ticket", () => {
  const flags = flagsFor([task({ id: "a", bigSwing: null }), task({ id: "b", bigSwing: null })], { ...fieldMap, bigSwing: null });
  assert.deepEqual(swingNotes(flags), []);
  assert.equal(flags.filter((f) => f.rule === "clickup.big_swing_field_missing").length, 1);
});

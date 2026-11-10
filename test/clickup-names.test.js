// ROCK and TACTIC in ClickUp carry the standup's rock and tactic names. Tickets link by
// those names; anything that does not line up is listed so it can be renamed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { linkByName, ownsTactic } from "../src/collectors/clickup-names.js";
import { classifyTicketLink } from "../src/delta/crosslayer.js";

const rocks = [
  { id: "r1", title: "Family Bundle Builder", bau: false, clickupBigSwingOptionIds: ["old-manual"], tactics: [
    { id: "t1", title: "Builder V4 launch", status: "in_progress" },
    { id: "t2", title: "Old finished thing", status: "done" },
  ] },
  { id: "r2", title: "Mobile App", bau: false, tactics: [{ id: "t3", title: "App store listing", status: "todo" }] },
  { id: "r3", title: "Web BAU", bau: true, tactics: [] },
];
const rockOptions = [
  { id: "o-fbb", label: "Family Bundle Builder" },
  { id: "o-quiz", label: "Quiz" },
  { id: "o-bau", label: "BAU" },
];
const tacticOptions = [
  { id: "x-v4", label: "Builder V4 Launch" },
  { id: "x-cvr", label: "CVR" },
];

test("rocks and open tactics link to the ClickUp values that name them; the rest is listed as stale", () => {
  const { rocks: out, names } = linkByName(rocks, { rockOptions, tacticOptions });
  const fbb = out.find((r) => r.id === "r1");
  assert.deepEqual(fbb.clickupBigSwingOptionIds, ["o-fbb", "old-manual"], "the name match first, a hand-set link kept");
  assert.deepEqual(fbb.clickupTacticOptionIds, ["x-v4"]);
  assert.equal(fbb.tactics.find((t) => t.id === "t2").clickupTacticOptionId, undefined, "a done tactic is not linked");
  assert.deepEqual(names.rocksUnmatched, ["Mobile App"], "a BAU rock is not expected to have a ROCK value");
  assert.deepEqual(names.tacticsUnmatched, [{ rock: "Mobile App", title: "App store listing" }]);
  assert.deepEqual(names.staleRockOptions.map((o) => o.label), ["Quiz"], "BAU is expected work, not stale");
  assert.deepEqual(names.staleTacticOptions.map((o) => o.label), ["CVR"]);
});

test("a ticket with only a TACTIC set reaches its rock", () => {
  const { rocks: out } = linkByName(rocks, { rockOptions, tacticOptions });
  const task = { leadershipPriority: { optionId: "x-v4", label: "Builder V4 Launch" }, bigSwing: null };
  assert.equal(ownsTactic(out[0], task), true);
  assert.equal(ownsTactic(out[1], task), false);
  const link = classifyTicketLink(task, { activeTitles: new Set(), activeBigSwingIds: new Set(), activeTacticIds: new Set(["x-v4"]), bauMarkers: ["bau"] });
  assert.equal(link.link, "bigSwing");
  assert.equal(link.linkedBy, "tactic");
  assert.equal(link.untethered, false);
});

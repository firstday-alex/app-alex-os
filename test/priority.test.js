// Today's 3: the ranking, and the dashboard's copy of it agreeing with the readout's.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { priorityScore, topFlags } from "../src/delta/priority.js";
import { repoRoot } from "../src/config.js";

const f = (id, over = {}) => ({ id, layer: 2, rule: "clickup.stalled", severity: "attention", openDays: 0, ...over });

test("a P1 outranks any attention item however old, and age then breaks ties", () => {
  const top = topFlags([
    f("old-attention", { openDays: 10 }),
    f("fresh-p1", { severity: "p1" }),
    f("older-p1", { severity: "p1", openDays: 4 }),
    f("hygiene", { severity: "info", openDays: 30 }),
  ]);
  assert.deepEqual(top.map((x) => x.id), ["older-p1", "fresh-p1", "old-attention"]);
});

test("a flag that touches a rock ranks above an otherwise equal one", () => {
  const top = topFlags([f("ticket"), f("rock", { layer: 1, subject: { type: "priority" } })], 1);
  assert.deepEqual(top.map((x) => x.id), ["rock"]);
});

test("handled flags, context and hygiene are never in Today's 3", () => {
  const top = topFlags([
    f("done", { severity: "p1", triage: { status: "done" } }),
    f("store", { severity: "attention", rule: "shopify.metric_moved", layer: 0 }),
    f("note", { severity: "info" }),
    f("real"),
  ]);
  assert.deepEqual(top.map((x) => x.id), ["real"]);
});

test("the dashboard ranks with the same weights as the readout", () => {
  const app = fs.readFileSync(path.join(repoRoot, "public", "app.js"), "utf8");
  const body = app.slice(app.indexOf("const PRIORITY_BASE"), app.indexOf("function topFlags"));
  const clientScore = new Function(`${body.replace("const PRIORITY_BASE", "var PRIORITY_BASE")}; return priorityScore;`)();
  const cases = [f("a"), f("b", { severity: "p1", openDays: 3, escalated: true }), f("c", { layer: 1, openDays: 12 }), f("d", { severity: "prompt", rule: "intelligems.ready_for_call" }), f("e", { severity: "info" })];
  for (const c of cases) assert.equal(clientScore(c), priorityScore(c), c.id);
});

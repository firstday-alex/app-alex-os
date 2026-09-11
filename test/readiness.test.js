// Readiness gate. 6 days and 400 orders is not ready. 10 days and 200 orders is not ready.
// 10 days and 300 orders is ready. Mirrors the Intelligems verdict, but our handling of
// not_ready is tested separately from theirs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGate, recommendFor } from "../src/delta/readiness.js";
import { test as makeTest } from "./fixtures/tests.js";
import { testConfig } from "./fixtures/config.js";

const config = testConfig();
const gate = config.intelligems.readinessGate;

test("6 days and 400 orders is not ready", () => {
  const result = evaluateGate(makeTest({ daysRunning: 6, minOrdersPerGroup: 400 }), gate);
  assert.equal(result.ready, false);
  assert.equal(result.ordersMet, true);
  assert.equal(result.daysMet, false);
});

test("10 days and 200 orders is not ready", () => {
  const result = evaluateGate(makeTest({ daysRunning: 10, minOrdersPerGroup: 200 }), gate);
  assert.equal(result.ready, false);
  assert.equal(result.daysMet, true);
  assert.equal(result.ordersMet, false);
});

test("10 days and 300 orders is ready", () => {
  const result = evaluateGate(makeTest({ daysRunning: 10, minOrdersPerGroup: 300 }), gate);
  assert.equal(result.ready, true);
});

test("300 is per group: the smallest group is what counts", () => {
  const smallest = makeTest({ daysRunning: 10, minOrdersPerGroup: 250, totalOrders: 900 });
  assert.equal(evaluateGate(smallest, gate).ready, false, "900 total across groups does not open the gate");
});

test("an unmet gate produces Keep Running, whatever the numbers say", () => {
  const result = recommendFor(makeTest({ daysRunning: 3, minOrdersPerGroup: 50, verdict: "strong_win" }), config);
  assert.equal(result.recommendation, "Keep Running");
  assert.match(result.reason, /Gate not met/);
});

test("our own not_ready handling is tested separately from the platform's", () => {
  // Their gate says not ready. Ours would too. Either way: Keep Running, no verdict.
  const result = recommendFor(makeTest({ daysRunning: 4, minOrdersPerGroup: 100, verdict: "not_ready" }), config);
  assert.equal(result.recommendation, "Keep Running");
  assert.equal(result.disagreement, null);
});

test("a disagreement between our gate and theirs is surfaced, and the conservative answer wins", () => {
  // Our arithmetic says ready. The platform still says not_ready.
  const result = recommendFor(makeTest({ daysRunning: 30, minOrdersPerGroup: 5000, verdict: "not_ready" }), config);
  assert.equal(result.recommendation, "Keep Running");
  assert.ok(result.disagreement, "a silent disagreement is the bug this catches");
  assert.equal(result.disagreement.ours, "ready");
  assert.equal(result.disagreement.theirs, "not_ready");
});

test("a passed gate maps the platform verdict through config", () => {
  const ready = { daysRunning: 14, minOrdersPerGroup: 900 };
  assert.equal(recommendFor(makeTest({ ...ready, verdict: "strong_win" }), config).recommendation, "Ship");
  assert.equal(recommendFor(makeTest({ ...ready, verdict: "strong_loss" }), config).recommendation, "Kill");
  assert.equal(recommendFor(makeTest({ ...ready, verdict: "mixed_signals" }), config).recommendation, "Iterate");
});

test("an unknown verdict is never guessed at", () => {
  const result = recommendFor(makeTest({ daysRunning: 14, minOrdersPerGroup: 900, verdict: "something_new" }), config);
  assert.equal(result.recommendation, "Keep Running");
  assert.equal(result.unmappedVerdict, true);
  assert.match(result.reason, /no mapping/);
});

test("missing days or orders is unknown, not zero", () => {
  const result = evaluateGate(makeTest({ daysRunning: null, minOrdersPerGroup: null }), gate);
  assert.equal(result.unknown, true);
  assert.equal(result.ready, false);
  assert.equal(recommendFor(makeTest({ daysRunning: null, minOrdersPerGroup: null, verdict: null }), config).recommendation, "Keep Running");
});

test("a met gate with no verdict from the platform still does not invent one", () => {
  const result = recommendFor(makeTest({ daysRunning: 14, minOrdersPerGroup: 900, verdict: null }), config);
  assert.equal(result.recommendation, "Keep Running");
  assert.match(result.reason, /no verdict/);
});

// Readiness gate. 6 days and 400 orders is not ready. 10 days and 200 orders is not ready.
// 10 days and 300 orders is ready. Mirrors the Intelligems verdict, but our handling of
// not_ready is tested separately from theirs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGate, recommendFor, clearResults } from "../src/delta/readiness.js";
import { test as makeTest, group as makeGroup, metric as makeMetric, snapshot as igSnapshot } from "./fixtures/tests.js";
import { computeFlags } from "../src/delta/index.js";
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

/* ------------------- the gate is enough data, not a result -------------------
   Past the gate, a call still needs a clear win or loss on a decision metric. */

const decisionConfig = {
  ...config,
  intelligems: {
    ...config.intelligems,
    decisionMetrics: { metrics: [{ metric: "net_revenue_per_visitor", label: "RPV" }, { metric: "conversion_rate", label: "CVR" }] },
  },
};
const withVariant = (metrics) =>
  makeTest({
    daysRunning: 21,
    minOrdersPerGroup: 412,
    verdict: "directional_win",
    groups: [makeGroup(), makeGroup({ id: "g_v", name: "Variant A", isControl: false, metrics })],
  });

test("past the gate with no clear result on any decision metric, the test keeps running", () => {
  const result = recommendFor(
    withVariant({ conversion_rate: makeMetric(0.032, { uplift: 0.03, upliftInterval: [-0.01, 0.07], probBeatControl: 0.88 }) }),
    decisionConfig,
  );
  assert.equal(result.recommendation, "Keep Running", "a directional verdict past the gate is not a call");
  assert.equal(result.awaitingResult, true);
  assert.match(result.reason, /no clear win or loss yet on RPV or CVR/);
});

test("past the gate with a clear win on a decision metric, the verdict stands and names the result", () => {
  const test_ = withVariant({ conversion_rate: makeMetric(0.034, { uplift: 0.041, upliftInterval: [0.012, 0.07], probBeatControl: 0.97 }) });
  const result = recommendFor(test_, decisionConfig);
  assert.equal(result.recommendation, "Iterate");
  assert.deepEqual(result.clearResults.map((r) => [r.label, r.direction, r.groupName]), [["CVR", "win", "Variant A"]]);
  assert.match(result.reason, /CVR \+4\.1% for "Variant A" \(a clear win\)/);
});

test("a clear loss counts too, and a metric outside the decision list does not", () => {
  const loss = withVariant({ net_revenue_per_visitor: makeMetric(2.1, { uplift: -0.08, upliftInterval: [-0.12, -0.03], probBeatControl: 0.02 }) });
  assert.deepEqual(clearResults(loss, decisionConfig.intelligems.decisionMetrics.metrics).map((r) => r.direction), ["loss"]);
  const elsewhere = withVariant({ aov: makeMetric(90, { uplift: 0.1, upliftInterval: [0.05, 0.15], probBeatControl: 0.99 }) });
  assert.equal(recommendFor(elsewhere, decisionConfig).recommendation, "Keep Running");
});

function flagsBetween(before, now) {
  return computeFlags({
    snapshots: { intelligems: igSnapshot([now]), errors: {} },
    baselines: { clickup: { snapshot: null }, intelligems: { snapshot: igSnapshot([before]) }, leadership: { snapshot: null }, shopify: { snapshot: null } },
    config: decisionConfig,
    dateKey: "2026-10-22",
    nowIso: "2026-10-22T13:00:00Z",
  }).flags;
}

test("passing the gate alone raises nothing; a clear result after it raises ready for a call", () => {
  const unclear = { conversion_rate: makeMetric(0.032, { uplift: 0.03, upliftInterval: [-0.01, 0.07], probBeatControl: 0.88 }) };
  const clear = { conversion_rate: makeMetric(0.034, { uplift: 0.041, upliftInterval: [0.012, 0.07], probBeatControl: 0.97 }) };
  const notYet = { ...withVariant(unclear), daysRunning: 6, minOrdersPerGroup: 280 };

  const justPassed = flagsBetween(notYet, withVariant(unclear));
  assert.ok(!justPassed.some((f) => ["intelligems.ready_for_call", "intelligems.gate_met", "intelligems.decision_due"].includes(f.rule)));

  const nowClear = flagsBetween(withVariant(unclear), withVariant(clear));
  const flag = nowClear.find((f) => f.rule === "intelligems.ready_for_call");
  assert.match(flag.message, /is ready for a call: CVR \+4\.1% for "Variant A" \(a clear win\), after 21 days and 412 orders in the smallest group\. The recommendation is Iterate\./);
});

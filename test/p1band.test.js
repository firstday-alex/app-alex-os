// P1 band. Metric inside its interval is quiet. Metric outside is flagged. Metric with no
// interval is skipped and logged, never compared against zero.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkP1Band, checkTestP1Bands } from "../src/delta/p1band.js";
import { metric, test as makeTest, group } from "./fixtures/tests.js";
import { testConfig } from "./fixtures/config.js";
import { createLogger } from "../src/lib/logger.js";

const config = testConfig();
const p1 = config.intelligems.p1Band;

test("a metric inside its interval is quiet", () => {
  const result = checkP1Band("aov", metric(80, { interval: [78, 82] }), metric(79.5), p1);
  assert.equal(result.checked, true);
  assert.equal(result.outOfBand, false);
});

test("a metric outside its interval is flagged", () => {
  const result = checkP1Band("aov", metric(80, { interval: [79, 81] }), metric(72), p1);
  assert.equal(result.checked, true);
  assert.equal(result.outOfBand, true);
  assert.deepEqual(result.values.interval, [79, 81]);
});

test("a metric with no interval is skipped and noted, not compared against zero", () => {
  const result = checkP1Band("aov", metric(80, { interval: null }), metric(72), p1);
  assert.equal(result.checked, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /no confidence interval/);
});

test("a null metric value is not treated as zero", () => {
  // Profit metrics come back null when COGS is not configured. Zero would flag every day.
  const result = checkP1Band("gross_profit_per_visitor", metric(null), metric(4.2), p1);
  assert.equal(result.checked, false);
  assert.match(result.reason, /no current value/);
});

test("a skipped band check is logged, so the silence is explainable", () => {
  const lines = [];
  const logger = createLogger({ level: "debug", sink: (line) => lines.push(line) });
  const current = makeTest({
    groups: [group({ id: "g1", metrics: { aov: metric(80, { interval: null }) } })],
  });
  const baseline = makeTest({ groups: [group({ id: "g1", metrics: { aov: metric(60, { interval: [58, 62] }) } })] });

  const results = checkTestP1Bands(current, baseline, config, logger);
  assert.equal(results.length, 0, "no flag raised");
  assert.ok(lines.some((line) => line.includes("p1band.skipped")), "but the skip is on the record");
});

test("the band check only compares groups present in both snapshots", () => {
  const current = makeTest({ groups: [group({ id: "g_new", metrics: { aov: metric(80, { interval: [79, 81] }) } })] });
  const baseline = makeTest({ groups: [group({ id: "g_old", metrics: { aov: metric(50, { interval: [49, 51] }) } })] });
  assert.equal(checkTestP1Bands(current, baseline, config, null).length, 0);
});

test("the percent fallback is only used when the method is explicitly switched", () => {
  const percentConfig = { method: "percent", fallbackPercentChange: 15 };
  const big = checkP1Band("aov", metric(100), metric(80), percentConfig);
  assert.equal(big.outOfBand, true);
  assert.equal(big.method, "percent");

  const small = checkP1Band("aov", metric(84), metric(80), percentConfig);
  assert.equal(small.outOfBand, false);

  const zeroBaseline = checkP1Band("aov", metric(84), metric(0), percentConfig);
  assert.equal(zeroBaseline.checked, false, "percent change against a zero baseline is undefined, not infinite");
});

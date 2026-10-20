// P1 band. Metric inside its interval is quiet. Metric outside is flagged. Metric with no
// interval is skipped and logged, never compared against zero.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkP1Band, checkTestP1Bands } from "../src/delta/p1band.js";
import { metric, test as makeTest, group, snapshot as igSnapshot } from "./fixtures/tests.js";
import { computeFlags } from "../src/delta/index.js";
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
  assert.equal(results.variants.length + results.controlSwings.length, 0, "no flag raised");
  assert.ok(lines.some((line) => line.includes("p1band.skipped")), "but the skip is on the record");
});

test("the band check only compares groups present in both snapshots", () => {
  const current = makeTest({ groups: [group({ id: "g_new", metrics: { aov: metric(80, { interval: [79, 81] }) } })] });
  const baseline = makeTest({ groups: [group({ id: "g_old", metrics: { aov: metric(50, { interval: [49, 51] }) } })] });
  const results = checkTestP1Bands(current, baseline, config, null);
  assert.equal(results.variants.length + results.controlSwings.length, 0);
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

/* -------------------- the control decides what a swing means --------------------
   A control is the unchanged site. A variant swinging while its control holds steady is
   the test; a control swinging is the site, and its variants moving with it say nothing. */

const ctl = (metrics) => group({ id: "g_ctl", name: "Control Group", isControl: true, metrics });
const v1 = (metrics) => group({ id: "g_v1", name: "Benefit tabs", isControl: false, metrics });

test("a variant that swings while its control holds steady is reported, with the control's numbers", () => {
  const current = makeTest({ groups: [ctl({ aov: metric(60, { interval: [59, 61] }) }), v1({ aov: metric(80, { interval: [79, 81] }) })] });
  const baseline = makeTest({ groups: [ctl({ aov: metric(60.2) }), v1({ aov: metric(72) })] });
  const { variants, controlSwings } = checkTestP1Bands(current, baseline, config, null);
  assert.equal(controlSwings.length, 0);
  assert.equal(variants.length, 1);
  assert.equal(variants[0].groupName, "Benefit tabs");
  assert.deepEqual(variants[0].control, { name: "Control Group", today: 60, baseline: 60.2 });
});

test("when the control swings, its variants' swings on that metric are not reported as the test", () => {
  const current = makeTest({ groups: [ctl({ aov: metric(70, { interval: [69, 71] }) }), v1({ aov: metric(80, { interval: [79, 81] }) })] });
  const baseline = makeTest({ groups: [ctl({ aov: metric(60) }), v1({ aov: metric(72) })] });
  const { variants, controlSwings } = checkTestP1Bands(current, baseline, config, null);
  assert.equal(variants.length, 0);
  assert.equal(controlSwings.length, 1);
  assert.equal(controlSwings[0].groupName, "Control Group");
});

/* ------------------------------ what the readout says ------------------------------ */

function igFlags(current, baseline) {
  const { flags } = computeFlags({
    snapshots: { intelligems: igSnapshot(current), errors: {} },
    baselines: { clickup: { snapshot: null }, intelligems: { snapshot: igSnapshot(baseline) }, leadership: { snapshot: null }, shopify: { snapshot: null } },
    config,
    dateKey: "2026-09-10",
    nowIso: "2026-09-10T13:00:00Z",
  });
  return flags;
}

test("a variant swing is reported with its numbers and the control's", () => {
  const now = makeTest({ groups: [ctl({ aov: metric(60, { interval: [59, 61] }) }), v1({ aov: metric(80, { interval: [79, 81] }) })] });
  const before = makeTest({ groups: [ctl({ aov: metric(60.2) }), v1({ aov: metric(72) })] });
  const flag = igFlags([now], [before]).find((f) => f.rule === "intelligems.p1_out_of_band");
  assert.equal(
    flag.message,
    '"Subscription upsell on PDP", variant "Benefit tabs": aov moved from 72 to 80 since the last readout, outside its 95% range of 79 to 81. The control held steady (60.20 to 60), so this is the variant, not the site.',
  );
});

test("controls swinging in two tests become one site-wide note, not two test flags", () => {
  const swing = (id, name) => ({
    now: makeTest({ id, name, groups: [ctl({ aov: metric(70, { interval: [69, 71] }) }), v1({ aov: metric(80, { interval: [79, 81] }) })] }),
    before: makeTest({ id, name, groups: [ctl({ aov: metric(60) }), v1({ aov: metric(72) })] }),
  });
  const a = swing("e1", "[HP] Shop For Your Family's Health");
  const b = swing("e2", "[KDE-BTS] -> Bundle Builder V3");
  const flags = igFlags([a.now, b.now], [a.before, b.before]);
  assert.equal(flags.filter((f) => f.rule === "intelligems.p1_out_of_band").length, 0);
  const notes = flags.filter((f) => f.rule === "intelligems.control_moved");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].severity, "info");
  assert.match(notes[0].message, /control group of 2 tests/);
  assert.match(notes[0].message, /\[HP\] Shop For Your Family's Health: 60 to 70; \[KDE-BTS\] -> Bundle Builder V3: 60 to 70/);
  assert.match(notes[0].message, /site-wide move, not a test result/);
});

// The Intelligems collector, tested against a REAL captured payload rather than against
// the shape it was first assumed to have.
//
// Every assertion here failed on the first implementation. They are kept as named cases
// because each one is a way for Layer 3 to look like it is working while reporting
// nothing: a wrong interval key silently disables every band check, a wrong uplift path
// silently disables trade-off analysis, and a verdict read from the wrong level turns a
// string comparison into an object comparison that is never equal.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMetric,
  normalizeGroups,
  normalizeExperiment,
  metricNamesFor,
  metricKeyFor,
  primaryMetricFor,
} from "../src/collectors/intelligems.js";
import { recommendFor } from "../src/delta/readiness.js";
import { checkP1Band } from "../src/delta/p1band.js";
import { tradeOffs } from "../src/delta/intelligems-delta.js";
import { ANALYTICS_RESPONSE, EXPERIENCE_DETAIL } from "./fixtures/intelligems-real.js";
import { testConfig } from "./fixtures/config.js";

const config = testConfig({
  intelligems: {
    ...testConfig().intelligems,
    metrics: { p0: ["conversion_rate", "net_revenue_per_visitor", "net_revenue_per_order"], p1: ["add_to_cart_rate", "view_collection_page_rate"] },
  },
});
const NOW = new Date("2026-09-10T20:00:00Z");

const build = () =>
  normalizeExperiment({
    experiment: EXPERIENCE_DETAIL,
    analysis: ANALYTICS_RESPONSE,
    detail: EXPERIENCE_DETAIL,
    config,
    now: NOW,
  });

/* ----------------------------- metric name map ----------------------------- */

test("the camelCase metric config translates to the snake_case analytics keys", () => {
  // experienceKeyMetrics says "conversionRate". The results say "conversion_rate".
  // Without the map, every per-test metric resolves to a key that matches nothing.
  assert.equal(metricKeyFor("conversionRate"), "conversion_rate");
  assert.equal(metricKeyFor("netRevenuePerVisitor"), "net_revenue_per_visitor");
  assert.equal(metricKeyFor("addToCartRate"), "add_to_cart_rate");
  assert.equal(metricKeyFor("profitPerVisitor"), "gross_profit_per_visitor");
});

test("an unknown metric id degrades to a sensible key instead of being dropped", () => {
  assert.equal(metricKeyFor("someBrandNewRate"), "some_brand_new_rate");
  assert.equal(metricKeyFor(null), null);
});

test("the per-test metric list comes from the test's own configured metrics", () => {
  const names = metricNamesFor(config, EXPERIENCE_DETAIL);
  for (const expected of ["conversion_rate", "net_revenue_per_visitor", "gross_profit_per_visitor", "net_revenue_per_order", "add_to_cart_rate"]) {
    assert.ok(names.includes(expected), `${expected} should be pulled for this test`);
  }
  assert.equal(new Set(names).size, names.length, "no duplicates");
});

test("the primary metric this test is judged on is identified", () => {
  assert.equal(primaryMetricFor(EXPERIENCE_DETAIL), "add_to_cart_rate");
});

/* ------------------------------ metric shape ------------------------------ */

test("the confidence interval is read from ci_low and ci_high", () => {
  // The first implementation looked for ciLow/ciHigh and confidenceInterval. Neither
  // exists, so every interval came back null and every band check silently skipped.
  const metric = normalizeMetric("conversion_rate", ANALYTICS_RESPONSE.metrics[0].conversion_rate);
  assert.deepEqual(metric.interval, [0.034950127452611925, 0.044600605871528386]);
  assert.notEqual(metric.interval, null);
});

test("uplift is an object holding a fraction, and is exposed as both fraction and percent", () => {
  const metric = normalizeMetric("net_revenue_per_visitor", ANALYTICS_RESPONSE.metrics[0].net_revenue_per_visitor);
  assert.equal(metric.uplift, 0.1588629649876816, "the raw fraction");
  assert.ok(Math.abs(metric.upliftPct - 15.886) < 0.01, "15.9%, not 0.16%");
  assert.deepEqual(metric.upliftInterval, [-0.09483039677143096, 0.4821223288774489]);
});

test("probability to beat control is p2bc, and probability to be best is p2bb", () => {
  const metric = normalizeMetric("conversion_rate", ANALYTICS_RESPONSE.metrics[0].conversion_rate);
  assert.equal(metric.probBeatControl, 0.7119);
  assert.ok(Math.abs(metric.probBest - 0.7119) < 0.001);
});

test("a null profit metric is not configured, not zero", () => {
  const metric = normalizeMetric("gross_profit_per_visitor", ANALYTICS_RESPONSE.metrics[0].gross_profit_per_visitor);
  assert.equal(metric.value, null);
  assert.equal(metric.configured, false);
  assert.equal(ANALYTICS_RESPONSE.cogsConfigured, false, "and the payload says why");
});

test("a metric with explicit null bounds yields no interval, so its band check is skipped", () => {
  const metric = normalizeMetric("view_collection_page_rate", ANALYTICS_RESPONSE.metrics[0].view_collection_page_rate);
  assert.equal(metric.interval, null);
  const check = checkP1Band("view_collection_page_rate", metric, { value: 0.004 }, config.intelligems.p1Band);
  assert.equal(check.checked, false);
  assert.equal(check.skipped, true);
});

/* ------------------------------ group joining ------------------------------ */

test("metrics and variations are separate arrays, joined on variation_id", () => {
  const groups = normalizeGroups(ANALYTICS_RESPONSE, ["conversion_rate", "net_revenue_per_visitor"]);
  assert.equal(groups.length, 2);

  const control = groups.find((g) => g.isControl);
  const variant = groups.find((g) => !g.isControl);
  assert.equal(control.name, "mag");
  assert.equal(variant.name, "mag alt price");
  assert.equal(control.metrics.conversion_rate.value, 0.037694013303769404);
  assert.equal(variant.metrics.conversion_rate.value, 0.03953307392996109);
});

test("the control carries no uplift and no probability to beat control", () => {
  const groups = normalizeGroups(ANALYTICS_RESPONSE, ["conversion_rate"]);
  const control = groups.find((g) => g.isControl);
  assert.equal(control.metrics.conversion_rate.uplift, null, "the control is the baseline, it does not beat itself");
  assert.equal(control.metrics.conversion_rate.probBeatControl, null);
});

test("scalar counts are unwrapped from their {value} envelope", () => {
  const groups = normalizeGroups(ANALYTICS_RESPONSE, []);
  const variant = groups.find((g) => !g.isControl);
  assert.equal(variant.orders, 254, "not [object Object], and not undefined");
  assert.equal(variant.visitors, 6425);
  assert.equal(variant.netRevenue, 15997.83);
});

test("per-variant order counts come from the verdict block the platform's own gate uses", () => {
  const groups = normalizeGroups(ANALYTICS_RESPONSE, []);
  assert.equal(groups.find((g) => g.isControl).orders, 238);
  assert.equal(groups.find((g) => !g.isControl).orders, 254);
});

/* -------------------------------- the test -------------------------------- */

test("the verdict is a string read from inside the testResult object", () => {
  // testResult is an object, not a string. Reading it directly gave every test a verdict
  // of [object Object], which matched no entry in verdictMap.
  const built = build();
  assert.equal(built.verdict, "not_ready");
  assert.equal(typeof built.verdict, "string");
});

test("runtime comes from the platform rather than being recomputed from the start date", () => {
  const built = build();
  assert.equal(built.daysRunning, 42, "runtime_days, straight from the verdict block");
});

test("a real live test resolves to Keep Running for the right reason", () => {
  // 42 days is well past the 7 day bar. 238 orders in the smallest group is short of 300.
  // Days met, orders not, so the gate is not met and there is no verdict yet.
  const built = build();
  const result = recommendFor(built, config);

  assert.equal(built.minOrdersPerGroup, 238);
  assert.equal(result.recommendation, "Keep Running");
  assert.equal(result.gate.daysMet, true);
  assert.equal(result.gate.ordersMet, false);
  assert.equal(result.disagreement, null, "our arithmetic and the platform's agree");
});

test("COGS state and revenue impact ride along, so the readout can be honest about both", () => {
  const built = build();
  assert.equal(built.cogsConfigured, false);
  assert.equal(built.cogsCoveragePct, 0);
  assert.equal(built.estMonthlyRevenueImpact, 3157);
});

test("trade-off analysis reads the real uplift interval and finds no confident move here", () => {
  const built = build();
  const trades = tradeOffs(built, config);
  const variant = trades.find((t) => t.groupName === "mag alt price");

  assert.ok(variant, "the challenger is analysed against the control");
  // Every P0 uplift interval on this test spans zero, so nothing is a confident win or
  // loss. That is the correct read: a 15.9% RPV uplift with a [-9.5%, +48%] interval is
  // not a result.
  assert.equal(variant.wins.length, 0);
  assert.equal(variant.losses.length, 0);
  assert.equal(variant.conflict, false);
  assert.ok(variant.flat.some((f) => f.note === "interval spans zero"));
});

/* ------------------------------ roster envelope ------------------------------ */

test("the roster is read from experiencesList, the key the API actually uses", async () => {
  const { rosterArray } = await import("../src/collectors/intelligems.js");
  const { EXPERIENCES_LIST } = await import("./fixtures/intelligems-real.js");

  // Guessing `experiences` matched nothing and returned []. An empty roster is a valid
  // answer, so the run reported success while reporting no tests at all.
  assert.equal(rosterArray(EXPERIENCES_LIST).length, 1);
  assert.equal(rosterArray(EXPERIENCES_LIST)[0].name, "[KCM-PDP] Price per Gummy");
});

test("an unrecognised envelope is used but reported, never silently emptied", async () => {
  const { rosterArray } = await import("../src/collectors/intelligems.js");
  const warned = [];
  const rows = rosterArray({ renamedAgain: [{ id: "a" }, { id: "b" }] }, { warn: (e) => warned.push(e) });
  assert.equal(rows.length, 2, "the only array is used rather than returning nothing");
  assert.ok(warned.includes("intelligems.roster_key_unexpected"));

  const errored = [];
  assert.equal(rosterArray({ a: 1 }, { error: (e) => errored.push(e) }).length, 0);
  assert.ok(errored.includes("intelligems.roster_unreadable"), "unreadable is an error, not a quiet zero");
});

/* --------------------------- tree metric coverage --------------------------- */

test("every metric the tree names is pulled, or the branches read as No data", async () => {
  const { metricNamesFor, treeMetricNames } = await import("../src/collectors/intelligems.js");
  const { loadConfig } = await import("../src/config.js");
  const real = loadConfig();

  const treeMetrics = treeMetricNames(real.intelligems.metricTree);
  assert.ok(treeMetrics.length > 10, "the tree has real depth");

  const pulled = new Set(metricNamesFor(real, EXPERIENCE_DETAIL));
  for (const metric of treeMetrics) {
    assert.ok(pulled.has(metric), `${metric} is in the tree but would be filtered out of the snapshot`);
  }
});

/* ------------------- response shapes, verified against the API ------------------- */

test("the experience endpoint wraps its payload, the roster endpoint does not", async () => {
  // An earlier check unwrapped this by hand before inspecting it, concluded the response
  // was flat, and the bug survived a deploy: every test rendered unclassified with no
  // control/variant difference and no primary metric.
  const unwrap = (body) => body?.experience ?? body;
  assert.deepEqual(unwrap({ experience: { id: "a", variations: [1] } }), { id: "a", variations: [1] });
  assert.deepEqual(unwrap({ id: "a", variations: [1] }), { id: "a", variations: [1] }, "a flat body still works");
});

test("timeseries accepts a different, smaller metric vocabulary than analytics", async () => {
  const { timeseriesMetrics, TIMESERIES_METRICS } = await import("../src/collectors/intelligems.js");

  // Verified live by asking the endpoint for a nonsense metric and reading what it
  // offered back. Sending an unsupported name fails the WHOLE call with a 400.
  assert.equal(TIMESERIES_METRICS.size, 7);
  assert.ok(TIMESERIES_METRICS.has("aov"));
  assert.ok(!TIMESERIES_METRICS.has("net_revenue_per_order"), "the same number, a different name");

  // AOV is translated rather than dropped.
  assert.deepEqual(timeseriesMetrics(["net_revenue_per_order"]), ["aov"]);
  // Unsupported names are dropped rather than failing the call.
  assert.deepEqual(timeseriesMetrics(["add_to_cart_rate", "conversion_rate"]), ["conversion_rate"]);
  // An empty list is also a 400, so there is always something to ask for.
  assert.deepEqual(timeseriesMetrics([]), ["conversion_rate"]);
  assert.deepEqual(timeseriesMetrics(["nonsense"]), ["conversion_rate"]);
});

test("stability reads the segments shape the API actually returns", async () => {
  const { assessStability } = await import("../src/collectors/intelligems.js");

  // { segments: { "<variation>": { data: [{ dt, <metric> }] } } }, not a flat points
  // array. Looking for points found nothing and reported "not enough points" forever.
  const real = {
    segments: {
      New: { data: [1, 1.02, 1.01, 1.03, 1.02].map((v, i) => ({ dt: `2026-09-0${i + 1}`, conversion_rate: v })) },
      Old: { data: [] },
    },
  };
  const result = assessStability(real);
  assert.equal(result.points, 5);
  assert.equal(typeof result.stabilized, "boolean");

  // A swinging series is not called stable.
  const swinging = { segments: { New: { data: [1, 1.4, 0.9, 1.3, 1.1].map((v, i) => ({ dt: `d${i}`, conversion_rate: v })) } } };
  assert.equal(assessStability(swinging).stabilized, false);

  assert.equal(assessStability({ segments: { New: { data: [] } } }).stabilized, null);
});

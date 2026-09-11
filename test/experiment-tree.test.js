// The experiment metric tree, significance, and the future-value projection.
//
// The tree exists so a move in RPV can be attributed rather than merely displayed, and
// so nothing in it is reported as more certain than the evidence beneath it. Both of
// those are properties worth testing, because both fail silently: an unattributed tree
// still renders, and an over-confident node still looks authoritative.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, weakest } from "../src/delta/significance.js";
import { buildMetricTree, attribute, treeHeadline } from "../src/delta/metric-tree.js";
import { projectFutureValue, valuePerVisitor } from "../src/delta/future-value.js";
import { normalizeSettings, SettingsValidationError, SettingsStore } from "../src/store/settings.js";
import { Store } from "../src/lib/storage.js";
import { testConfig } from "./fixtures/config.js";

const metric = (value, uplift, interval, p) => ({
  value, uplift, upliftPct: uplift == null ? null : uplift * 100, upliftInterval: interval, probBeatControl: p, configured: value != null,
});

/* ------------------------------ significance ------------------------------ */

test("strong needs BOTH an interval excluding zero and a probability clearing the bar", () => {
  const both = classify(metric(2.7, 0.11, [0.06, 0.16], 0.99));
  assert.equal(both.level, "strong_win");

  // A high probability whose interval still spans zero is not a finding.
  const probOnly = classify(metric(2.7, 0.159, [-0.09, 0.48], 0.99));
  assert.equal(probOnly.level, "directional_win");
  assert.match(probOnly.reason, /spans zero/);

  // An interval excluding zero but an unremarkable probability is also only directional.
  const intervalOnly = classify(metric(2.7, 0.11, [0.01, 0.2], 0.9));
  assert.equal(intervalOnly.level, "directional_win");
});

test("with no interval at all, nothing can ever be called strong", () => {
  const c = classify(metric(2.7, 0.11, null, 0.999));
  assert.equal(c.level, "directional_win", "one signal cannot corroborate itself");
  assert.match(c.reason, /no interval/);
});

test("a loss needs the probability at the far end, not merely below a half", () => {
  assert.equal(classify(metric(2.7, -0.056, [-0.08, -0.03], 0.11)).level, "directional_loss");
  assert.equal(classify(metric(2.7, -0.056, [-0.08, -0.03], 0.01)).level, "strong_loss");
});

test("a metric that was never configured is no data, not a flat result", () => {
  assert.equal(classify(metric(null, null, null, null)).level, "no_data");
  assert.equal(classify(metric(2.7, null, null, null)).level, "no_data", "a control has no uplift against itself");
});

test("rolling a branch up takes the weakest real level, ignoring absent metrics", () => {
  const levels = [classify(metric(1, 0.2, [0.1, 0.3], 0.99)), classify(metric(1, 0.01, [-0.2, 0.2], 0.5)), classify(metric(null))];
  assert.equal(weakest(levels).level, "inconclusive", "one noisy component makes the branch noisy");
});

/* -------------------------------- the tree -------------------------------- */

const TREE = {
  roots: [
    {
      metric: "net_revenue_per_visitor", label: "RPV", format: "money", decomposes: true,
      children: [
        { metric: "conversion_rate", label: "Conversion rate", format: "percent" },
        { metric: "net_revenue_per_order", label: "AOV", format: "money" },
      ],
    },
  ],
};

const groupWith = (metrics) => ({ id: "g", name: "Variant", isControl: false, metrics });
const controlWith = (metrics) => ({ id: "c", name: "Control", isControl: true, metrics });

test("RPV = AOV x conversion rate, so the parent's move can be attributed to its branches", () => {
  // Live figures: RPV +15.9%, of which AOV +10.5% and conversion +4.9%.
  const parts = attribute(0.159, [
    { metric: "conversion_rate", label: "Conversion rate", uplift: 0.049 },
    { metric: "net_revenue_per_order", label: "AOV", uplift: 0.105 },
  ]);
  assert.equal(parts.length, 2);

  const total = parts.reduce((s, p) => s + p.contributionPct, 0);
  assert.ok(Math.abs(total - 15.9) < 0.01, "the parts sum to the whole, not to something near it");

  const aov = parts.find((p) => p.metric === "net_revenue_per_order");
  const cvr = parts.find((p) => p.metric === "conversion_rate");
  assert.ok(aov.contributionPct > cvr.contributionPct, "AOV carried most of this move");
});

test("attribution is withheld where the identity does not hold", () => {
  assert.equal(attribute(0.1, [{ metric: "a", uplift: 0.05 }]), null, "one child is not a decomposition");
  assert.equal(attribute(null, [{ metric: "a", uplift: 0.05 }, { metric: "b", uplift: 0.05 }]), null);
});

test("a parent is never reported as more certain than the branch beneath it", () => {
  const roots = buildMetricTree(
    groupWith({
      net_revenue_per_visitor: metric(2.7, 0.11, [0.06, 0.16], 0.99), // strong on its own
      conversion_rate: metric(0.04, 0.01, [-0.2, 0.2], 0.5), // noise
      net_revenue_per_order: metric(63, 0.1, [-0.1, 0.3], 0.6), // noise
    }),
    controlWith({ net_revenue_per_visitor: metric(2.4), conversion_rate: metric(0.039), net_revenue_per_order: metric(57) }),
    TREE,
    { strong: 0.95, directional: 0.8 },
  );

  assert.equal(roots[0].significance.level, "strong_win", "the headline is strong in isolation");
  assert.equal(roots[0].childrenSignificance.level, "inconclusive", "but its components are noise, and the tree says so");
});

test("the headline is the strongest real signal anywhere, not the root", () => {
  const roots = buildMetricTree(
    groupWith({
      net_revenue_per_visitor: metric(2.7, 0.02, [-0.1, 0.14], 0.55),
      conversion_rate: metric(0.04, 0.2, [0.12, 0.28], 0.99),
      net_revenue_per_order: metric(63, 0.01, [-0.2, 0.2], 0.5),
    }),
    controlWith({ net_revenue_per_visitor: metric(2.65), conversion_rate: metric(0.033), net_revenue_per_order: metric(62) }),
    TREE,
    { strong: 0.95, directional: 0.8 },
  );
  const headline = treeHeadline(roots);
  assert.equal(headline.metric, "conversion_rate");
  assert.equal(headline.level, "strong_win");
});

/* ------------------------------ future value ------------------------------ */

test("value per visitor blends the LTVs by the mix the variant produces", () => {
  // 4% conversion, 60% subscription, $214.50 vs $96.20.
  const value = valuePerVisitor({ conversionRate: 0.04, subscriptionShare: 0.6, subscriptionLtv: 214.5, oneTimeLtv: 96.2 });
  assert.ok(Math.abs(value - 0.04 * (0.6 * 214.5 + 0.4 * 96.2)) < 1e-9);
});

test("a missing LTV reference withholds the projection rather than valuing a subscriber at zero", () => {
  assert.equal(valuePerVisitor({ conversionRate: 0.04, subscriptionShare: 0.6, subscriptionLtv: null, oneTimeLtv: 96.2 }), null);

  const test_ = { groups: [controlWith({ conversion_rate: metric(0.039), pct_subscription_orders: metric(0.6) })] };
  const fv = projectFutureValue(test_, { subscriptionLtv6mo: null, oneTimeLtv6mo: 96.2 });
  assert.equal(fv.available, false);
  assert.match(fv.reason, /not set/);
});

test("a variant can win on lifetime and lose on immediate revenue, and the projection says so", () => {
  const control = controlWith({
    conversion_rate: metric(0.04), pct_subscription_orders: metric(0.4), net_revenue_per_visitor: metric(3.0),
  });
  const variant = { ...groupWith({
    conversion_rate: metric(0.038), pct_subscription_orders: metric(0.85), net_revenue_per_visitor: metric(2.85),
  }), name: "Sub push" };

  const fv = projectFutureValue({ groups: [control, variant] }, { subscriptionLtv6mo: 214.5, oneTimeLtv6mo: 96.2, ltvHorizonMonths: 6 });
  const v = fv.variants[0];

  assert.ok(v.immediateUpliftPct < 0, "immediate revenue per visitor is down");
  assert.ok(v.upliftPct > 0, "six month value is up, because far more of them subscribed");
  assert.equal(v.disagreesWithImmediate, true, "the disagreement is the finding");
});

test("stale LTV references are still used, but flagged as old", () => {
  const control = controlWith({ conversion_rate: metric(0.04), pct_subscription_orders: metric(0.5), net_revenue_per_visitor: metric(3) });
  const fv = projectFutureValue({ groups: [control] }, {
    subscriptionLtv6mo: 214.5, oneTimeLtv6mo: 96.2, ltvAsOf: "2026-01-01", ltvStaleAfterDays: 90,
  }, new Date("2026-09-11T00:00:00Z"));
  assert.equal(fv.available, true, "old numbers still beat no numbers");
  assert.equal(fv.references.stale, true);
  assert.match(fv.references.note, /resting on old numbers/);
});

/* -------------------------------- settings -------------------------------- */

test("LTV settings are validated, and transposed values are called out", () => {
  assert.throws(() => normalizeSettings({ subscriptionLtv6mo: -5 }), SettingsValidationError);
  assert.throws(() => normalizeSettings({ significanceStrong: 1.5 }), /between 0 and 1/);
  assert.throws(
    () => normalizeSettings({ significanceStrong: 0.8, significanceDirectional: 0.9 }),
    /must be below strong/,
  );

  const transposed = normalizeSettings({ subscriptionLtv6mo: 96.2, oneTimeLtv6mo: 214.5 });
  assert.match(transposed._warning, /transposed/, "possible, but almost always a mistake, and it inverts every projection");
});

test("settings round-trip with an audit trail and reject a stale write", async () => {
  const backing = await Store.open({ config: testConfig(), mode: "memory" });
  const settings = new SettingsStore(backing.backend, null);

  await settings.write({ subscriptionLtv6mo: 214.5, oneTimeLtv6mo: 96.2 });
  const read = await settings.read();
  assert.equal(read.settings.subscriptionLtv6mo, 214.5);
  assert.equal(read.settings.ltvHorizonMonths, 6, "defaults fill in");

  const trail = await settings.auditTrail();
  assert.deepEqual(trail[0].changes.subscriptionLtv6mo, { from: null, to: 214.5 });

  await assert.rejects(() => settings.write({ subscriptionLtv6mo: 300 }, { expectedVersion: 0 }), /changed since you loaded/);
});

/* ------------------------------- test notes ------------------------------- */

import { normalizeNote, TestNotesStore, TestNoteError } from "../src/store/test-notes.js";

test("an empty note is stored as nothing at all", () => {
  // Storing "" for every field on every test is how a small document stops being small.
  assert.equal(normalizeNote({ hypothesis: "", notes: "  ", decision: "" }), null);
  assert.equal(normalizeNote({}), null);
});

test("only the fields that have content are kept", () => {
  const note = normalizeNote({ hypothesis: "Bundle framing lifts AOV", notes: "", decision: "" });
  assert.equal(note.hypothesis, "Bundle framing lifts AOV");
  assert.equal("notes" in note, false, "absent, not empty");
  assert.equal("decision" in note, false);
});

test("tags are de-duplicated, validated and capped", () => {
  assert.deepEqual(normalizeNote({ hypothesis: "x", tags: ["pdp", "pdp", " aov "] }).tags, ["pdp", "aov"]);
  assert.throws(() => normalizeNote({ hypothesis: "x", tags: ["has/slash"] }), /not a usable tag/);
  assert.throws(() => normalizeNote({ hypothesis: "x", tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }), /At most 8/);
});

test("an oversized field is refused rather than silently truncated", () => {
  assert.throws(() => normalizeNote({ notes: "x".repeat(4001) }), TestNoteError);
});

test("notes round-trip, and clearing one removes its key entirely", async () => {
  const backing = await Store.open({ config: testConfig(), mode: "memory" });
  const notes = new TestNotesStore(backing.backend, null);

  await notes.put("exp-1", { hypothesis: "Price per gummy reads cheaper", tags: ["pdp"] });
  assert.equal((await notes.get("exp-1")).hypothesis, "Price per gummy reads cheaper");

  // Every note lives in one document, so reading them all costs one fetch.
  const all = await notes.readAll();
  assert.equal(Object.keys(all.notes).length, 1);

  await notes.put("exp-1", { hypothesis: "", notes: "", decision: "", tags: [] });
  assert.equal(await notes.get("exp-1"), null);
  assert.equal(Object.keys((await notes.readAll()).notes).length, 0, "cleared means gone, not an empty husk");
});

test("a stale note write is refused rather than clobbering a newer one", async () => {
  const backing = await Store.open({ config: testConfig(), mode: "memory" });
  const notes = new TestNotesStore(backing.backend, null);
  await notes.put("exp-1", { hypothesis: "first" });
  await assert.rejects(() => notes.put("exp-1", { hypothesis: "second" }, { expectedVersion: 0 }), /changed since you loaded/);
});

/* --------------------------- LTV from cohort data --------------------------- */

import { weightedLtv, PERIOD_FOR_HORIZON, buildCohortQuery } from "../src/collectors/ltv.js";

/** The real cohort rows the store returned for subscription-first customers. */
const SUB_COHORTS = [
  { month: "2025-09", period: 5, value: 197.988, customers: 12483 },
  { month: "2025-10", period: 5, value: 200.541, customers: 16766 },
  { month: "2025-11", period: 5, value: 209.941, customers: 15039 },
  { month: "2025-12", period: 5, value: 249.245, customers: 15872 },
  { month: "2026-01", period: 5, value: 253.485, customers: 13140 },
  { month: "2026-02", period: 5, value: 229.355, customers: 10344 },
  { month: "2026-03", period: 5, value: 228.17, customers: 9289 },
  // Too young to have reached month 5.
  { month: "2026-07", period: 1, value: 139.984, customers: 13891 },
  { month: "2026-08", period: 0, value: 70.596, customers: 27383 },
];

test("six month LTV is the cumulative figure at period 5, not period 6", () => {
  // amount_spent_per_customer is cumulative, so month 0 through 5 IS six months.
  assert.equal(PERIOD_FOR_HORIZON(6), 5);
  assert.equal(PERIOD_FOR_HORIZON(12), 11);
});

test("only cohorts old enough to have reached the horizon are counted", () => {
  const result = weightedLtv(SUB_COHORTS, 6);
  assert.equal(result.cohorts, 7, "the two young cohorts are excluded");
  assert.deepEqual(result.excludedCohorts, ["2026-07", "2026-08"]);

  // Including them would drag the figure toward zero while looking like a measurement:
  // a cohort from last month has spent three weeks, not six months.
  const naive = SUB_COHORTS.reduce((s, r) => s + r.value * r.customers, 0) / SUB_COHORTS.reduce((s, r) => s + r.customers, 0);
  assert.ok(result.value - naive > 35, `averaging the young cohorts in understates LTV by $${(result.value - naive).toFixed(2)}`);
});

test("cohorts are weighted by customer count, not averaged flat", () => {
  const result = weightedLtv(SUB_COHORTS, 6);
  assert.ok(Math.abs(result.value - 223.49) < 0.01, `expected ~$223.49, got ${result.value}`);
  assert.equal(result.customers, 92933);

  // On this data the cohorts are similar sizes, so weighting moves the figure by about
  // 60 cents. It is asserted anyway because that is an accident of these months, not a
  // property of the method: a promo month with three times the customers would matter.
  const flat = SUB_COHORTS.filter((r) => r.period === 5).reduce((s, r) => s + r.value, 0) / 7;
  assert.notEqual(result.value, flat, "weighting is applied, even where it happens to change little");
  assert.ok(Math.abs(result.value - flat) < 2, "and on these cohorts the effect is small");
});

test("no mature cohort yields no figure, with the reason, rather than a number", () => {
  const result = weightedLtv([{ month: "2026-08", period: 0, value: 70, customers: 100 }], 6);
  assert.equal(result.value, null);
  assert.match(result.reason, /No cohort has reached month 5/);
});

test("the cohort query carries the placeholder clauses the grid requires", () => {
  const { loadConfig } = { loadConfig: () => testConfig() };
  const config = { ...testConfig(), shopify: { ...testConfig().shopify, ltv: { salesChannel: "Online Store", horizonMonths: 6, maxPeriod: 11, since: "startOfMonth(-12m)", until: "endOfMonth(-1m)" } } };

  const sub = buildCohortQuery(config, { subscription: true });
  const one = buildCohortQuery(config, { subscription: false });

  assert.match(sub, /first_order_has_subscription = true/);
  assert.match(one, /first_order_has_subscription = false/);
  // Without the placeholder-row clauses the cohort query errors rather than returning
  // fewer rows, which is a confusing way to fail.
  assert.match(sub, /customer_cohorts_monthly_is_placeholder_row = true/);
  assert.match(sub, /first_order_sales_channel = 'Online Store'/);
  assert.match(sub, /HAVING customer_cohorts_monthly_periods_since_first_purchase >= 0/);

  // The two queries must differ in exactly one clause, or they are not comparable.
  assert.equal(sub.replace("= true", "= false"), one);
});

test("an assignee is stored as the ClickUp id, so a rename cannot break it", () => {
  const note = normalizeNote({ assignee: "87349065", hypothesis: "x" });
  assert.equal(note.assignee, "87349065");
  assert.equal(normalizeNote({ assignee: "", hypothesis: "x" }).assignee, undefined, "no owner means absent");
});

/* ---------------------------- audience breakdown ---------------------------- */

import { groupByAudience, analyseAudience } from "../src/delta/audience.js";

const audienceMetric = (value, uplift, ci, p) => ({
  value,
  uplift: uplift == null ? null : { value: uplift, ci_low: ci?.[0] ?? null, ci_high: ci?.[1] ?? null },
  p2bc: p,
});

/** The real shape: rows keyed by variation_id + audience, plus an audienceOrder. */
const AUDIENCE_RESPONSE = {
  audienceOrder: ["Mobile", "Desktop"],
  variations: [
    { id: "c", name: "Old", isControl: true },
    { id: "v", name: "New", isControl: false },
  ],
  metrics: [
    { variation_id: "c", audience: "Mobile", n_orders: { value: 1466 }, net_revenue_per_visitor: audienceMetric(3.1) },
    { variation_id: "v", audience: "Mobile", n_orders: { value: 1500 }, net_revenue_per_visitor: audienceMetric(3.0, -0.03, [-0.05, -0.01], 0.02) },
    { variation_id: "c", audience: "Desktop", n_orders: { value: 205 }, net_revenue_per_visitor: audienceMetric(4.0) },
    { variation_id: "v", audience: "Desktop", n_orders: { value: 210 }, net_revenue_per_visitor: audienceMetric(5.1, 0.28, [0.1, 0.46], 0.99) },
  ],
};

test("segments are joined from variation_id and audience, in the order the platform gave", () => {
  const segments = groupByAudience(AUDIENCE_RESPONSE, ["net_revenue_per_visitor", "n_orders"]);
  assert.deepEqual(segments.map((s) => s.segment), ["Mobile", "Desktop"]);
  assert.equal(segments[0].groups.length, 2);
  assert.equal(segments[0].groups.find((g) => g.isControl).name, "Old");
});

test("a segment under the order bar is reported as too small, never as a result", () => {
  // The guard that matters. On the live A/A test, Desktop showed +277% on 12 orders —
  // pure noise on a test that is null by construction. Without this it reads as a win.
  const result = analyseAudience({
    dimension: "device_type",
    segments: groupByAudience(AUDIENCE_RESPONSE, ["net_revenue_per_visitor", "n_orders"]),
    metric: "net_revenue_per_visitor",
    overall: { level: "inconclusive", label: "Inconclusive", tone: "flat", rank: 0 },
    minOrders: 300,
    thresholds: { strong: 0.95, directional: 0.8 },
  });

  const desktop = result.rows.find((r) => r.segment === "Desktop").variants[0];
  assert.equal(desktop.underpowered, true, "205 orders is under the 300 bar");
  assert.equal(desktop.significance.label, "Too small");
  assert.match(desktop.significance.reason, /under the 300 bar/);

  // And an underpowered segment can never become a finding.
  assert.ok(!result.divergent.some((d) => d.segment === "Desktop"));
});

test("a powered segment that contradicts the aggregate is the finding", () => {
  const powered = {
    ...AUDIENCE_RESPONSE,
    metrics: AUDIENCE_RESPONSE.metrics.map((m) => (m.audience === "Desktop" ? { ...m, n_orders: { value: 900 } } : m)),
  };
  const result = analyseAudience({
    dimension: "device_type",
    segments: groupByAudience(powered, ["net_revenue_per_visitor", "n_orders"]),
    metric: "net_revenue_per_visitor",
    overall: { level: "strong_loss", label: "Strong", tone: "loss", rank: 4 },
    minOrders: 300,
    thresholds: { strong: 0.95, directional: 0.8 },
  });

  assert.equal(result.divergent.length, 1);
  assert.equal(result.divergent[0].segment, "Desktop");
  assert.equal(result.divergent[0].direction, "win");
  assert.equal(result.divergent[0].overallDirection, "loss", "ship it to desktop rather than killing it");

  // Mobile agrees with the aggregate, so it is not reported: confirming the overall
  // result in every segment is noise.
  assert.ok(!result.divergent.some((d) => d.segment === "Mobile"));
});

test("a test inconclusive overall but decisive in one segment is also a finding", () => {
  const powered = {
    ...AUDIENCE_RESPONSE,
    metrics: AUDIENCE_RESPONSE.metrics.map((m) => (m.audience === "Desktop" ? { ...m, n_orders: { value: 900 } } : m)),
  };
  const result = analyseAudience({
    dimension: "device_type",
    segments: groupByAudience(powered, ["net_revenue_per_visitor", "n_orders"]),
    metric: "net_revenue_per_visitor",
    overall: { level: "inconclusive", label: "Inconclusive", tone: "flat", rank: 0 },
    minOrders: 300,
    thresholds: { strong: 0.95, directional: 0.8 },
  });
  assert.ok(result.divergent.length >= 1, "the more common shape of the same finding");
  assert.equal(result.divergent[0].overallDirection, null);
});

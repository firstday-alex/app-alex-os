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

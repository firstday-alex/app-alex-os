// Lifetime value, and what the advisor weighs it against.
//
// Two things worth pinning down. The 12 month multipliers must value each variant on its
// own subscription and one-time revenue, so a test that trades first-order revenue for
// subscribers shows both sides. And the advisor must see every rock on every call, since
// the rocks are the goals its answer is weighed against.

import { test } from "node:test";
import assert from "node:assert/strict";
import { projectFutureValue, valuePerVisitorFromMultipliers } from "../src/delta/future-value.js";
import { normalizeSettings, SettingsValidationError } from "../src/store/settings.js";
import { gatherContext, rocksForAdvice } from "../src/agents/strategic-advisor.js";

const metrics = (rpv, subRpv, share) => ({
  net_revenue_per_visitor: { value: rpv },
  subscription_revenue_per_visitor: { value: subRpv },
  pct_subscription_orders: { value: share },
});

// Read live on 2026-10-26: [KDE-BTS] Bundle Builder V3. The variant loses 13% on revenue
// per visitor while lifting subscription share from 72% to 85%.
const bundleBuilder = {
  id: "kde",
  groups: [
    { id: "c", name: "Control Group", isControl: true, metrics: metrics(1.3240414648138705, 0.9307459466289065, 0.71953125) },
    { id: "v", name: "New Group 1", isControl: false, metrics: metrics(1.1490897854689774, 0.9786840713700873, 0.8515723270440252) },
  ],
};

const settings = normalizeSettings({});

test("the multipliers default to Alex's 12 month figures", () => {
  assert.equal(settings.subscriptionLtvMultiplier, 3.95);
  assert.equal(settings.oneTimeLtvMultiplier, 1.78);
  assert.equal(settings.ltvMultiplierHorizonMonths, 12);
});

test("a visitor is worth subscription revenue x 3.95 plus one-time revenue x 1.78", () => {
  const value = valuePerVisitorFromMultipliers({
    revenuePerVisitor: 10,
    subscriptionRevenuePerVisitor: 6,
    subscriptionMultiplier: 3.95,
    oneTimeMultiplier: 1.78,
  });
  assert.ok(Math.abs(value - (6 * 3.95 + 4 * 1.78)) < 1e-9);
});

test("subscription revenue above total revenue projects nothing rather than a negative one-time share", () => {
  const value = valuePerVisitorFromMultipliers({
    revenuePerVisitor: 2,
    subscriptionRevenuePerVisitor: 3,
    subscriptionMultiplier: 3.95,
    oneTimeMultiplier: 1.78,
  });
  assert.equal(value, null);
});

test("the multipliers narrow a first-order loss that came from moving buyers onto subscription", () => {
  const fv = projectFutureValue(bundleBuilder, settings, new Date("2026-10-26T13:00:00Z"));
  assert.equal(fv.available, true);
  assert.equal(fv.method, "multiplier");
  assert.equal(fv.horizonMonths, 12);
  const [variant] = fv.variants;
  assert.ok(variant.immediateUpliftPct < -13 && variant.immediateUpliftPct > -14);
  assert.ok(variant.upliftPct < -4 && variant.upliftPct > -6, `12 month uplift was ${variant.upliftPct}`);
});

test("without multipliers it falls back to the measured dollar figures", () => {
  const dollars = normalizeSettings({ subscriptionLtvMultiplier: "", oneTimeLtvMultiplier: "", subscriptionLtv6mo: 214.5, oneTimeLtv6mo: 96.2 });
  const withRate = {
    ...bundleBuilder,
    groups: bundleBuilder.groups.map((g) => ({ ...g, metrics: { ...g.metrics, conversion_rate: { value: 0.02 } } })),
  };
  const fv = projectFutureValue(withRate, dollars);
  assert.equal(fv.method, "dollar");
  assert.equal(fv.horizonMonths, 6);
  assert.equal(fv.spread, 214.5 - 96.2);
});

test("a multiplier below 1 is refused, and a transposed pair is warned about", () => {
  assert.throws(() => normalizeSettings({ oneTimeLtvMultiplier: 0.5 }), SettingsValidationError);
  assert.match(normalizeSettings({ subscriptionLtvMultiplier: 1.78, oneTimeLtvMultiplier: 3.95 })._warning, /transposed/);
});

/* ------------------------------ the advisor's goals ------------------------------ */

const queue = [
  {
    id: "family-bundle-builder",
    title: "Family Bundle Builder",
    state: "active",
    status: "on_track",
    priority: "P1",
    kpi: "conversion_rate",
    owner: { name: "Cristobal Alanis", clickupUserId: "1" },
    clickupBigSwingOptionId: "opt-fbb",
    intelligemsExperienceId: "kde",
  },
  { id: "quiz", title: "Quiz", state: "active", status: "on_track", priority: "P1", owner: { name: "Robson Lopes" }, clickupBigSwingOptionId: "opt-quiz" },
];

const report = {
  dateKey: "2026-10-26",
  detail: {
    leadership: { queue, backlog: [] },
    clickup: { tasks: [{ id: "t1", name: "Build step 2", bigSwing: { optionId: "opt-quiz", label: "Quiz" } }] },
    intelligems: { tests: [{ id: "kde", name: "Bundle Builder V3" }] },
  },
  flags: [],
};
const config = { intelligems: { readinessGate: {}, verdictMap: {} } };

test("every rock reaches the advisor, whatever the flag is about", () => {
  const ctx = gatherContext({ flag: { id: "f", subject: { type: "person", id: "1" } }, report, config });
  assert.deepEqual(
    ctx.rocks.map((r) => r.title),
    ["Family Bundle Builder", "Quiz"],
  );
  assert.equal(ctx.rocks[0].owner, "Cristobal Alanis");
  assert.equal(rocksForAdvice().length, 0);
});

test("a ticket is tied to its rock through the Big Swing field", () => {
  const ctx = gatherContext({ flag: { id: "f", subject: { type: "task", id: "t1" } }, report, config });
  assert.equal(ctx.rock, "quiz");
});

test("a test is tied to the rock it is meant to prove, and carries the multipliers", () => {
  const ctx = gatherContext({ flag: { id: "f", subject: { type: "test", id: "kde:v" } }, report, config, settings });
  assert.equal(ctx.rock, "family-bundle-builder");
  assert.equal(ctx.ltvReferences.subscriptionLtvMultiplier, 3.95);
  assert.equal(ctx.ltvReferences.oneTimeLtvMultiplier, 1.78);
});

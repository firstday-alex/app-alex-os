// Layer 3 delta. Same day over day snapshot comparison as Layer 2, but on results rather
// than ticket activity.
//
// The two outcomes the spec asks for:
//   - a big change appears  -> flag it for Alex to look into
//   - nothing notable moved -> prompt the OWNER for next steps or a decision
// Both are produced here. The second one is not a non-event: a quiet test still needs a
// human to say what happens next.

import { recommendFor } from "./readiness.js";
import { checkTestP1Bands } from "./p1band.js";
import { buildMetricTree, treeHeadline } from "./metric-tree.js";
import { projectFutureValue } from "./future-value.js";
import { groupByAudience, analyseAudience } from "./audience.js";

const PROB_CROSS_THRESHOLD = 0.95;

function controlAndChallengers(test) {
  const groups = test.groups ?? [];
  return {
    control: groups.find((g) => g.isControl) ?? null,
    challengers: groups.filter((g) => !g.isControl),
  };
}

/** A P0 metric that has moved beyond its own confidence interval since the baseline. */
export function p0Moves(test, baselineTest, config) {
  const p0 = config.intelligems.metrics?.p0 ?? [];
  const baselineGroups = new Map((baselineTest?.groups ?? []).map((g) => [g.id, g]));
  const moves = [];

  for (const group of test.groups ?? []) {
    const before = baselineGroups.get(group.id);
    if (!before) continue;
    for (const name of p0) {
      const now = group.metrics?.[name];
      const then = before.metrics?.[name];
      if (!now || now.value == null || !then || then.value == null) continue;
      if (!now.interval) continue; // no interval, no judgement about "beyond noise"
      const [low, high] = now.interval;
      if (then.value < low || then.value > high) {
        moves.push({
          metric: name,
          groupId: group.id,
          groupName: group.name,
          today: now.value,
          baseline: then.value,
          interval: [low, high],
        });
      }
    }
  }
  return moves;
}

/** Probability to beat control crossing the threshold in either direction. */
export function probabilityCrossings(test, baselineTest, threshold = PROB_CROSS_THRESHOLD) {
  const baselineGroups = new Map((baselineTest?.groups ?? []).map((g) => [g.id, g]));
  const crossings = [];
  for (const group of test.groups ?? []) {
    const before = baselineGroups.get(group.id);
    if (!before) continue;
    for (const [name, metric] of Object.entries(group.metrics ?? {})) {
      const then = before.metrics?.[name];
      if (metric?.probBeatControl == null || then?.probBeatControl == null) continue;
      const wasAbove = then.probBeatControl >= threshold;
      const isAbove = metric.probBeatControl >= threshold;
      if (wasAbove !== isAbove) {
        crossings.push({
          metric: name,
          groupId: group.id,
          groupName: group.name,
          from: then.probBeatControl,
          to: metric.probBeatControl,
          direction: isAbove ? "crossed above" : "fell below",
          threshold,
        });
      }
    }
  }
  return crossings;
}

/**
 * Trade off analysis. A win on one metric against a loss on another gets weighed, not
 * just reported.
 *
 * This is deliberately arithmetic, not judgement. It lists which P0 metrics moved up and
 * which moved down with statistical confidence, and says plainly when they conflict. The
 * judgement call on a conflict is what the Strategic Advisor is for, and it only runs when
 * Alex asks. When the LTV reference values are configured, a shift in subscription mix is
 * also valued over six months rather than over the first order alone.
 */
export function tradeOffs(test, config) {
  const p0 = config.intelligems.metrics?.p0 ?? [];
  const { control, challengers } = controlAndChallengers(test);
  const analysis = [];

  for (const group of challengers) {
    const wins = [];
    const losses = [];
    const flat = [];

    for (const name of p0) {
      const metric = group.metrics?.[name];
      if (!metric || metric.value == null) {
        flat.push({ metric: name, note: "not configured" });
        continue;
      }
      const uplift = metric.uplift;
      const ci = metric.upliftInterval;
      const confident = ci && ci[0] != null && ci[1] != null && (ci[0] > 0 || ci[1] < 0);
      // Carry both forms: the fraction the API returned, and the percent a human reads.
      const pct = metric.upliftPct;
      if (uplift == null) flat.push({ metric: name, note: "no uplift returned" });
      else if (confident && uplift > 0) wins.push({ metric: name, uplift, upliftPct: pct, interval: ci });
      else if (confident && uplift < 0) losses.push({ metric: name, uplift, upliftPct: pct, interval: ci });
      else flat.push({ metric: name, uplift, upliftPct: pct, note: "interval spans zero" });
    }

    const ltv = config.references?.ltv ?? {};
    const ltvConfigured = ltv.subscription6MonthLtv?.value != null && ltv.oneTime6MonthLtv?.value != null;

    analysis.push({
      groupId: group.id,
      groupName: group.name,
      controlName: control?.name ?? null,
      wins,
      losses,
      flat,
      conflict: wins.length > 0 && losses.length > 0,
      // Six month value, when the reference values exist. Rendered as "not configured"
      // otherwise, never as zero.
      futureValue: ltvConfigured
        ? {
            subscriptionLtv: ltv.subscription6MonthLtv.value,
            oneTimeLtv: ltv.oneTime6MonthLtv.value,
            spread: ltv.subscription6MonthLtv.value - ltv.oneTime6MonthLtv.value,
            note: "Weigh a shift in subscription mix on six month value, not first order alone.",
          }
        : { configured: false, note: "LTV reference values not configured" },
    });
  }

  return analysis;
}

export function intelligemsDelta(baseline, current, { config, logger, settings = null, now = new Date() } = {}) {
  const thresholds = {
    strong: settings?.significanceStrong ?? 0.95,
    directional: settings?.significanceDirectional ?? 0.8,
  };
  const baselineById = new Map((baseline?.items ?? []).map((t) => [t.id, t]));
  const currentById = new Map((current?.items ?? []).map((t) => [t.id, t]));

  const tests = [];
  for (const test of current?.items ?? []) {
    const before = baselineById.get(test.id) ?? null;
    const recommendation = recommendFor(test, config);

    const verdictChanged = Boolean(before) && (before.verdict ?? null) !== (test.verdict ?? null);
    const gateJustMet =
      Boolean(before) &&
      recommendation.gate.ready &&
      !(before.minOrdersPerGroup >= config.intelligems.readinessGate.minOrdersPerGroup &&
        before.daysRunning >= config.intelligems.readinessGate.minDaysRunning);

    const p0 = p0Moves(test, before, config);
    const p1 = checkTestP1Bands(test, before, config, logger);
    const crossings = probabilityCrossings(test, before);
    const trades = tradeOffs(test, config);

    // The cascading tree, per challenger, and the lifetime view of the whole test.
    const control = (test.groups ?? []).find((g) => g.isControl) ?? null;
    const trees = (test.groups ?? [])
      .filter((g) => !g.isControl)
      .map((group) => {
        const roots = buildMetricTree(group, control, config.intelligems.metricTree, thresholds);
        return { groupId: group.id, groupName: group.name, roots, headline: treeHeadline(roots) };
      });
    const futureValue = projectFutureValue(test, settings, now);

    // Where the test actually won or lost. Only reported when a segment contradicts the
    // aggregate; confirming it in six segments is noise.
    const audCfg = config.intelligems.audiences ?? {};
    const judgeOn = audCfg.judgeOn ?? "net_revenue_per_visitor";
    const overallNode = (trees[0]?.roots ?? []).flatMap(function flat(n) {
      return [n, ...(n.children ?? []).flatMap(flat)];
    }).find((n) => n.metric === judgeOn);

    const audiences = Object.entries(test.audiences ?? {}).map(([dimension, analysis]) =>
      analyseAudience({
        dimension,
        segments: groupByAudience(analysis, [judgeOn, "n_orders", "n_visitors"]),
        metric: judgeOn,
        overall: overallNode?.significance ?? null,
        minOrders: audCfg.minOrdersPerGroup ?? config.intelligems.readinessGate?.minOrdersPerGroup ?? 300,
        thresholds,
      }),
    );

    const notable = verdictChanged || gateJustMet || p0.length > 0 || p1.length > 0 || crossings.length > 0;

    tests.push({
      ...test,
      before: before ? { verdict: before.verdict, daysRunning: before.daysRunning, minOrdersPerGroup: before.minOrdersPerGroup } : null,
      recommendation,
      changes: { verdictChanged, gateJustMet, p0Moves: p0, p1OutOfBand: p1, probabilityCrossings: crossings },
      tradeOffs: trades,
      trees,
      futureValue,
      audiences,
      notable,
      // No notable change means the owner gets prompted, not that nothing happens.
      quiet: Boolean(before) && !notable,
    });
  }

  // A test that ended overnight drops out of the started roster. Report it as ended with
  // its final verdict, then stop watching it.
  const ended = [];
  for (const [id, before] of baselineById) {
    if (!currentById.has(id)) {
      ended.push({ ...before, finalVerdict: before.verdict ?? null, endedBetween: [baseline?.takenAt, current?.takenAt] });
    }
  }

  return {
    hasBaseline: Boolean(baseline),
    baselineDate: baseline?.takenAt ?? null,
    tests,
    ended,
    failures: current?.failures ?? [],
    // Personalizations and anything else that is not a test. Carried through so the
    // dashboard can say what it is not showing.
    setAside: current?.meta?.setAside ?? [],
    counts: {
      running: tests.length,
      notable: tests.filter((t) => t.notable).length,
      quiet: tests.filter((t) => t.quiet).length,
      ended: ended.length,
      readyForVerdict: tests.filter((t) => t.recommendation.gate.ready).length,
    },
  };
}

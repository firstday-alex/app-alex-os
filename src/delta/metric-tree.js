// The experiment metric tree.
//
// Two roots, because those are the two questions worth asking of a test on this store:
// what did it do to revenue per visitor, and what did it do to the subscription mix.
//
// RPV decomposes exactly: RPV = AOV x conversion rate. That identity is why this is a
// tree rather than a list. A move in RPV can be ATTRIBUTED to its branches, so "RPV is up
// 11%" becomes "RPV is up 11%, and essentially all of it is AOV" — which is a different
// decision from the same number coming from conversion.
//
// Every node carries a significance judgement, and a parent is never reported as more
// certain than the branch it rests on.

import { classify, weakest, LEVELS } from "./significance.js";

/** Multiplicative decomposition: (1+rpv) = (1+aov)(1+cvr). */
export function attribute(parentUplift, childUplifts) {
  if (parentUplift == null) return null;
  const known = childUplifts.filter((c) => c.uplift != null);
  if (known.length < 2) return null;

  // Work in log space so the contributions add, then rescale to the parent's percentage
  // so the parts sum to the whole rather than to something near it.
  const logs = known.map((c) => ({ ...c, log: Math.log1p(c.uplift) }));
  const total = logs.reduce((sum, c) => sum + c.log, 0);
  if (total === 0) return null;

  return logs.map((c) => ({
    metric: c.metric,
    label: c.label,
    uplift: c.uplift,
    // Percentage points of the parent's move attributable to this branch.
    contributionPct: (c.log / total) * parentUplift * 100,
    shareOfMove: c.log / total,
  }));
}

function node(spec, group, control, thresholds) {
  const metric = group?.metrics?.[spec.metric] ?? null;
  const controlMetric = control?.metrics?.[spec.metric] ?? null;
  const significance = classify(metric, thresholds);

  return {
    metric: spec.metric,
    label: spec.label,
    format: spec.format ?? "number",
    description: spec.description ?? null,
    // Higher is better unless the metric says otherwise. Abandonment rates do.
    goodDirection: spec.goodDirection ?? "up",
    value: metric?.value ?? null,
    control: controlMetric?.value ?? null,
    uplift: metric?.uplift ?? null,
    upliftPct: metric?.upliftPct ?? null,
    interval: metric?.upliftInterval ?? null,
    probBeatControl: metric?.probBeatControl ?? null,
    significance,
    children: [],
  };
}

/**
 * Build the tree for one variation against control.
 *
 * @param {object} group      the challenger variation
 * @param {object} control    the control variation
 * @param {object} treeSpec   config.intelligems.metricTree
 * @param {object} thresholds significance thresholds
 */
export function buildMetricTree(group, control, treeSpec, thresholds) {
  const walk = (spec) => {
    const built = node(spec, group, control, thresholds);
    built.children = (spec.children ?? []).map(walk);

    if (built.children.length) {
      // A parent is never more certain than the branch beneath it. If the components are
      // all noise, the roll-up is noise, whatever the headline number looks like.
      const childLevels = built.children.map((c) => c.significance);
      built.childrenSignificance = weakest(childLevels);

      // Attribution only where the identity actually holds.
      if (spec.decomposes) {
        built.attribution = attribute(
          built.uplift,
          built.children.map((c) => ({ metric: c.metric, label: c.label, uplift: c.uplift })),
        );
      }
    }
    return built;
  };

  return (treeSpec?.roots ?? []).map(walk);
}

/** A flat summary for the readout: the strongest real signal anywhere in the tree. */
export function treeHeadline(roots) {
  const flat = [];
  const walk = (n) => {
    flat.push(n);
    (n.children ?? []).forEach(walk);
  };
  roots.forEach(walk);

  const real = flat.filter((n) => n.significance.level !== "no_data" && n.significance.level !== "inconclusive");
  if (real.length === 0) return { level: "inconclusive", ...LEVELS.inconclusive, nodes: [] };

  const best = real.reduce((a, b) => (LEVELS[a.significance.level].rank >= LEVELS[b.significance.level].rank ? a : b));
  return {
    ...best.significance,
    metric: best.metric,
    label: best.label,
    upliftPct: best.upliftPct,
    nodes: real.map((n) => ({ metric: n.metric, label: n.label, level: n.significance.level, upliftPct: n.upliftPct })),
  };
}

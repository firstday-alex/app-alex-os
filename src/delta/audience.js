// Audience breakdown: where a test actually won or lost.
//
// A test judged only in aggregate forces a binary decision — ship it or kill it. The
// breakdown adds the third option that is usually the right one: ship it *to the segment
// it works for*. "The new PDP lost" and "the new PDP lost on mobile and won on desktop"
// lead to completely different work.
//
// The danger is the opposite error: slicing until something looks significant. Two guards
// against that, and they are the point of this module rather than decoration:
//
//   1. A segment is only reported when it has enough orders to mean anything, using the
//      same per-group bar the readiness gate uses.
//   2. A segment is only called out when it DISAGREES with the overall result. Confirming
//      the aggregate in six segments is noise; contradicting it is a finding.

import { classify } from "./significance.js";

/** Rows are keyed by variation_id + audience. Join them into segments. */
export function groupByAudience(analysis, metricNames) {
  const variations = new Map((analysis?.variations ?? []).map((v) => [String(v.id), v]));
  const bySegment = new Map();

  for (const row of analysis?.metrics ?? []) {
    const segment = row.audience;
    if (segment == null) continue;
    if (!bySegment.has(segment)) bySegment.set(segment, []);

    const variation = variations.get(String(row.variation_id));
    bySegment.get(segment).push({
      variationId: String(row.variation_id),
      name: variation?.name ?? null,
      isControl: Boolean(variation?.isControl),
      orders: typeof row.n_orders?.value === "number" ? row.n_orders.value : null,
      visitors: typeof row.n_visitors?.value === "number" ? row.n_visitors.value : null,
      metrics: Object.fromEntries(metricNames.map((name) => [name, row[name] ?? null])),
    });
  }

  // Preserve the order the platform gave, which is by size.
  const order = analysis?.audienceOrder ?? [...bySegment.keys()];
  return order.filter((s) => bySegment.has(s)).map((segment) => ({ segment, groups: bySegment.get(segment) }));
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Normalize one raw metric object into the shape `classify` expects. */
function readMetric(raw) {
  if (!raw || typeof raw !== "object") return null;
  const low = num(raw.uplift?.ci_low);
  const high = num(raw.uplift?.ci_high);
  const uplift = num(raw.uplift?.value);
  return {
    value: num(raw.value),
    uplift,
    upliftPct: uplift == null ? null : uplift * 100,
    upliftInterval: low != null && high != null ? [low, high] : null,
    probBeatControl: num(raw.p2bc),
  };
}

/**
 * @param {object} opts
 * @param {string} opts.metric        the metric to judge each segment on
 * @param {object} opts.overall       the same metric's significance across all traffic
 * @param {number} opts.minOrders     per-group bar below which a segment says nothing
 */
export function analyseAudience({ dimension, segments, metric, overall, minOrders, thresholds }) {
  const rows = segments.map(({ segment, groups }) => {
    const control = groups.find((g) => g.isControl) ?? null;
    const challengers = groups.filter((g) => !g.isControl);

    const variants = challengers.map((group) => {
      const m = readMetric(group.metrics?.[metric]);
      const smallest = Math.min(group.orders ?? 0, control?.orders ?? 0);
      const underpowered = !minOrders || smallest < minOrders;

      return {
        variationId: group.variationId,
        name: group.name,
        orders: group.orders,
        controlOrders: control?.orders ?? null,
        value: m?.value ?? null,
        controlValue: readMetric(control?.metrics?.[metric])?.value ?? null,
        upliftPct: m?.upliftPct ?? null,
        // An underpowered segment is reported as underpowered, never as a result. This
        // is where slice-until-significant does its damage.
        significance: underpowered
          ? { level: "no_data", label: "Too small", tone: "none", rank: -1, reason: `${smallest} orders in the smaller group, under the ${minOrders} bar` }
          : classify(m, thresholds),
        underpowered,
      };
    });

    return { segment, variants, visitors: groups.reduce((s, g) => s + (g.visitors ?? 0), 0) };
  });

  // The finding: a segment whose direction contradicts the overall one, on evidence.
  const overallDirection = overall?.level?.includes("win") ? "win" : overall?.level?.includes("loss") ? "loss" : null;
  const divergent = [];

  for (const row of rows) {
    for (const variant of row.variants) {
      if (variant.underpowered) continue;
      const level = variant.significance.level;
      if (level === "inconclusive" || level === "no_data") continue;
      const direction = level.includes("win") ? "win" : "loss";
      if (overallDirection && direction !== overallDirection) {
        divergent.push({ segment: row.segment, variant: variant.name, direction, overallDirection, upliftPct: variant.upliftPct, level });
      }
      // A test that is inconclusive overall but decisive in one segment is the other
      // shape of the same finding, and the more common one.
      if (!overallDirection) {
        divergent.push({ segment: row.segment, variant: variant.name, direction, overallDirection: null, upliftPct: variant.upliftPct, level });
      }
    }
  }

  return { dimension, metric, rows, divergent, overall: overall ?? null };
}

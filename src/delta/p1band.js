// The P1 "out of whack" band.
//
// P0 metrics are always reported. P1 metrics are flagged only when they swing way out of
// whack, not for normal one-direction trending. The spec's own recommendation for the
// definition: the metric has moved outside its own 95 percent confidence interval day
// over day, since the API already returns the interval.
//
// The error state that matters: when a metric comes back with no interval, the check is
// SKIPPED and noted. It is never compared against zero. A missing interval quietly
// treated as [0,0] would flag every metric every day.

export function checkP1Band(metricName, current, baseline, p1Config) {
  if (!current || current.value == null) {
    return { checked: false, reason: "no current value", metric: metricName };
  }
  if (!baseline || baseline.value == null) {
    return { checked: false, reason: "no baseline value", metric: metricName };
  }

  const method = p1Config?.method ?? "confidence_interval";

  if (method === "confidence_interval") {
    // Use today's interval as the band. Yesterday's value falling outside it means the
    // metric moved by more than its own noise.
    const interval = current.interval;
    if (!interval || interval[0] == null || interval[1] == null) {
      return {
        checked: false,
        reason: "no confidence interval returned for this metric",
        metric: metricName,
        skipped: true,
      };
    }
    const [low, high] = interval;
    const outside = baseline.value < low || baseline.value > high;
    return {
      checked: true,
      outOfBand: outside,
      metric: metricName,
      method,
      values: { today: current.value, baseline: baseline.value, interval: [low, high] },
    };
  }

  // Percent fallback. Only used if Alex explicitly switches the method.
  const threshold = p1Config?.fallbackPercentChange ?? 15;
  if (baseline.value === 0) {
    return { checked: false, reason: "baseline value is zero, percent change undefined", metric: metricName, skipped: true };
  }
  const changePct = ((current.value - baseline.value) / Math.abs(baseline.value)) * 100;
  return {
    checked: true,
    outOfBand: Math.abs(changePct) >= threshold,
    metric: metricName,
    method: "percent",
    values: { today: current.value, baseline: baseline.value, changePct: Number(changePct.toFixed(2)), threshold },
  };
}

/** Runs the band check across one test's P1 metrics, group by group. */
export function checkTestP1Bands(test, baselineTest, config, logger) {
  const p1Names = config.intelligems.metrics?.p1 ?? [];
  const p1Config = config.intelligems.p1Band;
  const results = [];

  const baselineGroups = new Map((baselineTest?.groups ?? []).map((g) => [g.id, g]));

  for (const group of test.groups ?? []) {
    const before = baselineGroups.get(group.id);
    if (!before) continue;
    for (const name of p1Names) {
      const result = checkP1Band(name, group.metrics?.[name], before.metrics?.[name], p1Config);
      if (result.skipped) {
        logger?.info?.("p1band.skipped", { testId: test.id, group: group.name, metric: name, reason: result.reason });
      }
      if (result.checked && result.outOfBand) {
        results.push({ ...result, groupId: group.id, groupName: group.name });
      }
    }
  }
  return results;
}

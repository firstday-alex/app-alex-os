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

/** "add_to_cart_rate" as a person says it: "add-to-cart rate". */
export function metricLabel(name) {
  return String(name).replace(/add_to_cart/g, "add-to-cart").replace(/^pct_/, "% ").replace(/^n_/, "").replace(/_/g, " ");
}

/** A metric value as the readout prints it: rates as percentages, money in dollars. */
export function formatMetricValue(name, value) {
  if (value == null || Number.isNaN(Number(value))) return "n/a";
  const v = Number(value);
  if (/_rate$|^pct_/.test(name)) return `${(Math.abs(v) <= 1 ? v * 100 : v).toFixed(2)}%`;
  if (/revenue|profit/.test(name)) return `$${v.toFixed(2)}`;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/**
 * Runs the band check across one test's P1 metrics, group by group, and sorts the
 * swings by what they mean.
 *
 * The control is the unchanged site. When it swings, the site moved, and every variant
 * moving with it says nothing about the test. So:
 *   variants       a variant that swung while its control held steady (or could not be
 *                  checked): this is the test. Each carries its control's numbers.
 *   controlSwings  a control that swung. Reported once across all tests by the caller,
 *                  as a site-wide move, and its variants' swings on that metric are not
 *                  reported at all.
 */
export function checkTestP1Bands(test, baselineTest, config, logger) {
  const p1Names = config.intelligems.metrics?.p1 ?? [];
  const p1Config = config.intelligems.p1Band;
  const baselineGroups = new Map((baselineTest?.groups ?? []).map((g) => [g.id, g]));

  const check = (group, name) => {
    const before = baselineGroups.get(group.id);
    if (!before) return null;
    const result = checkP1Band(name, group.metrics?.[name], before.metrics?.[name], p1Config);
    if (result.skipped) {
      logger?.info?.("p1band.skipped", { testId: test.id, group: group.name, metric: name, reason: result.reason });
    }
    return result;
  };

  const control = (test.groups ?? []).find((g) => g.isControl) ?? null;
  const variants = [];
  const controlSwings = [];

  for (const name of p1Names) {
    const controlResult = control ? check(control, name) : null;
    const controlSwung = Boolean(controlResult?.checked && controlResult.outOfBand);
    if (controlSwung) {
      controlSwings.push({ ...controlResult, groupId: control.id, groupName: control.name });
      continue; // the variants moved with the site; nothing here is the test
    }
    for (const group of test.groups ?? []) {
      if (group.isControl) continue;
      const result = check(group, name);
      if (result?.checked && result.outOfBand) {
        variants.push({
          ...result,
          groupId: group.id,
          groupName: group.name,
          control: controlResult?.checked
            ? { name: control.name, today: controlResult.values?.today ?? null, baseline: controlResult.values?.baseline ?? null }
            : null,
        });
      }
    }
  }
  return { variants, controlSwings };
}

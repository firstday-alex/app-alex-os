// Intelligems fixtures. A normalized test, the shape the collector produces.

export function metric(value, { interval = null, uplift = null, upliftInterval = null, probBeatControl = null } = {}) {
  return { name: "m", value, interval, uplift, upliftInterval, probBeatControl, probBest: null, configured: value != null };
}

export function group(overrides = {}) {
  return {
    id: "g_control",
    name: "Control",
    isControl: true,
    orders: 400,
    visitors: 10000,
    metrics: {
      net_revenue_per_visitor: metric(2.5, { interval: [2.4, 2.6] }),
      conversion_rate: metric(0.031, { interval: [0.03, 0.032] }),
      aov: metric(80, { interval: [78, 82] }),
    },
    ...overrides,
  };
}

export function test(overrides = {}) {
  return {
    id: "e1",
    name: "Subscription upsell on PDP",
    status: "started",
    startedAt: "2026-08-25T00:00:00Z",
    daysRunning: 16,
    verdict: "directional_win",
    groups: [group(), group({ id: "g_variant", name: "Variant A", isControl: false })],
    minOrdersPerGroup: 400,
    totalOrders: 800,
    metricNames: ["net_revenue_per_visitor", "conversion_rate", "aov"],
    metricsConfigured: true,
    postTest: null,
    timeseriesStabilized: { stabilized: true, worstSwingPct: 0.4 },
    ...overrides,
  };
}

export function snapshot(items) {
  return {
    source: "intelligems",
    takenAt: "2026-09-10T13:00:00Z",
    items,
    failures: [],
    shop: { currency: "USD", timezone: "America/Chicago" },
    meta: { rosterSize: items.length, collected: items.length, failed: 0 },
  };
}

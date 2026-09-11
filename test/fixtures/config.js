// A complete config object for tests, so no test depends on whatever is currently in
// config/. Overrides merge one level deep per section.

export function testConfig(overrides = {}) {
  const base = {
    system: {
      timezone: "America/Chicago",
      schedule: { readoutHourCentral: 8, workingWeekdays: [1, 2, 3, 4, 5] },
      storage: {
        snapshotPrefix: "snapshots",
        reportPrefix: "reports",
        indexKey: "index.json",
        sentKeyPrefix: "reports/sent",
        keepSnapshotIndexEntries: 400,
        baselineLookbackWorkingDays: 10,
      },
      http: { timeoutMs: 30000, maxAttempts: 5, backoffMsSchedule: [1000, 2000, 4000, 8000], maxPages: 50 },
      logging: { level: "error", persistRunLogToStorage: false },
      dashboard: { sessionTtlHours: 12, refreshMinIntervalSeconds: 60 },
      slack: { advisorButtonText: "Ask for recommendation" },
      anthropic: { model: "claude-opus-5", effort: "high", maxTokens: 16000 },
    },
    clickup: {
      apiBase: "https://api.clickup.com/api/v2",
      sprintListId: "L1",
      taskQuery: { include_closed: true, subtasks: false, include_timl: true },
      customFields: {
        taskOwner: { id: "f_owner", matchName: ["Task Owner"], type: "users" },
        leadershipPriority: { id: "f_priority", matchName: ["Leadership Priority"], type: "drop_down" },
      },
      // The real status set on the Current Sprint list, read live 2026-09-10.
      statusMap: {
        notStarted: ["to do", "open", "not started", "backlog"],
        inProgress: ["in-progress", "vqa", "qa", "ready for deploy", "in progress", "in review", "blocked"],
        done: ["complete", "done", "closed"],
      },
      bauMarkers: ["Business as usual", "BAU"],
      rules: { stalledAfterDays: 3, fetchCommentsOnlyWhenUpdated: true, commentFetchCapPerRun: 60 },
    },
    intelligems: {
      apiBase: "https://api.intelligems.example/v25-10-beta",
      authHeader: "intelligems-access-token",
      // The real endpoints, verified against the External API reference.
      endpoints: {
        experiencesList: { method: "GET", path: "/experiences-list" },
        experience: { method: "GET", path: "/experiences/{experienceId}" },
        analytics: { method: "POST", path: "/analytics/resource/{experienceId}" },
        timeseries: { method: "POST", path: "/analytics/experience/{experienceId}/timeseries" },
      },
      readinessGate: { minDaysRunning: 7, minOrdersPerGroup: 300 },
      verdictMap: {
        strong_win: "Ship",
        directional_win: "Iterate",
        mixed_signals: "Iterate",
        directional_loss: "Iterate",
        strong_loss: "Kill",
        not_ready: "Keep Running",
      },
      metrics: { p0: ["net_revenue_per_visitor", "conversion_rate"], p1: ["aov"] },
      p1Band: { method: "confidence_interval", fallbackPercentChange: 15 },
      postTest: { enabled: false, includeInTestOrders: true },
    },
    leadership: {
      miniReadout: { toleranceWindowDays: 7, perProjectType: {} },
      capacity: { bigSwingsPerPerson: 1 },
      crossLayer: { requireOneBigSwingPerPerson: true, unrelatedTicketPileThreshold: 5 },
      dropdownSync: { enforce: true },
    },
    leadershipQueue: { queue: [], backlog: [] },
    people: { team: [{ clickupUserId: "u1", name: "dana", slackUserId: null, countsTowardCapacity: true }], alex: { slackUserId: "UALEX" } },
    references: { staleAfterDays: 90, currency: "USD", ltv: { subscription6MonthLtv: { value: null }, oneTime6MonthLtv: { value: null } } },
    shopify: {
      shopDomain: "test-shop.myshopify.com",
      apiVersion: "2026-07",
      currency: "USD",
      filters: { newOnline: "new_or_returning_customer = 'New' AND is_canceled_order = false" },
      windows: {
        mtd: { label: "MTD", since: "startOfMonth(0m)", until: "today", days: null, primary: true },
        d7: { label: "7D", since: "-7d", until: "today", days: 7 },
        d30: { label: "30D", since: "-30d", until: "today", days: 30 },
      },
      queries: {
        acquisition: { schema: "sales", show: "gross_sales, discounts, shipping_charges, orders", filter: "newOnline", orderBy: null },
      },
      derived: {
        net_aov: {
          label: "Net AOV",
          from: "acquisition",
          formula: "(gross_sales + discounts + shipping_charges) / orders",
          format: "money",
          kind: "rate",
          goodDirection: "up",
        },
      },
      tiles: [
        { metric: "net_aov", from: "derived", label: "Net AOV", format: "money", kind: "rate", goodDirection: "up" },
        { metric: "orders", from: "acquisition", label: "Orders", format: "integer", kind: "total", goodDirection: "up" },
      ],
      alerts: { movePercentThreshold: 15, compareAgainst: "d30" },
    },
  };

  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = value && typeof value === "object" && !Array.isArray(value) ? { ...base[key], ...value } : value;
  }
  return merged;
}

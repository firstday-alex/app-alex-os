// A real Intelligems response, captured from the First Day account on 2026-09-10 via the
// MCP server, trimmed to two variations and the metrics that matter. Field names, nesting
// and units are verbatim.
//
// This fixture exists because the first version of the collector was written against
// inferred field names and got most of them wrong. Guessing is not detectable by a test
// written from the same guess, so the test now asserts against real bytes.
//
// Source experiment: "[KCM-PDP] Price per Gummy", 5aacbb4f-c08e-49f0-853f-dce08fd83446.

/** POST /v25-10-beta/analytics/resource/{experienceId}  body: {view:"overview", testResult:true} */
export const ANALYTICS_RESPONSE = {
  datasetId: "variation_overview",
  cogsConfigured: false,
  cogsCoveragePct: 0,
  experienceId: "5aacbb4f-c08e-49f0-853f-dce08fd83446",
  experienceName: "[KCM-PDP] Price per Gummy",
  impact: { est_monthly_revenue_increase: 3157 },

  // Verdict is an OBJECT under `testResult`, not a bare string, and it carries the
  // runtime and per-variant order counts the readiness gate needs.
  testResult: {
    verdict: "not_ready",
    runtime_days: 42,
    orders_per_variant: {
      "4a7e42a5-96eb-4f80-80d8-397a78a7a3f4": 254,
      "dfd20126-82c8-46bc-af7d-5f5b98ec9637": 238,
    },
  },

  // Metrics and variations are SEPARATE arrays, joined on variation_id.
  metrics: [
    {
      variation_id: "4a7e42a5-96eb-4f80-80d8-397a78a7a3f4",
      conversion_rate: {
        value: 0.03953307392996109,
        // uplift is an object, and it is a FRACTION, not a percentage.
        uplift: { value: 0.04878919661249714, ci_low: -0.11844342350959777, ci_high: 0.24435714781284323, plus_minus: 0.1814 },
        p2bb: 0.711899995803833,
        p2bc: 0.7119,
        ci_low: 0.034950127452611925,
        ci_high: 0.044600605871528386,
        plus_minus: 0.0048252392094582305,
      },
      net_revenue_per_visitor: {
        value: 2.4899346425097275,
        uplift: { value: 0.1588629649876816, ci_low: -0.09483039677143096, ci_high: 0.4821223288774489, plus_minus: 0.2884 },
        p2bb: 0.8783000111579895,
        p2bc: 0.8783,
        ci_low: 2.090935564041138,
        ci_high: 2.949462634325027,
      },
      net_revenue_per_order: {
        value: 62.983582984744096,
        uplift: { value: 0.10495318671351095, ci_low: -0.07617633491754532, ci_high: 0.31470955312252036 },
        p2bb: 0.8618000149726868,
        p2bc: 0.8618,
        ci_low: 55.770418071746825,
        ci_high: 71.08985233306885,
      },
      add_to_cart_rate: {
        value: 0.10070038910505837,
        uplift: { value: 0.014070585022868398, ci_low: -0.08512568473815918, ci_high: 0.12673099040985106 },
        p2bb: 0.5968999862670898,
        p2bc: 0.5969,
        ci_low: 0.09349396023899317,
        ci_high: 0.10853963941335679,
      },
      // Null because COGS is not configured on this account. Must render as
      // "not configured", never as zero.
      gross_profit_per_visitor: null,
      gross_profit_per_order: null,
      // Scalars are wrapped in {value} too.
      n_orders: { value: 254 },
      n_visitors: { value: 6425 },
      net_revenue: { value: 15997.83 },
      // A metric with no interval at all. The P1 band check must skip this, not
      // compare it against zero.
      view_collection_page_rate: {
        value: 0.0029571984435797665,
        uplift: { value: 0.03731949848681371, ci_low: null, ci_high: null, plus_minus: null },
        p2bb: null,
        p2bc: null,
        ci_low: null,
        ci_high: null,
      },
      pct_subscription_orders: { value: 0.6023622047244095, uplift: { value: -0.0926442738961426 } },
    },
    {
      // The control carries no uplift, no p2bc. It is the baseline.
      variation_id: "dfd20126-82c8-46bc-af7d-5f5b98ec9637",
      conversion_rate: { value: 0.037694013303769404, p2bb: 0.288100004196167, ci_low: 0.033317838050425055, ci_high: 0.04259247593581676 },
      net_revenue_per_visitor: { value: 2.148601446191004, p2bb: 0.1216999962925911, ci_low: 1.804889115691185, ci_high: 2.5686480164527894 },
      net_revenue_per_order: { value: 57.0011324842437, p2bb: 0.13819999992847443, ci_low: 50.268117904663086, ci_high: 64.96843318939209 },
      add_to_cart_rate: { value: 0.09930313588850175, p2bb: 0.40310001373291016, ci_low: 0.092282092012465, ci_high: 0.10695992205291986 },
      gross_profit_per_visitor: null,
      gross_profit_per_order: null,
      n_orders: { value: 238 },
      n_visitors: { value: 6314 },
      net_revenue: { value: 13566.27 },
      view_collection_page_rate: { value: 0.0028508077288565093, p2bb: null, ci_low: null, ci_high: null },
      pct_subscription_orders: { value: 0.6638655462184874 },
    },
  ],

  variations: [
    { id: "dfd20126-82c8-46bc-af7d-5f5b98ec9637", experienceId: "5aacbb4f-c08e-49f0-853f-dce08fd83446", name: "mag", percentage: 50, isControl: true, order: 0 },
    { id: "4a7e42a5-96eb-4f80-80d8-397a78a7a3f4", experienceId: "5aacbb4f-c08e-49f0-853f-dce08fd83446", name: "mag alt price", percentage: 50, isControl: false, order: 1 },
  ],
};

/** GET /v25-10-beta/experiences-list  — note the key metrics use camelCase ids. */
export const EXPERIENCE_DETAIL = {
  id: "5aacbb4f-c08e-49f0-853f-dce08fd83446",
  name: "[KCM-PDP] Price per Gummy",
  status: "started",
  category: "experiment",
  type: "content/onsiteEdits",
  createdAtTs: "2026-07-31T15:58:23.436+00:00",
  startedAtTs: "2026-07-31T16:00:43.427+00:00",
  endedAtTs: null,
  variationCount: 2,
  experienceKeyMetrics: [
    { order: 0, isPrimary: false, standardEventId: "conversionRate", experienceCustomMetricId: null },
    { order: 1, isPrimary: false, standardEventId: "netRevenuePerVisitor", experienceCustomMetricId: null },
    { order: 2, isPrimary: false, standardEventId: "profitPerVisitor", experienceCustomMetricId: null },
    { order: 3, isPrimary: false, standardEventId: "netRevenuePerOrder", experienceCustomMetricId: null },
    { order: 4, isPrimary: true, standardEventId: "addToCartRate", experienceCustomMetricId: null },
  ],
};

/**
 * GET /v25-10-beta/experiences-list — the real roster envelope, captured live.
 * The array is under `experiencesList`. Guessing `experiences` returned an empty roster
 * and a run that reported success while seeing no tests at all.
 */
export const EXPERIENCES_LIST = {
  page: 1,
  limit: 50,
  total: 9,
  totalPages: 1,
  experiencesList: [EXPERIENCE_DETAIL],
};

/** The real status set on the Current Sprint list, and the real custom fields. */
export const CLICKUP_LIST = {
  id: "901112668495",
  name: "Current Sprint",
  space: { id: "30101294", name: "WEB" },
  statuses: [
    { status: "to do", type: "open", orderindex: 0 },
    { status: "in-progress", type: "custom", orderindex: 1 },
    { status: "vqa", type: "custom", orderindex: 2 },
    { status: "qa", type: "custom", orderindex: 3 },
    { status: "ready for deploy", type: "custom", orderindex: 4 },
    { status: "complete", type: "closed", orderindex: 5 },
  ],
};

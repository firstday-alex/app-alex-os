// Layer 3 collector. Active tests on the Intelligems experiment platform.
//
// Two official ways in. The MCP Server is the right choice when a human is in the loop
// with Claude. The 8 AM job is not a human in the loop: it is deterministic code on a
// schedule, so it uses the External REST API with the key in the
// `intelligems-access-token` header. The MCP tool each call corresponds to is named in a
// comment beside it, so the two paths stay legible against each other.
//
// The route strings live in config/intelligems.json because the External API is in beta
// and its exact paths must be verified before first deploy. See docs/INTEGRATIONS.md.

import { httpJson } from "../lib/http.js";
import { daysBetween } from "../lib/time.js";
import { describeExperience } from "./experience-diff.js";

const METRICS_CONFIG_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * The timeseries endpoint accepts a DIFFERENT and much smaller metric vocabulary than the
 * analytics endpoint, verified against the live API by asking it for a nonsense metric
 * and reading what it offered back. Notably it calls AOV `aov`, where the analytics
 * response calls the same number `net_revenue_per_order`.
 *
 * Sending an unsupported name fails the whole call with a 400, so anything not on this
 * list is translated if there is an equivalent and dropped if there is not.
 */
export const TIMESERIES_METRICS = new Set([
  "conversion_rate",
  "net_revenue_per_visitor",
  "gross_profit_per_visitor",
  "aov",
  "n_visitors",
  "n_orders",
  "net_revenue",
]);

const TIMESERIES_ALIASES = { net_revenue_per_order: "aov" };

export function timeseriesMetrics(names) {
  const out = [];
  for (const name of names ?? []) {
    const mapped = TIMESERIES_ALIASES[name] ?? name;
    if (TIMESERIES_METRICS.has(mapped) && !out.includes(mapped)) out.push(mapped);
  }
  // Always ask for something: an empty list is also a 400.
  return out.length ? out : ["conversion_rate"];
}

function authHeaders(config, token) {
  return { [config.intelligems.authHeader]: token };
}

function buildUrl(config, endpointName, params = {}, extraQuery = {}) {
  const ig = config.intelligems;
  const endpoint = ig.endpoints?.[endpointName];
  if (!endpoint) throw new Error(`intelligems: no endpoint configured for "${endpointName}"`);

  let pathname = endpoint.path;
  for (const [key, value] of Object.entries(params)) {
    pathname = pathname.replace(`{${key}}`, encodeURIComponent(String(value)));
  }
  const query = new URLSearchParams({ ...(endpoint.query ?? {}), ...extraQuery });
  const qs = query.toString();
  return { url: `${ig.apiBase}${pathname}${qs ? `?${qs}` : ""}`, method: endpoint.method ?? "GET" };
}

async function call({ config, token, logger, fetchImpl, sleep, endpointName, params, query, body: payload, label }) {
  const { url, method } = buildUrl(config, endpointName, params, query);
  const http = config.system.http;
  const { body } = await httpJson(url, {
    method,
    body: method === "POST" ? (payload ?? {}) : undefined,
    headers: authHeaders(config, token),
    logger,
    label: label ?? `intelligems.${endpointName}`,
    fetchImpl,
    timeoutMs: http.timeoutMs,
    maxAttempts: http.maxAttempts,
    backoffMsSchedule: http.backoffMsSchedule,
    sleep,
  });
  return body;
}

/* ------------------------------ normalization ------------------------------ */

/**
 * The metric config and the analytics response name the same metrics differently.
 * `experienceKeyMetrics[].standardEventId` is camelCase; the analytics response keys are
 * snake_case. Without this map, "which metrics does this test care about" resolves to a
 * set of names that match nothing in the results.
 *
 * Note `profitPerVisitor` maps to `gross_profit_per_visitor`, which is null on any account
 * without COGS configured.
 */
export const STANDARD_EVENT_TO_METRIC = {
  conversionRate: "conversion_rate",
  netRevenuePerVisitor: "net_revenue_per_visitor",
  netRevenuePerOrder: "net_revenue_per_order",
  netProductRevenuePerOrder: "net_product_revenue_per_order",
  netShippingRevenuePerOrder: "net_shipping_revenue_per_order",
  profitPerVisitor: "gross_profit_per_visitor",
  profitPerOrder: "gross_profit_per_order",
  addToCartRate: "add_to_cart_rate",
  abandonedCartRate: "abandoned_cart_rate",
  abandonedCheckoutRate: "abandoned_checkout_rate",
  checkoutBeginRate: "checkout_begin_rate",
  viewProductPageRate: "view_product_page_rate",
  viewCollectionPageRate: "view_collection_page_rate",
  avgUnitsPerOrder: "avg_units_per_order",
  netRevenue: "net_revenue",
  nOrders: "n_orders",
  nVisitors: "n_visitors",
  subscriptionRevenuePerVisitor: "subscription_revenue_per_visitor",
  subscriptionOrdersPerVisitor: "subscription_orders_per_visitor",
  pctSubscriptionOrders: "pct_subscription_orders",
};

export function metricKeyFor(standardEventId) {
  if (!standardEventId) return null;
  return (
    STANDARD_EVENT_TO_METRIC[standardEventId] ??
    // Fall back to a camelCase -> snake_case conversion rather than dropping an unknown
    // metric silently. If Intelligems adds one, this usually still lands on the right key.
    String(standardEventId).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
  );
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * One metric, from the real analytics shape:
 *
 *   conversion_rate: {
 *     value, ci_low, ci_high, plus_minus,
 *     uplift: { value, ci_low, ci_high, plus_minus },   // a FRACTION, not a percent
 *     p2bb,  // probability to be best
 *     p2bc,  // probability to beat control
 *   }
 *
 * The control variation carries no `uplift` and no `p2bc`: it is the baseline.
 * A scalar metric arrives as `{ value: 254 }` with no interval at all.
 * A null metric means not configured (profit metrics without COGS), never zero.
 */
export function normalizeMetric(name, raw) {
  const missing = {
    name,
    value: null,
    interval: null,
    uplift: null,
    upliftPct: null,
    upliftInterval: null,
    probBeatControl: null,
    probBest: null,
    configured: false,
  };
  if (raw == null) return missing;
  if (typeof raw === "number") return { ...missing, value: raw, configured: true };

  const low = num(raw.ci_low);
  const high = num(raw.ci_high);
  const uplift = raw.uplift ?? null;
  const upliftValue = num(uplift?.value);
  const upliftLow = num(uplift?.ci_low);
  const upliftHigh = num(uplift?.ci_high);
  const value = num(raw.value);

  return {
    name,
    value,
    interval: low != null && high != null ? [low, high] : null,
    // Kept as the fraction the API returned; `upliftPct` is the display form, so no
    // caller has to remember which one it is holding.
    uplift: upliftValue,
    upliftPct: upliftValue == null ? null : upliftValue * 100,
    upliftInterval: upliftLow != null && upliftHigh != null ? [upliftLow, upliftHigh] : null,
    probBeatControl: num(raw.p2bc),
    probBest: num(raw.p2bb),
    configured: value != null,
  };
}

/**
 * Metrics and variations come back as two separate arrays joined on variation_id, and the
 * per-variant order counts live in a third place: testResult.orders_per_variant.
 */
export function normalizeGroups(analysis, metricNames) {
  const variations = analysis?.variations ?? [];
  const metricRows = new Map((analysis?.metrics ?? []).map((row) => [String(row.variation_id), row]));
  const ordersPerVariant = analysis?.testResult?.orders_per_variant ?? {};

  return variations.map((variation) => {
    const id = String(variation.id);
    const row = metricRows.get(id) ?? {};
    const metrics = {};
    for (const name of metricNames) metrics[name] = normalizeMetric(name, row[name]);

    // Prefer the verdict block's count, which is what the platform's own gate uses.
    const orders = num(ordersPerVariant[id]) ?? num(row.n_orders?.value);

    return {
      id,
      name: variation.name ?? null,
      isControl: Boolean(variation.isControl),
      percentage: num(variation.percentage),
      orders,
      visitors: num(row.n_visitors?.value),
      netRevenue: num(row.net_revenue?.value),
      metrics,
    };
  });
}

/**
 * Which metrics to pull for one test: the metrics the test itself is configured on,
 * translated to analytics keys, plus the always-watch P0 and P1 lists.
 */
/** Every metric named anywhere in the experiment tree, roots and leaves alike. */
export function treeMetricNames(treeSpec) {
  const out = [];
  const walk = (node) => {
    if (node?.metric) out.push(node.metric);
    (node?.children ?? []).forEach(walk);
  };
  (treeSpec?.roots ?? []).forEach(walk);
  return out;
}

export function metricNamesFor(config, experienceDetail) {
  const configured = (experienceDetail?.experienceKeyMetrics ?? [])
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((m) => metricKeyFor(m.standardEventId))
    .filter(Boolean);

  const p0 = config.intelligems.metrics?.p0 ?? [];
  const p1 = config.intelligems.metrics?.p1 ?? [];
  // The tree's metrics too. The analytics response carries them all regardless; without
  // this the collector filters them out and every branch below the roots reads "No data",
  // which looks like the platform returned nothing rather than like we discarded it.
  const tree = treeMetricNames(config.intelligems.metricTree);

  return [...new Set([...p0, ...configured, ...p1, ...tree])];
}

/** The metric this specific test is actually being judged on, when one is marked primary. */
export function primaryMetricFor(experienceDetail) {
  const primary = (experienceDetail?.experienceKeyMetrics ?? []).find((m) => m.isPrimary);
  return primary ? metricKeyFor(primary.standardEventId) : null;
}

export function normalizeExperiment({ experiment, analysis, detail, config, now }) {
  const startedAt = experiment.startedAtTs ?? experiment.startedAt ?? null;
  const metricNames = metricNamesFor(config, detail ?? experiment);
  const groups = normalizeGroups(analysis, metricNames);

  const verdictBlock = analysis?.testResult ?? null;
  const orderCounts = groups.map((g) => g.orders).filter((n) => typeof n === "number");

  return {
    id: String(experiment.id),
    name: experiment.name ?? null,
    status: experiment.status ?? null,
    category: experiment.category ?? null,
    startedAt,
    // The platform reports runtime directly. Fall back to computing it only if absent.
    daysRunning: num(verdictBlock?.runtime_days) ?? (startedAt ? daysBetween(startedAt, now.toISOString()) : null),
    verdict: verdictBlock?.verdict ?? null,
    groups,
    minOrdersPerGroup: orderCounts.length ? Math.min(...orderCounts) : null,
    totalOrders: orderCounts.length ? orderCounts.reduce((a, b) => a + b, 0) : null,
    metricNames,
    primaryMetric: primaryMetricFor(detail ?? experiment),
    metricsConfigured: metricNames.length > 0,
    // What is actually different between control and variant. A number is unreadable
    // without it.
    experienceDiff: describeExperience(detail ?? experiment),
    // Whether profit metrics mean anything on this account at all.
    cogsConfigured: analysis?.cogsConfigured ?? null,
    cogsCoveragePct: num(analysis?.cogsCoveragePct),
    estMonthlyRevenueImpact: num(analysis?.impact?.est_monthly_revenue_increase),
    postTest: analysis?.postTest ?? null,
    timeseriesStabilized: null, // set by the timeseries pass
  };
}

/**
 * Cumulative timeseries tells us whether results have stabilized or are still swinging.
 * A test whose last few days keep moving the cumulative number is not settled, whatever
 * the verdict says.
 */
export function assessStability(timeseries, { window = 3, tolerancePct = 2 } = {}) {
  // The real shape: { segments: { "<variation name>": { data: [{ dt, <metric>: value }] } } }.
  // Not a flat points array, which is what an earlier version looked for — and finding
  // nothing, it reported "not enough points" on every test forever.
  const segments = timeseries?.segments;
  let series = [];

  if (segments && typeof segments === "object") {
    const first = Object.values(segments).find((s) => Array.isArray(s?.data) && s.data.length);
    if (first) {
      const metricKey = Object.keys(first.data[0] ?? {}).find((k) => k !== "dt");
      series = first.data.map((point) => point[metricKey]).filter((v) => typeof v === "number");
    }
  } else {
    const points = timeseries?.points ?? timeseries?.data ?? [];
    series = points
      .map((p) => (typeof p.value === "number" ? p.value : typeof p.cumulative === "number" ? p.cumulative : null))
      .filter((v) => v != null);
  }

  if (series.length < window + 1) return { stabilized: null, reason: "not enough points" };

  const recent = series.slice(-(window + 1));
  const swings = [];
  for (let i = 1; i < recent.length; i += 1) {
    const prev = recent[i - 1];
    if (prev === 0) continue;
    swings.push(Math.abs((recent[i] - prev) / prev) * 100);
  }
  if (swings.length === 0) return { stabilized: null, reason: "no comparable points" };
  const worst = Math.max(...swings);
  return { stabilized: worst <= tolerancePct, worstSwingPct: Number(worst.toFixed(2)), points: series.length };
}

/* -------------------------------- collection -------------------------------- */

/**
 * The daily roster: every experiment with status "started".
 *
 * GET /experiences-list. Pagination is 1-based here, not 0-based like ClickUp's, and the
 * envelope reports totalPages, so termination is explicit rather than inferred.
 */
/**
 * Pull the list of experiences out of the roster envelope.
 *
 * The real key is `experiencesList`. An earlier version guessed `experiences`, matched
 * nothing, and returned an empty roster — which is a legitimate answer, so the run
 * reported success while silently reporting no tests at all. Hence the fallback: if no
 * known key matches, take the only array-valued property and say so in the log, rather
 * than quietly reporting that nothing is running.
 */
export function rosterArray(body, logger) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];

  for (const key of ["experiencesList", "experiences", "data", "results", "items"]) {
    if (Array.isArray(body[key])) return body[key];
  }

  const arrayKeys = Object.entries(body).filter(([, v]) => Array.isArray(v));
  if (arrayKeys.length === 1) {
    logger?.warn?.("intelligems.roster_key_unexpected", {
      usedKey: arrayKeys[0][0],
      knownKeys: ["experiencesList", "experiences", "data", "results", "items"],
      note: "The roster envelope changed shape. Add this key to the known list.",
    });
    return arrayKeys[0][1];
  }

  logger?.error?.("intelligems.roster_unreadable", { keys: Object.keys(body).slice(0, 12) });
  return [];
}

export async function fetchRoster({ config, token, logger, fetchImpl, sleep }) {
  const maxPages = config.system.http.maxPages ?? 50;
  const all = [];
  let page = 1;
  let totalPages = 1;

  for (; page <= Math.min(totalPages, maxPages); page += 1) {
    const body = await call({
      config,
      token,
      logger,
      fetchImpl,
      sleep,
      endpointName: "experiencesList",
      query: { page: String(page), limit: "50", status: "started" },
    });
    const batch = rosterArray(body, logger);
    all.push(...batch);
    totalPages = Number(body?.totalPages ?? 1) || 1;
    if (batch.length === 0) break;
  }

  // Belt and braces: the roster endpoint may not filter server-side on every version.
  const started = all.filter((e) => !e.status || e.status === "started");

  // A personalization is an always-on targeting rule, not a test. It has no control to
  // measure against, so a verdict, a readiness gate and an audience breakdown all mean
  // nothing for it, and every one of those costs an API call. The platform labels them
  // itself, so this is a field read rather than a guess about the name.
  const include = config.intelligems.categories?.include ?? ["experiment"];
  const kept = started.filter((e) => !e.category || include.includes(e.category));
  const setAside = started.filter((e) => e.category && !include.includes(e.category));

  if (setAside.length) {
    logger?.info?.("intelligems.roster_filtered", {
      kept: kept.length,
      setAside: setAside.map((e) => ({ name: e.name, category: e.category })),
    });
  }

  // An explicit pair, not an array with a property bolted on: the second half is the
  // part that would otherwise vanish, and a shape that survives a .map() is worth more
  // than the one line it saves at the call site.
  return {
    experiences: kept,
    setAside: setAside.map((e) => ({ id: String(e.id), name: e.name, category: e.category })),
  };
}

export async function collectIntelligems({ config, token, store, logger, fetchImpl, sleep, now = new Date() }) {
  if (!token) throw new Error("INTELLIGEMS_TOKEN is not set");

  const { experiences: roster, setAside } = await fetchRoster({ config, token, logger, fetchImpl, sleep });

  const tests = [];
  const failures = [];

  for (const experiment of roster) {
    const experienceId = String(experiment.id);
    try {
      // The per-test metric config rides on the experience object; there is no separate
      // metrics-config endpoint. Cached, because it changes far less often than results.
      // A cache that can hold a useless value and serve it for a week is a bug, not a
      // cache. `if (!detail)` passes on `{}`, which is exactly what a partial or wrapped
      // response leaves behind — and then every downstream field silently reads empty.
      // Validate the shape, not merely the presence.
      const usable = (d) => Boolean(d && Array.isArray(d.variations) && d.variations.length > 0);

      let detail = await store?.getCached(`intelligems/experience/${experienceId}`, {
        ttlSeconds: METRICS_CONFIG_TTL_SECONDS,
      });
      if (detail && !usable(detail)) {
        logger?.warn?.("intelligems.experience_cache_unusable", {
          experienceId,
          keys: Object.keys(detail).slice(0, 10),
          note: "cached experience detail has no variations; refetching",
        });
        detail = null;
      }
      if (!detail) {
        const body = await call({
          config,
          token,
          logger,
          fetchImpl,
          sleep,
          endpointName: "experience",
          params: { experienceId },
        });
        // The experience endpoint wraps its payload: { experience: {...} }. The roster
        // endpoint does not. Unwrap defensively rather than assuming either shape — an
        // earlier check that unwrapped it by hand is exactly how this went unnoticed.
        detail = body?.experience ?? body;
        // Only cache something worth reading back.
        if (store && usable(detail)) await store.setCached(`intelligems/experience/${experienceId}`, detail);
        else if (!usable(detail)) {
          logger?.warn?.("intelligems.experience_detail_thin", {
            experienceId,
            keys: detail ? Object.keys(detail).slice(0, 10) : null,
            note: "the experience endpoint returned no variations; not cached, and the difference view will be empty for this test",
          });
        }
      }

      // The main results call. POST, not GET. `testResult: true` is what makes the
      // platform compute and return its verdict.
      const analysis = await call({
        config,
        token,
        logger,
        fetchImpl,
        sleep,
        endpointName: "analytics",
        params: { experienceId },
        body: { view: "overview", testResult: true },
      });

      const test = normalizeExperiment({ experiment, analysis, detail, config, now });

      // Cumulative timeseries: stabilized, or still swinging.
      try {
        const timeseries = await call({
          config,
          token,
          logger,
          fetchImpl,
          sleep,
          endpointName: "timeseries",
          params: { experienceId },
          body: {
            granularity: "day",
            mode: "cumulative",
            metrics: timeseriesMetrics(
              (test.primaryMetric ? [test.primaryMetric] : []).concat(config.intelligems.metrics?.p0 ?? []),
            ),
          },
        });
        test.timeseriesStabilized = assessStability(timeseries);
      } catch (err) {
        logger?.warn?.("intelligems.timeseries_failed", { experienceId, err });
        test.timeseriesStabilized = { stabilized: null, reason: "timeseries call failed" };
      }

      // Audience breakdowns, for tests that can actually be called. One extra request per
      // dimension, so this is deliberately narrow: a test short of the readiness gate
      // cannot be judged by segment either, and pulling it would cost calls to produce
      // nothing readable.
      const audCfg = config.intelligems.audiences;
      const gateReady = test.daysRunning >= (config.intelligems.readinessGate?.minDaysRunning ?? 7)
        && (test.minOrdersPerGroup ?? 0) >= (config.intelligems.readinessGate?.minOrdersPerGroup ?? 300);

      if (audCfg?.pullDuringRun?.length && (!audCfg.onlyWhenGateMet || gateReady)) {
        test.audiences = {};
        for (const dimension of audCfg.pullDuringRun) {
          try {
            test.audiences[dimension] = await call({
              config, token, logger, fetchImpl, sleep,
              endpointName: "analytics",
              params: { experienceId },
              body: { view: "audience", audience: dimension, topN: audCfg.topN ?? 8 },
              label: `intelligems.audience.${dimension}`,
            });
          } catch (err) {
            logger?.warn?.("intelligems.audience_failed", { experienceId, dimension, err });
          }
        }
      }

      // Post-test customer value: the hook for the LTV projection. Optional, and its
      // absence must not cost us the test's main result.
      if (config.intelligems.postTest?.enabled) {
        try {
          test.postTest = await call({
            config,
            token,
            logger,
            fetchImpl,
            sleep,
            endpointName: "analytics",
            params: { experienceId },
            body: { view: "post_test", includeInTestOrders: config.intelligems.postTest.includeInTestOrders ?? true },
          });
        } catch (err) {
          logger?.warn?.("intelligems.post_test_failed", { experienceId, err });
        }
      }

      tests.push(test);
    } catch (err) {
      // One test failing must not lose the other tests.
      logger?.warn?.("intelligems.test_failed", { experienceId, err });
      failures.push({ experienceId, name: experiment.name ?? null, error: err.message });
    }
  }

  const cogsConfigured = tests.length ? tests.every((t) => t.cogsConfigured === true) : null;

  // An empty roster is a real answer, but it is also what a misparsed envelope looks
  // like, and the two are indistinguishable downstream. Say so loudly rather than
  // reporting "0 tests running" as though it were verified.
  if (roster.length === 0) {
    logger?.warn?.("intelligems.roster_empty", {
      note: "No started experiences came back. Either nothing is running, or the roster envelope changed shape.",
    });
  }

  return {
    source: "intelligems",
    takenAt: now.toISOString(),
    items: tests,
    failures,
    // There is no /shop endpoint on the External API. Currency and timezone are recorded
    // in config/references.json instead, from get_shop_info via the MCP server.
    shop: { currency: config.references?.currency ?? null, timezone: config.references?.shopTimezone ?? null },
    cogsConfigured,
    meta: {
      rosterSize: roster.length,
      collected: tests.length,
      failed: failures.length,
      // Not a failure and not a silent drop: named so the dashboard can account for it.
      setAside,
    },
  };
}

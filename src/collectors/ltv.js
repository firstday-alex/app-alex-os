// Lifetime value, measured rather than assumed.
//
// The spec left this as an open question: where do the LTV reference values come from,
// Shopify, Alex, or computed. This answers it — Shopify's own customer cohort analysis,
// split by whether the FIRST order carried a subscription.
//
// Every projection in Layer 3 rests on these two numbers, so the way they are computed
// matters more than it looks. Two decisions in particular:
//
//   1. Only cohorts old enough to HAVE the horizon month are used. A cohort from last
//      month has spent three weeks, not six months, and averaging it in drags the figure
//      toward zero while looking like a real measurement.
//   2. Cohorts are weighted by customer count. An unweighted mean lets a thin month count
//      as much as a fat one.

import { runQuery } from "./shopify.js";

/** amount_spent_per_customer is CUMULATIVE, so the horizon month is the value to read. */
export const PERIOD_FOR_HORIZON = (months) => months - 1;

/**
 * Collapse cohort rows into one weighted figure at the horizon.
 *
 * @param {Array<{month,period,value,customers}>} rows
 * @param {number} horizonMonths
 */
export function weightedLtv(rows, horizonMonths) {
  const target = PERIOD_FOR_HORIZON(horizonMonths);
  const mature = rows.filter((r) => r.period === target && r.value != null && r.customers > 0);

  if (mature.length === 0) {
    return {
      value: null,
      cohorts: 0,
      customers: 0,
      reason: `No cohort has reached month ${target} yet, so a ${horizonMonths} month figure cannot be measured.`,
    };
  }

  const customers = mature.reduce((sum, r) => sum + r.customers, 0);
  const value = mature.reduce((sum, r) => sum + r.value * r.customers, 0) / customers;

  const months = mature.map((r) => r.month).sort();
  return {
    value,
    cohorts: mature.length,
    customers,
    firstCohort: months[0],
    lastCohort: months[months.length - 1],
    // Named so the caller can say what it left out, rather than quietly dropping it.
    excludedCohorts: [...new Set(rows.map((r) => r.month))].filter((m) => !months.includes(m)).sort(),
  };
}

function toRows(table) {
  const columns = (table?.columns ?? []).map((c) => c.name);
  const idx = {
    month: columns.findIndex((c) => c === "month"),
    period: columns.findIndex((c) => c.endsWith("periods_since_first_purchase")),
    value: columns.findIndex((c) => c.endsWith("amount_spent_per_customer")),
    customers: columns.findIndex((c) => c.endsWith("customers_in_cohort")),
  };
  const num = (v) => (v == null || v === "" ? null : Number(v));

  return (table?.rows ?? []).map((row) => {
    const cell = (i) => (Array.isArray(row) ? row[i] : row[columns[i]]);
    return {
      month: String(cell(idx.month) ?? "").slice(0, 7),
      period: num(cell(idx.period)),
      value: num(cell(idx.value)),
      customers: num(cell(idx.customers)) ?? 0,
    };
  });
}

/** The cohort query, built from config so the filters can be changed without a deploy. */
export function buildCohortQuery(config, { subscription }) {
  const spec = config.shopify?.ltv;
  if (!spec) throw new Error("config.shopify.ltv is not configured");
  const channel = spec.salesChannel ? ` OR customer_cohorts_monthly_is_placeholder_row = true` : "";

  // The placeholder-row clauses are what the cohort grid needs to return a full table;
  // without them the query errors rather than returning fewer rows.
  return [
    "FROM customer_cohorts_monthly",
    "SHOW customer_cohorts_monthly_amount_spent_per_customer, customer_cohorts_monthly_customers_in_cohort",
    `WHERE ((first_order_has_subscription = ${subscription ? "true" : "false"} OR customer_cohorts_monthly_is_placeholder_row = true)`,
    spec.salesChannel
      ? `AND (first_order_sales_channel = '${spec.salesChannel}'${channel}))`
      : ")",
    `AND customer_cohorts_monthly_periods_since_first_purchase BETWEEN -1 AND ${spec.maxPeriod ?? 11}`,
    "GROUP BY month, customer_cohorts_monthly_periods_since_first_purchase",
    "HAVING customer_cohorts_monthly_periods_since_first_purchase >= 0",
    `SINCE ${spec.since ?? "startOfMonth(-12m)"} UNTIL ${spec.until ?? "endOfMonth(-1m)"}`,
    "ORDER BY month ASC",
  ].join(" ");
}

/**
 * Measure both LTV figures. Returns what Settings would store, plus the provenance.
 */
export async function measureLtv({ config, token, env, store, logger, fetchImpl, sleep, horizonMonths, now = new Date() }) {
  const horizon = horizonMonths ?? config.shopify?.ltv?.horizonMonths ?? 6;

  const run = async (subscription) => {
    const query = buildCohortQuery(config, { subscription });
    const { metrics, ...rest } = await runQuery({
      config, token, query, logger, fetchImpl, sleep,
      label: `shopify.ltv.${subscription ? "subscription" : "one_time"}`,
      raw: true,
    });
    return { query, table: rest.table };
  };

  const [sub, one] = await Promise.all([run(true), run(false)]);
  const subLtv = weightedLtv(toRows(sub.table), horizon);
  const oneLtv = weightedLtv(toRows(one.table), horizon);

  return {
    horizonMonths: horizon,
    measuredAt: now.toISOString(),
    subscription: subLtv,
    oneTime: oneLtv,
    ratio: subLtv.value != null && oneLtv.value ? subLtv.value / oneLtv.value : null,
    salesChannel: config.shopify?.ltv?.salesChannel ?? null,
    queries: { subscription: sub.query, oneTime: one.query },
  };
}

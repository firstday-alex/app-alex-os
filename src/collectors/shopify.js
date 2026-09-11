// Layer 0. Store-wide metrics, from ShopifyQL.
//
// Why this layer exists: Layer 3 tells you a test moved a number. This tells you whether
// the whole store moved, which is the difference between "the variant won" and "Tuesday
// was busy". Without it a sitewide swing can be read as a test result.
//
// ShopifyQL is aggregated reporting and is read-only by construction: FROM ... SHOW.
// There is no mutation surface here and the collector refuses to send anything else.
//
// Run through the Admin GraphQL `shopifyqlQuery` field, which is the only way to reach
// ShopifyQL from server-side code.

import { httpJson } from "../lib/http.js";

const GRAPHQL = `query Run($q: String!) {
  shopifyqlQuery(query: $q) {
    __typename
    ... on TableResponse {
      tableData { columns { name dataType } rows }
    }
    parseErrors { code message range { start { line character } end { line character } } }
  }
}`;

/**
 * ShopifyQL is read-only, but a query string arrives from config and config is editable
 * by the learning skill. Refuse anything that is not a read before it is ever sent.
 */
export function assertReadOnly(query) {
  const text = String(query ?? "").trim();
  if (!/^FROM\s/i.test(text)) {
    throw new Error(`ShopifyQL must begin with FROM. Refusing to send: ${text.slice(0, 60)}`);
  }
  const banned = /\b(mutation|delete|update|insert|drop|create|alter)\b/i;
  if (banned.test(text)) {
    throw new Error(`ShopifyQL query contains a write keyword and will not be sent: ${text.slice(0, 60)}`);
  }
  return text;
}

/** Values come back as strings, including for INTEGER and MONEY. */
function toNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Turn columns+rows into { metric: {value, previous, changePct} }.
 *
 * A COMPARE TO query returns the comparison as extra columns named
 * `comparison_<metric>__previous_period`, so the current and prior values arrive in the
 * same row and no second request is needed.
 */
export function parseTable(tableData) {
  const columns = (tableData?.columns ?? []).map((c) => c.name);
  const types = Object.fromEntries((tableData?.columns ?? []).map((c) => [c.name, c.dataType]));
  const row = (tableData?.rows ?? [])[0] ?? [];

  const values = {};
  columns.forEach((name, index) => {
    values[name] = toNumber(row[index]);
  });

  const metrics = {};
  for (const name of columns) {
    if (name.startsWith("comparison_")) continue;
    const comparisonKey = `comparison_${name}__previous_period`;
    const value = values[name];
    const previous = Object.prototype.hasOwnProperty.call(values, comparisonKey) ? values[comparisonKey] : null;
    metrics[name] = {
      metric: name,
      value,
      previous,
      dataType: types[name] ?? null,
      // Percent change against the prior period. Null rather than Infinity when the prior
      // period was zero: "up from nothing" is not a percentage.
      changePct:
        value == null || previous == null || previous === 0
          ? null
          : ((value - previous) / Math.abs(previous)) * 100,
    };
  }
  return { metrics, rowCount: (tableData?.rows ?? []).length, columns };
}

export async function runQuery({ config, token, query, logger, fetchImpl, sleep, label }) {
  const sc = config.shopify;
  const safe = assertReadOnly(query);
  const http = config.system.http;

  const { body } = await httpJson(`https://${sc.shopDomain}/admin/api/${sc.apiVersion}/graphql.json`, {
    method: "POST",
    headers: { "x-shopify-access-token": token },
    body: { query: GRAPHQL, variables: { q: safe } },
    logger,
    label: label ?? "shopify.shopifyql",
    fetchImpl,
    sleep,
    timeoutMs: http.timeoutMs,
    maxAttempts: http.maxAttempts,
    backoffMsSchedule: http.backoffMsSchedule,
  });

  // GraphQL answers 200 with an errors array. Surface it rather than returning nothing.
  if (body?.errors?.length) {
    throw new Error(`shopifyql: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  const result = body?.data?.shopifyqlQuery;
  if (result?.parseErrors?.length) {
    throw new Error(`shopifyql parse error: ${result.parseErrors.map((e) => e.message).join("; ")}`);
  }
  // A tableData that is absent is different from one that is empty, and only the first
  // is a problem.
  if (!result?.tableData) {
    throw new Error(`shopifyql returned no table for: ${safe.slice(0, 70)}`);
  }
  return parseTable(result.tableData);
}

export async function collectShopify({ config, token, logger, fetchImpl, sleep, now = new Date() }) {
  if (!token) throw new Error("SHOPIFY_ADMIN_TOKEN is not set");
  const sc = config.shopify;
  if (!sc?.shopDomain) throw new Error("config.shopify.shopDomain is not set");

  const results = {};
  const failures = [];

  for (const [name, query] of Object.entries(sc.queries ?? {})) {
    if (name.startsWith("_")) continue;
    try {
      results[name] = await runQuery({ config, token, query, logger, fetchImpl, sleep, label: `shopify.${name}` });
    } catch (err) {
      // One query failing loses that query's tiles, not the whole layer.
      logger?.warn?.("shopify.query_failed", { query: name, err });
      failures.push({ query: name, error: err.message });
    }
  }

  // Flatten to the tiles the dashboard renders, in configured order.
  const tiles = (sc.tiles ?? []).map((tile) => {
    const metric = results[tile.from]?.metrics?.[tile.metric] ?? null;
    return {
      ...tile,
      value: metric?.value ?? null,
      previous: metric?.previous ?? null,
      changePct: metric?.changePct ?? null,
      // A tile whose query failed is missing, not zero.
      available: Boolean(metric),
      reason: metric ? null : (failures.find((f) => f.query === tile.from)?.error ?? "metric not returned by its query"),
    };
  });

  return {
    source: "shopify",
    takenAt: now.toISOString(),
    shopDomain: sc.shopDomain,
    currency: sc.currency ?? null,
    // `items` is what the storage layer counts to decide whether a snapshot collapsed.
    items: tiles.filter((t) => t.available),
    tiles,
    queries: results,
    failures,
    meta: { queries: Object.keys(results).length, failed: failures.length, tiles: tiles.length },
  };
}

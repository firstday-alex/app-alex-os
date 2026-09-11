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

/** One row of a query result, as { metric: value }. Values arrive as strings. */
export function parseTable(tableData) {
  const columns = (tableData?.columns ?? []).map((c) => c.name);
  const types = Object.fromEntries((tableData?.columns ?? []).map((c) => [c.name, c.dataType]));
  const row = (tableData?.rows ?? [])[0] ?? [];

  const metrics = {};
  columns.forEach((name, index) => {
    metrics[name] = toNumber(row[index]);
  });
  return { metrics, types, columns, rowCount: (tableData?.rows ?? []).length };
}

/** Assembles FROM ... SHOW ... WHERE ... SINCE ... UNTIL ... from config. */
export function buildQuery(config, queryName, windowName) {
  const sc = config.shopify;
  const spec = sc.queries?.[queryName];
  const win = sc.windows?.[windowName];
  if (!spec) throw new Error(`No Shopify query named "${queryName}"`);
  if (!win) throw new Error(`No Shopify window named "${windowName}"`);

  const where = spec.filter ? sc.filters?.[spec.filter] : null;
  if (spec.filter && !where) throw new Error(`Query "${queryName}" names filter "${spec.filter}", which does not exist`);

  return [
    `FROM ${spec.schema}`,
    `SHOW ${spec.show}`,
    where ? `WHERE ${where}` : null,
    `SINCE ${win.since} UNTIL ${win.until}`,
    spec.orderBy ? `ORDER BY ${spec.orderBy}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Evaluate a derived formula over one window's results.
 *
 * An identifier is either a bare metric (resolved against the formula's own `from` query)
 * or a `query.metric` reference, which is what lets Sub. Opt-In divide one query's
 * numerator by another query's denominator while both share a filter base.
 *
 * Only identifiers, numbers, arithmetic and parentheses are permitted, and every
 * identifier must be a metric a query actually returned. Formulas are config, and config
 * is editable by the learning skill, so this is parsed rather than eval'd.
 */
export function evaluateFormula(formula, scope, { defaultQuery = null } = {}) {
  const tokens = String(formula).match(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?|\d+(?:\.\d+)?|[()+\-*/]/g) ?? [];
  if (tokens.join(" ").replace(/\s+/g, "") !== String(formula).replace(/\s+/g, "")) {
    throw new Error(`Formula contains characters that are not arithmetic: ${formula}`);
  }

  const resolve = (name) => {
    if (name.includes(".")) {
      const [queryName, metricName] = name.split(".");
      const metrics = scope?.[queryName]?.metrics;
      if (!metrics) throw new Error(`Formula references query "${queryName}", which did not return`);
      if (!Object.prototype.hasOwnProperty.call(metrics, metricName)) {
        throw new Error(`Formula references "${name}", which query "${queryName}" did not return`);
      }
      return metrics[metricName];
    }
    const metrics = defaultQuery ? scope?.[defaultQuery]?.metrics : null;
    if (!metrics || !Object.prototype.hasOwnProperty.call(metrics, name)) {
      throw new Error(`Formula references "${name}", which the query did not return`);
    }
    return metrics[name];
  };

  const parts = [];
  for (const token of tokens) {
    if (!/^[A-Za-z_]/.test(token)) {
      parts.push(token);
      continue;
    }
    const value = resolve(token);
    if (value == null) return null; // a missing input makes the result unknown, not zero
    parts.push(String(value));
  }

  // eslint-disable-next-line no-new-func -- every token above is a number or an operator.
  const result = Function(`"use strict"; return (${parts.join(" ")});`)();
  return Number.isFinite(result) ? result : null;
}

/**
 * Compare a primary window against another.
 *
 * A 'rate' (an average, a ratio) is already normalized and compares directly. A 'total'
 * is not: MTD gross sales against a 7 day total measures the length of the window, not
 * the business. Totals are put on a per-day footing first.
 */
export function compareWindows(primary, other, { kind, primaryDays, otherDays }) {
  if (primary == null || other == null) return { changePct: null, basis: kind === "total" ? "per day" : "direct" };

  if (kind === "total") {
    if (!primaryDays || !otherDays) return { changePct: null, basis: "per day", reason: "window length unknown" };
    const a = primary / primaryDays;
    const b = other / otherDays;
    if (b === 0) return { changePct: null, basis: "per day" };
    return { changePct: ((a - b) / Math.abs(b)) * 100, basis: "per day", primaryPerDay: a, otherPerDay: b };
  }

  if (other === 0) return { changePct: null, basis: "direct" };
  return { changePct: ((primary - other) / Math.abs(other)) * 100, basis: "direct" };
}

/** Days elapsed in a window. MTD has no fixed length, so it is counted. */
export function windowDays(win, now) {
  if (win.days) return win.days;
  if (String(win.since).startsWith("startOfMonth")) {
    return now.getUTCDate(); // days elapsed this month, including today
  }
  const relative = String(win.since).match(/^-(\d+)d$/);
  return relative ? Number(relative[1]) : null;
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

  if (body?.errors?.length) {
    throw new Error(`shopifyql: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  const result = body?.data?.shopifyqlQuery;
  if (result?.parseErrors?.length) {
    throw new Error(`shopifyql parse error: ${result.parseErrors.map((e) => e.message).join("; ")}`);
  }
  if (!result?.tableData) {
    throw new Error(`shopifyql returned no table for: ${safe.slice(0, 70)}`);
  }
  return parseTable(result.tableData);
}

export async function collectShopify({ config, token, logger, fetchImpl, sleep, now = new Date() }) {
  if (!token) throw new Error("SHOPIFY_ADMIN_TOKEN is not set");
  const sc = config.shopify;
  if (!sc?.shopDomain) throw new Error("config.shopify.shopDomain is not set");

  const windowNames = Object.keys(sc.windows ?? {}).filter((k) => !k.startsWith("_"));
  const queryNames = Object.keys(sc.queries ?? {}).filter((k) => !k.startsWith("_"));
  const primaryName = windowNames.find((k) => sc.windows[k].primary) ?? windowNames[0];

  /** results[window][query] = { metrics } */
  const results = {};
  const failures = [];

  for (const windowName of windowNames) {
    results[windowName] = {};
    for (const queryName of queryNames) {
      try {
        const query = buildQuery(config, queryName, windowName);
        results[windowName][queryName] = await runQuery({
          config, token, query, logger, fetchImpl, sleep,
          label: `shopify.${queryName}.${windowName}`,
        });
      } catch (err) {
        logger?.warn?.("shopify.query_failed", { query: queryName, window: windowName, err });
        failures.push({ query: queryName, window: windowName, error: err.message });
      }
    }

    // Derived metrics are computed per window from that window's own numbers.
    results[windowName].derived = { metrics: {} };
    for (const [name, spec] of Object.entries(sc.derived ?? {})) {
      if (name.startsWith("_")) continue;
      try {
        results[windowName].derived.metrics[name] = evaluateFormula(spec.formula, results[windowName], {
          defaultQuery: spec.from ?? null,
        });
      } catch (err) {
        logger?.warn?.("shopify.formula_failed", { derived: name, window: windowName, err });
        failures.push({ query: `derived.${name}`, window: windowName, error: err.message });
      }
    }
  }

  const daysFor = Object.fromEntries(windowNames.map((w) => [w, windowDays(sc.windows[w], now)]));
  const comparisonWindows = windowNames.filter((w) => w !== primaryName);

  const tiles = (sc.tiles ?? []).map((tile) => {
    const value = results[primaryName]?.[tile.from]?.metrics?.[tile.metric] ?? null;
    const kind = tile.kind ?? sc.derived?.[tile.metric]?.kind ?? "total";

    const comparisons = comparisonWindows.map((windowName) => {
      const other = results[windowName]?.[tile.from]?.metrics?.[tile.metric] ?? null;
      const cmp = compareWindows(value, other, {
        kind,
        primaryDays: daysFor[primaryName],
        otherDays: daysFor[windowName],
      });
      return {
        window: windowName,
        label: sc.windows[windowName].label,
        value: other,
        changePct: cmp.changePct == null ? null : Number(cmp.changePct.toFixed(1)),
        basis: cmp.basis,
      };
    });

    const reason =
      value != null
        ? null
        : (failures.find((f) => f.query === tile.from || f.query === `derived.${tile.metric}`)?.error ??
           "metric not returned by its query");

    // The plain-language definition, for the info hover. A metric nobody can check the
    // definition of is a metric nobody should act on.
    const description = sc.derived?.[tile.metric]?.description ?? tile.description ?? null;
    const filterName = sc.queries?.[tile.from]?.filter ?? sc.queries?.[sc.derived?.[tile.metric]?.from]?.filter ?? null;

    return {
      ...tile,
      kind,
      value,
      comparisons,
      available: value != null,
      reason,
      description,
      formula: sc.derived?.[tile.metric]?.formula ?? null,
      filter: filterName ? sc.filters?.[filterName] ?? null : null,
    };
  });

  return {
    source: "shopify",
    takenAt: now.toISOString(),
    shopDomain: sc.shopDomain,
    currency: sc.currency ?? null,
    primaryWindow: { key: primaryName, label: sc.windows[primaryName].label, days: daysFor[primaryName] },
    windows: windowNames.map((w) => ({ key: w, label: sc.windows[w].label, days: daysFor[w] })),
    items: tiles.filter((t) => t.available),
    tiles,
    failures,
    meta: { windows: windowNames.length, queries: queryNames.length, failed: failures.length, tiles: tiles.length },
  };
}

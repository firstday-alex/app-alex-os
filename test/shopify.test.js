// Layer 0. Store-wide metrics from ShopifyQL.
//
// Every query and window here was run against the live First Day store before the
// collector was written, and the numbers below are the ones it returned. Asserting
// against real bytes rather than an assumed envelope is the direct lesson from Layer 3,
// where a guessed response key left the readout confidently reporting nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTable,
  assertReadOnly,
  buildQuery,
  evaluateFormula,
  compareWindows,
  windowDays,
  runQuery,
  collectShopify,
} from "../src/collectors/shopify.js";
import { testConfig } from "./fixtures/config.js";

/** What the live store returned for the MTD / 7D / 30D windows, new customers, online store. */
const LIVE = {
  mtd: { gross_sales: 1091905.36, discounts: -407198.9, shipping_charges: 8118.1, orders: 9902 },
  d7: { gross_sales: 861590.86, discounts: -322927.03, shipping_charges: 6525.03, orders: 7769 },
  d30: { gross_sales: 3771602.78, discounts: -1379177.66, shipping_charges: 29749.07, orders: 35445 },
};

const tableFor = (row) => ({
  columns: Object.keys(row).map((name) => ({ name, dataType: name === "orders" ? "INTEGER" : "MONEY" })),
  rows: [Object.values(row).map(String)],
});

const SUB_ORDERS = { mtd: 7385, d7: 5800, d30: 26000 };

const liveFetch = async (url, opts) => {
  const q = JSON.parse(opts.body).variables.q;
  const win = q.includes("startOfMonth") ? "mtd" : q.includes("-7d") ? "d7" : "d30";
  if (q.includes("subscription_or_one_time")) {
    return {
      status: 200, headers: new Headers(),
      text: async () => JSON.stringify({ data: { shopifyqlQuery: { __typename: "TableResponse", parseErrors: [],
        tableData: { columns: [{ name: "orders", dataType: "INTEGER" }], rows: [[String(SUB_ORDERS[win])]] } } } }),
    };
  }
  return {
    status: 200,
    headers: new Headers(),
    text: async () =>
      JSON.stringify({ data: { shopifyqlQuery: { __typename: "TableResponse", parseErrors: [], tableData: tableFor(LIVE[win]) } } }),
  };
};

/* ------------------------------ read-only guard ------------------------------ */

test("anything that is not a FROM query is refused before it is sent", () => {
  // Queries live in config, and config is editable by the learning skill.
  assert.throws(() => assertReadOnly("mutation { productCreate }"), /must begin with FROM/);
  assert.throws(() => assertReadOnly("DELETE FROM sales"), /must begin with FROM/);
  assert.throws(() => assertReadOnly("FROM sales SHOW orders; DROP TABLE x"), /write keyword/);
  assert.equal(assertReadOnly("  FROM sales SHOW orders  "), "FROM sales SHOW orders");
});

/* ------------------------------- query build ------------------------------- */

test("a query is assembled from config, with the same filter across every window", () => {
  const config = testConfig();
  const mtd = buildQuery(config, "acquisition", "mtd");
  const d30 = buildQuery(config, "acquisition", "d30");

  assert.match(mtd, /^FROM sales SHOW gross_sales, discounts, shipping_charges, orders WHERE /);
  assert.match(mtd, /SINCE startOfMonth\(0m\) UNTIL today$/);
  assert.match(d30, /SINCE -30d UNTIL today$/);

  // The filter must be identical, or the three numbers are not comparable.
  const filterOf = (q) => q.slice(q.indexOf("WHERE"), q.indexOf("SINCE"));
  assert.equal(filterOf(mtd), filterOf(d30));
});

test("a query naming a filter that does not exist fails loudly", () => {
  const base = testConfig();
  const config = testConfig({
    shopify: { ...base.shopify, queries: { acquisition: { schema: "sales", show: "orders", filter: "nope" } } },
  });
  assert.throws(() => buildQuery(config, "acquisition", "mtd"), /does not exist/);
});

/* --------------------------------- parsing --------------------------------- */

test("values arrive as strings and are parsed to numbers", () => {
  const { metrics } = parseTable(tableFor(LIVE.mtd));
  assert.equal(metrics.orders, 9902);
  assert.equal(typeof metrics.orders, "number");
  assert.equal(metrics.discounts, -407198.9);
});

/* -------------------------------- formulas -------------------------------- */

/** The scope shape a formula is evaluated against: one entry per query. */
const scopeOf = (row, extra = {}) => ({ acquisition: { metrics: row }, ...extra });

test("ncAOV is (gross + discounts + shipping) / orders, and discounts arrive negative", () => {
  const value = evaluateFormula("(gross_sales + discounts + shipping_charges) / orders", scopeOf(LIVE.mtd), { defaultQuery: "acquisition" });
  // Adding a negative discounts figure subtracts it. 69.97 against Shopify's own
  // average_order_value of 69.148 on the same window.
  assert.ok(Math.abs(value - 69.97) < 0.01, `expected ~69.97, got ${value}`);
});

test("a formula may only contain arithmetic and metrics the query returned", () => {
  assert.throws(() => evaluateFormula("orders + fetch('x')", scopeOf(LIVE.mtd), { defaultQuery: "acquisition" }), /not arithmetic|did not return/);
  assert.throws(() => evaluateFormula("gross_sales / nonexistent_metric", scopeOf(LIVE.mtd), { defaultQuery: "acquisition" }), /did not return/);
});

test("a formula with a missing input is unknown, not zero", () => {
  assert.equal(evaluateFormula("gross_sales / orders", scopeOf({ gross_sales: 100, orders: null }), { defaultQuery: "acquisition" }), null);
});

test("a formula that divides by zero yields null rather than Infinity", () => {
  assert.equal(evaluateFormula("gross_sales / orders", scopeOf({ gross_sales: 100, orders: 0 }), { defaultQuery: "acquisition" }), null);
});

/* ------------------------------- comparisons ------------------------------- */

test("a rate compares directly across windows of different lengths", () => {
  const f = "(gross_sales + discounts + shipping_charges) / orders";
  const mtd = evaluateFormula(f, scopeOf(LIVE.mtd), { defaultQuery: "acquisition" });
  const d30 = evaluateFormula(f, scopeOf(LIVE.d30), { defaultQuery: "acquisition" });
  const cmp = compareWindows(mtd, d30, { kind: "rate", primaryDays: 11, otherDays: 30 });
  assert.equal(cmp.basis, "direct");
  assert.ok(Math.abs(cmp.changePct - 2.4) < 0.2, `expected ~+2.4%, got ${cmp.changePct}`);
});

test("a total is compared per day, because a month-to-date total against 7 days measures the window", () => {
  const cmp = compareWindows(LIVE.mtd.orders, LIVE.d7.orders, { kind: "total", primaryDays: 11, otherDays: 7 });
  assert.equal(cmp.basis, "per day");
  // 9902/11 = 900/day against 7769/7 = 1110/day. Down, despite the raw total being larger.
  assert.ok(cmp.changePct < 0, "the raw MTD total is bigger, but the daily rate is lower");
  assert.ok(LIVE.mtd.orders > LIVE.d7.orders, "and the naive comparison would have said up");
});

test("a total with an unknown window length is not compared rather than compared wrongly", () => {
  const cmp = compareWindows(100, 50, { kind: "total", primaryDays: null, otherDays: 7 });
  assert.equal(cmp.changePct, null);
  assert.match(cmp.reason, /window length unknown/);
});

test("month-to-date length is the days elapsed, not a fixed number", () => {
  assert.equal(windowDays({ since: "startOfMonth(0m)" }, new Date("2026-09-11T02:00:00Z")), 11);
  assert.equal(windowDays({ since: "-7d", days: 7 }), 7);
});

/* -------------------------------- collector -------------------------------- */

test("the collector produces the MTD value with both comparisons", async () => {
  const snapshot = await collectShopify({
    config: testConfig(),
    token: "shpat_x",
    fetchImpl: liveFetch,
    sleep: async () => {},
    now: new Date("2026-09-11T02:00:00Z"),
  });

  assert.equal(snapshot.primaryWindow.label, "MTD");
  assert.equal(snapshot.primaryWindow.days, 11);

  const aov = snapshot.tiles.find((t) => t.metric === "net_aov");
  assert.ok(Math.abs(aov.value - 69.97) < 0.01);
  assert.deepEqual(aov.comparisons.map((c) => c.label), ["7D", "30D"]);
  assert.ok(Math.abs(aov.comparisons[0].changePct - -0.3) < 0.15, "MTD vs 7D is roughly flat");
  assert.ok(Math.abs(aov.comparisons[1].changePct - 2.4) < 0.2, "MTD vs 30D is up");
  assert.equal(aov.comparisons[0].basis, "direct", "a rate needs no per-day adjustment");

  const orders = snapshot.tiles.find((t) => t.metric === "orders");
  assert.equal(orders.comparisons[0].basis, "per day", "a total does");
});

test("a failing window loses its comparison, not the tile", async () => {
  const fetchImpl = async (url, opts) => {
    const q = JSON.parse(opts.body).variables.q;
    if (q.includes("-30d")) {
      return { status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: { shopifyqlQuery: { parseErrors: [{ message: "boom" }] } } }) };
    }
    return liveFetch(url, opts);
  };

  const snapshot = await collectShopify({
    config: testConfig(), token: "shpat_x", fetchImpl, sleep: async () => {},
    logger: { warn() {} }, now: new Date("2026-09-11T02:00:00Z"),
  });

  const aov = snapshot.tiles.find((t) => t.metric === "net_aov");
  assert.equal(aov.available, true, "the MTD value still stands");
  assert.equal(aov.comparisons.find((c) => c.label === "30D").changePct, null, "only the failed comparison is empty");
  assert.ok(Math.abs(aov.comparisons.find((c) => c.label === "7D").changePct - -0.3) < 0.15);
});

/* ------------------------------ error surfaces ------------------------------ */

test("a ShopifyQL parse error is raised, not returned as empty data", () => {
  const fetchImpl = async () => ({
    status: 200, headers: new Headers(),
    text: async () => JSON.stringify({ data: { shopifyqlQuery: { parseErrors: [{ message: "unknown field 'ordrs'" }] } } }),
  });
  return assert.rejects(
    () => runQuery({ config: testConfig(), token: "shpat_x", query: "FROM sales SHOW ordrs", fetchImpl, sleep: async () => {} }),
    /unknown field/,
  );
});

test("a GraphQL-level error is raised rather than silently yielding no metrics", () => {
  const fetchImpl = async () => ({
    status: 200, headers: new Headers(),
    text: async () => JSON.stringify({ errors: [{ message: "Access denied for shopifyqlQuery" }] }),
  });
  return assert.rejects(
    () => runQuery({ config: testConfig(), token: "shpat_x", query: "FROM sales SHOW orders", fetchImpl, sleep: async () => {} }),
    /Access denied/,
  );
});

test("a missing token fails loudly rather than reporting an empty store", async () => {
  await assert.rejects(() => collectShopify({ config: testConfig(), token: undefined }), /SHOPIFY_ADMIN_TOKEN is not set/);
});

/* ------------------------- Sub. Opt-In, and its denominator ------------------------- */

test("a formula can divide one query's numerator by another query's denominator", () => {
  // This is what lets Sub. Opt-In share a filter base with ncAOV rather than inventing
  // its own denominator.
  const scope = {
    acquisition: { metrics: { orders: 9902, gross_sales: 1091905.36, discounts: -407198.9, shipping_charges: 8118.1 } },
    subscription: { metrics: { orders: 7385 } },
  };
  const optin = evaluateFormula("subscription.orders / acquisition.orders", scope);
  assert.ok(Math.abs(optin - 0.7458) < 0.001, `expected ~74.6%, got ${(optin * 100).toFixed(1)}%`);
});

test("the opt-in denominator is distinct orders, not the sum of a GROUP BY", () => {
  // Live MTD: 7,385 subscription + 5,582 one-time = 12,967 grouped rows against 9,902
  // distinct orders, because an order can contain both a subscription and a one-time
  // line and is counted in both groups. Dividing by the group sum understates opt-in
  // by about 18 points, which is the difference between "most new customers subscribe"
  // and "most do not".
  const correct = 7385 / 9902;
  const doubleCounted = 7385 / (7385 + 5582);
  assert.ok(Math.abs(correct - 0.746) < 0.002);
  assert.ok(Math.abs(doubleCounted - 0.5696) < 0.002);
  assert.ok(correct - doubleCounted > 0.17, "the two definitions differ by more than 17 points");
});

test("a formula referencing a query that failed yields no value rather than a wrong one", () => {
  const scope = { acquisition: { metrics: { orders: 9902 } } };
  assert.throws(() => evaluateFormula("subscription.orders / acquisition.orders", scope), /query "subscription", which did not return/);
});

test("every tile carries the definition that explains it", async () => {
  const snapshot = await collectShopify({
    config: testConfig(), token: "shpat_x", fetchImpl: liveFetch, sleep: async () => {},
    now: new Date("2026-09-11T02:00:00Z"),
  });
  const aov = snapshot.tiles.find((t) => t.metric === "net_aov");
  assert.equal(aov.label, "ncAOV");
  assert.ok(aov.formula, "the formula is surfaced for the info hover");
  assert.ok(aov.filter, "so is the filter it was computed under");
});

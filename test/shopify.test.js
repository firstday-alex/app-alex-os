// Layer 0. Store-wide metrics from ShopifyQL.
//
// The query shape and the response shape were both validated against the live First Day
// store before this was written, so these tests assert real bytes rather than an assumed
// envelope — the mistake that left Layer 3 silently reporting nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTable, assertReadOnly, runQuery, collectShopify } from "../src/collectors/shopify.js";
import { testConfig } from "./fixtures/config.js";

/** The exact table the live store returned for a COMPARE TO query. */
const LIVE_TABLE = {
  columns: [
    { name: "sessions", dataType: "INTEGER" },
    { name: "sessions_that_completed_checkout", dataType: "INTEGER" },
    { name: "conversion_rate", dataType: "PERCENT" },
    { name: "comparison_sessions__previous_period", dataType: "INTEGER" },
    { name: "comparison_sessions_that_completed_checkout__previous_period", dataType: "INTEGER" },
    { name: "comparison_conversion_rate__previous_period", dataType: "PERCENT" },
  ],
  rows: [["95069", "2329", "0.02449799619223932", "113065", "2641", "0.023358245257152965"]],
};

const okResponse = (table) => ({
  status: 200,
  headers: new Headers(),
  text: async () => JSON.stringify({ data: { shopifyqlQuery: { __typename: "TableResponse", parseErrors: [], tableData: table } } }),
});

/* ------------------------------ read-only guard ------------------------------ */

test("anything that is not a FROM query is refused before it is sent", () => {
  // Queries live in config, and config is editable by the learning skill. The guard is
  // what makes that safe.
  assert.throws(() => assertReadOnly("mutation { productCreate }"), /must begin with FROM/);
  assert.throws(() => assertReadOnly("DELETE FROM sales"), /must begin with FROM/);
  assert.throws(() => assertReadOnly("FROM sales SHOW orders; DROP TABLE x"), /write keyword/);
  assert.equal(assertReadOnly("  FROM sales SHOW orders  "), "FROM sales SHOW orders");
});

/* -------------------------------- parsing -------------------------------- */

test("values arrive as strings and are parsed to numbers", () => {
  const { metrics } = parseTable(LIVE_TABLE);
  assert.equal(metrics.sessions.value, 95069);
  assert.equal(typeof metrics.sessions.value, "number");
  assert.ok(Math.abs(metrics.conversion_rate.value - 0.0244979) < 1e-6);
});

test("COMPARE TO columns become the previous value, not separate metrics", () => {
  const { metrics } = parseTable(LIVE_TABLE);
  assert.equal(metrics.sessions.previous, 113065);
  assert.equal("comparison_sessions__previous_period" in metrics, false, "comparison columns are not metrics of their own");
});

test("percent change is computed against the previous period", () => {
  const { metrics } = parseTable(LIVE_TABLE);
  assert.ok(Math.abs(metrics.sessions.changePct - -15.92) < 0.01, "sessions down ~15.9%");
  assert.ok(metrics.conversion_rate.changePct > 0, "conversion up");
});

test("a zero prior period yields null, not Infinity", () => {
  const { metrics } = parseTable({
    columns: [{ name: "orders", dataType: "INTEGER" }, { name: "comparison_orders__previous_period", dataType: "INTEGER" }],
    rows: [["10", "0"]],
  });
  assert.equal(metrics.orders.changePct, null, "up from nothing is not a percentage");
});

test("a metric with no comparison column has a null previous, not a zero one", () => {
  const { metrics } = parseTable({ columns: [{ name: "orders", dataType: "INTEGER" }], rows: [["10"]] });
  assert.equal(metrics.orders.previous, null);
  assert.equal(metrics.orders.changePct, null);
});

/* ------------------------------ error surfaces ------------------------------ */

test("a ShopifyQL parse error is raised, not returned as empty data", () => {
  const config = testConfig();
  const fetchImpl = async () => ({
    status: 200, headers: new Headers(),
    text: async () => JSON.stringify({ data: { shopifyqlQuery: { parseErrors: [{ message: "unknown field 'ordrs'" }] } } }),
  });
  return assert.rejects(
    () => runQuery({ config, token: "shpat_x", query: "FROM sales SHOW ordrs", fetchImpl, sleep: async () => {} }),
    /unknown field/,
  );
});

test("a GraphQL-level error is raised rather than silently yielding no metrics", () => {
  const config = testConfig();
  const fetchImpl = async () => ({
    status: 200, headers: new Headers(),
    text: async () => JSON.stringify({ errors: [{ message: "Access denied for shopifyqlQuery" }] }),
  });
  return assert.rejects(
    () => runQuery({ config, token: "shpat_x", query: "FROM sales SHOW orders", fetchImpl, sleep: async () => {} }),
    /Access denied/,
  );
});

/* -------------------------------- collector -------------------------------- */

test("one failing query loses its tiles, not the whole layer", async () => {
  const config = testConfig({
    shopify: {
      ...testConfig().shopify,
      queries: { sales: "FROM sales SHOW orders", broken: "FROM nope SHOW nothing" },
      tiles: [
        { metric: "orders", from: "sales", label: "Orders", format: "integer", goodDirection: "up" },
        { metric: "whatever", from: "broken", label: "Broken", format: "integer", goodDirection: "up" },
      ],
    },
  });

  const fetchImpl = async (url, opts) => {
    const sent = JSON.parse(opts.body).variables.q;
    if (sent.includes("nope")) {
      return { status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: { shopifyqlQuery: { parseErrors: [{ message: "no such schema" }] } } }) };
    }
    return okResponse({ columns: [{ name: "orders", dataType: "INTEGER" }], rows: [["42"]] });
  };

  const snapshot = await collectShopify({ config, token: "shpat_x", fetchImpl, sleep: async () => {}, logger: { warn() {} } });
  const byLabel = Object.fromEntries(snapshot.tiles.map((t) => [t.label, t]));

  assert.equal(byLabel.Orders.value, 42);
  assert.equal(byLabel.Orders.available, true);
  assert.equal(byLabel.Broken.available, false, "the failed tile is missing, not zero");
  assert.match(byLabel.Broken.reason, /no such schema/);
  assert.equal(snapshot.failures.length, 1);
});

test("a missing token fails loudly rather than reporting an empty store", async () => {
  await assert.rejects(() => collectShopify({ config: testConfig(), token: undefined }), /SHOPIFY_ADMIN_TOKEN is not set/);
});

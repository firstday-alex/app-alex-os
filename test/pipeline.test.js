// Idempotence, partial failure and redaction. These three run the whole pipeline, because
// each is a property of the pipeline rather than of any one function.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runPipeline } from "../src/pipeline.js";
import { Store } from "../src/lib/storage.js";
import { createLogger } from "../src/lib/logger.js";
import { testConfig } from "./fixtures/config.js";

const TOKEN = "pk_99999_THISISTHESECRETTOKENVALUE";
const IG_TOKEN = "ig_secret_key_value_9876543210";

/**
 * A fetch stand-in covering all three upstreams. `fail` names services that should throw.
 */
function fakeUpstreams({ fail = [], slackCalls = [] } = {}) {
  return async (url, options) => {
    const target = String(url);
    const reply = (body, status = 200) => ({
      status,
      headers: new Headers(),
      text: async () => JSON.stringify(body),
    });

    if (target.includes("api.clickup.com")) {
      if (fail.includes("clickup")) return reply({ err: "Team not authorized" }, 401);
      if (target.includes("/field")) {
        return reply({
          fields: [
            { id: "f_owner", name: "Task Owner", type: "users" },
            {
              id: "f_priority",
              name: "Leadership Priority",
              type: "drop_down",
              type_config: { options: [{ id: "opt_sub", name: "Subscription upsell" }] },
            },
          ],
        });
      }
      if (target.includes("/comment")) return reply({ comments: [] });
      if (target.includes("/team")) return reply({ teams: [{ members: [{ user: { id: 1, username: "dana" } }] }] });
      return reply({
        last_page: true,
        tasks: [
          {
            id: "t1",
            name: "Ship the upsell module",
            url: "https://app.clickup.com/t/t1",
            status: { status: "in progress", type: "custom" },
            assignees: [{ id: 1, username: "dana" }],
            date_updated: String(Date.parse("2026-09-09T12:00:00Z")),
            custom_fields: [
              { id: "f_owner", value: [{ id: 1, username: "dana" }] },
              { id: "f_priority", value: "opt_sub" },
            ],
          },
        ],
      });
    }

    if (target.includes("intelligems")) {
      if (fail.includes("intelligems")) return reply({ err: "upstream exploded" }, 500);
      // The real endpoints and the real response shape. See test/fixtures/intelligems-real.js.
      if (target.includes("/experiences-list")) {
        return reply({ page: 1, limit: 50, total: 1, totalPages: 1, experiences: [{ id: "e1", name: "Upsell test", status: "started", startedAtTs: "2026-09-01T00:00:00Z" }] });
      }
      if (target.includes("/analytics/resource/")) {
        return reply({
          cogsConfigured: false,
          testResult: { verdict: "not_ready", runtime_days: 9, orders_per_variant: { g1: 120, g2: 118 } },
          metrics: [
            { variation_id: "g1", conversion_rate: { value: 0.03, ci_low: 0.029, ci_high: 0.031 }, n_orders: { value: 120 } },
            { variation_id: "g2", conversion_rate: { value: 0.032, ci_low: 0.031, ci_high: 0.033, uplift: { value: 0.066, ci_low: -0.02, ci_high: 0.15 }, p2bc: 0.81 }, n_orders: { value: 118 } },
          ],
          variations: [
            { id: "g1", name: "Control", isControl: true },
            { id: "g2", name: "Variant", isControl: false },
          ],
        });
      }
      if (target.includes("/timeseries")) return reply({ points: [] });
      if (target.includes("/experiences/")) {
        return reply({ id: "e1", name: "Upsell test", experienceKeyMetrics: [{ order: 0, isPrimary: true, standardEventId: "conversionRate" }] });
      }
      return reply({});
    }

    if (target.includes("myshopify.com")) {
      if (fail.includes("shopify")) return reply({ errors: [{ message: "access denied" }] });
      // The real Admin GraphQL shape: tableData.columns + rows, values as strings. One
      // query per window, so the window is read back out of the sent query.
      const sent = JSON.parse(options.body).variables.q;
      const scale = sent.includes("startOfMonth") ? 1 : sent.includes("-7d") ? 0.8 : 3.5;
      return reply({
        data: {
          shopifyqlQuery: {
            __typename: "TableResponse",
            parseErrors: [],
            tableData: {
              columns: [
                { name: "gross_sales", dataType: "MONEY" },
                { name: "discounts", dataType: "MONEY" },
                { name: "shipping_charges", dataType: "MONEY" },
                { name: "orders", dataType: "INTEGER" },
              ],
              rows: [[String(1000000 * scale), String(-400000 * scale), String(8000 * scale), String(Math.round(9900 * scale))]],
            },
          },
        },
      });
    }

    if (target.includes("slack.com")) {
      slackCalls.push(JSON.parse(options.body));
      return reply({ ok: true, ts: `17${slackCalls.length}.0001`, channel: "C1" });
    }

    return reply({}, 404);
  };
}

const baseEnv = {
  SHOPIFY_ADMIN_TOKEN: "shpat_TESTTOKENVALUE0000",
  CLICKUP_TOKEN: TOKEN,
  INTELLIGEMS_TOKEN: IG_TOKEN,
  SLACK_BOT_TOKEN: "xoxb-slack-secret-token-value",
  SLACK_READOUT_CHANNEL: "C1",
};

async function setup({ fail = [] } = {}) {
  const config = testConfig({
    leadershipQueue: {
      queue: [{ id: "p_sub", title: "Subscription upsell", type: "test", state: "active", owner: "u1", clickupOptionId: "opt_sub" }],
      backlog: [],
    },
  });
  const slackCalls = [];
  const lines = [];
  const logger = createLogger({ level: "debug", sink: (line) => lines.push(line), secrets: [TOKEN, IG_TOKEN, baseEnv.SLACK_BOT_TOKEN] });
  const store = await Store.open({ config, logger, mode: "memory" });
  // No real waiting: the retry policy is verified in http.test.js, not here.
  const sleep = async () => {};
  return { config, store, logger, lines, slackCalls, sleep, fetchImpl: fakeUpstreams({ fail, slackCalls }) };
}

test("running twice for the same date sends one Slack message", async () => {
  const ctx = await setup();
  const now = new Date("2026-09-10T13:00:00Z");

  const first = await runPipeline({ ...ctx, mode: "official", now, env: baseEnv });
  assert.equal(first.delivery.sent, true);
  assert.equal(ctx.slackCalls.length, 1);

  // Exactly what a Netlify background-function retry looks like.
  const second = await runPipeline({ ...ctx, mode: "official", now, env: baseEnv });
  assert.equal(second.delivery.sent, false);
  assert.match(second.delivery.reason, /already sent/);
  assert.equal(ctx.slackCalls.length, 1, "the retry must not double post");
});

test("running twice for the same date produces the same flags", async () => {
  const ctx = await setup();
  const now = new Date("2026-09-10T13:00:00Z");
  const first = await runPipeline({ ...ctx, mode: "official", now, env: baseEnv });
  const second = await runPipeline({ ...ctx, mode: "official", now, env: baseEnv });
  assert.deepEqual(
    second.report.flags.map((f) => f.id),
    first.report.flags.map((f) => f.id),
  );
});

test("a refresh run never posts to Slack", async () => {
  const ctx = await setup();
  const result = await runPipeline({ ...ctx, mode: "refresh", now: new Date("2026-09-10T19:00:00Z"), env: baseEnv });
  assert.equal(result.delivery.sent, false);
  assert.equal(ctx.slackCalls.length, 0);
  assert.match(result.delivery.reason, /8 AM send is the official readout/);
});

test("partial failure: the Intelligems collector throws and the ClickUp section still renders", async () => {
  const ctx = await setup({ fail: ["intelligems"] });
  const result = await runPipeline({ ...ctx, mode: "official", now: new Date("2026-09-10T13:00:00Z"), env: baseEnv });

  assert.equal(result.outcome, "partial");
  assert.equal(result.report.sections.clickup.present, true, "ClickUp still reported");
  assert.equal(result.report.sections.intelligems.present, false);

  // The missing section is explicit, in the report and in the text that goes to Slack.
  const missing = result.report.missing.find((m) => m.section === "intelligems");
  assert.ok(missing, "the report names the missing section");
  assert.ok(missing.reason.length > 0, "and why");
  assert.match(result.report.text, /PARTIAL/);
  assert.match(result.report.text, /LAYER 3[\s\S]*MISSING/);
  assert.match(result.report.text, /LAYER 2. CLICKUP SPRINT/);

  assert.equal(result.delivery.sent, true, "a partial readout still goes out. A partial readout beats no readout.");
});

test("partial failure leaves the good baseline untouched", async () => {
  const ctx = await setup();
  // A good Monday.
  await runPipeline({ ...ctx, mode: "official", now: new Date("2026-09-07T13:00:00Z"), env: baseEnv });
  const goodIndex = await ctx.store.readIndex("intelligems");
  assert.ok(goodIndex.officialByDate["2026-09-07"]);

  // Tuesday, Intelligems is down.
  const broken = { ...ctx, fetchImpl: fakeUpstreams({ fail: ["intelligems"], slackCalls: ctx.slackCalls }) };
  await runPipeline({ ...broken, mode: "official", now: new Date("2026-09-08T13:00:00Z"), env: baseEnv });

  const afterIndex = await ctx.store.readIndex("intelligems");
  assert.equal(afterIndex.officialByDate["2026-09-08"], undefined, "no snapshot written for the failed day");
  assert.equal(afterIndex.officialByDate["2026-09-07"], goodIndex.officialByDate["2026-09-07"], "Monday's snapshot survives");
});

test("every collector failing is reported as failed, not as an empty success", async () => {
  const ctx = await setup({ fail: ["clickup", "intelligems", "shopify"] });
  const result = await runPipeline({ ...ctx, mode: "official", now: new Date("2026-09-10T13:00:00Z"), env: baseEnv });
  assert.equal(result.report.sections.clickup.present, false);
  assert.equal(result.report.sections.intelligems.present, false);
  assert.equal(result.report.sections.crossLayer.present, false, "the cross layer check needs both layers");
  assert.match(result.report.text, /PARTIAL/);
});

test("redaction: log output never contains a token string", async () => {
  const ctx = await setup();
  await runPipeline({ ...ctx, mode: "official", now: new Date("2026-09-10T13:00:00Z"), env: baseEnv });

  const everything = ctx.lines.join("\n");
  assert.ok(ctx.lines.length > 5, "the run actually logged something");
  assert.equal(everything.includes(TOKEN), false, "the ClickUp token must never reach a log line");
  assert.equal(everything.includes(IG_TOKEN), false, "nor the Intelligems key");
  assert.equal(everything.includes(baseEnv.SLACK_BOT_TOKEN), false, "nor the Slack token");
});

test("redaction survives a failing request, where the token is most likely to leak", async () => {
  const ctx = await setup({ fail: ["clickup"] });
  await runPipeline({ ...ctx, mode: "official", now: new Date("2026-09-10T13:00:00Z"), env: baseEnv });
  assert.equal(ctx.lines.join("\n").includes(TOKEN), false);
});

test("every flag is logged with the rule that raised it and the values that tripped it", async () => {
  const ctx = await setup();
  const result = await runPipeline({ ...ctx, mode: "official", now: new Date("2026-09-10T13:00:00Z"), env: baseEnv });

  const logged = ctx.lines
    .map((line) => JSON.parse(line))
    .filter((record) => record.event === "flag.raised");

  assert.equal(logged.length, result.report.flags.length, "no flag reaches the readout unlogged");
  for (const record of logged) {
    assert.ok(record.rule, "the rule that raised it");
    assert.ok(record.values !== undefined, "and the values that tripped it");
  }
});

test("the first run says so instead of crashing on a missing baseline", async () => {
  const ctx = await setup();
  const result = await runPipeline({ ...ctx, mode: "official", now: new Date("2026-09-10T13:00:00Z"), env: baseEnv });
  assert.match(result.report.baseline.describe, /first run/i);
  assert.match(result.report.text, /FIRST RUN/);
  assert.equal(result.outcome, "success");
});

test("the Slack post identifies itself as Claude, every time", async () => {
  const ctx = await setup();
  await runPipeline({ ...ctx, mode: "official", now: new Date("2026-09-10T13:00:00Z"), env: baseEnv });
  const posted = ctx.slackCalls[0];
  assert.match(posted.text, /Claude/);
  assert.match(JSON.stringify(posted.blocks[0]), /Claude/, "and in the rendered blocks, not just the fallback text");
});

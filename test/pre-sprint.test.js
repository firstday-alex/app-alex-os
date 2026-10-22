// Before sprint planning: the backlog's Ready tickets checked against the rocks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { preSprintCheck } from "../src/delta/pre-sprint.js";
import { task } from "./fixtures/tasks.js";
import { testConfig } from "./fixtures/config.js";

const config = testConfig({
  people: {
    team: [
      { clickupUserId: "u1", name: "dana", countsTowardCapacity: true },
      { clickupUserId: "u2", name: "rey", countsTowardCapacity: true },
      { clickupUserId: "u9", name: "alex", countsTowardCapacity: false },
    ],
    alex: { slackUserId: "UALEX" },
  },
});
const own = (id, name) => ({ taskOwners: [{ id, username: name }], assignees: [] });
const QUIZ = { optionId: "sw_quiz", label: "Quiz" };
const APP = { optionId: "sw_app", label: "Mobile App" };
const leadership = {
  queue: [
    { id: "r_quiz", title: "Quiz", state: "active", owner: { name: "dana" }, clickupBigSwingOptionId: "sw_quiz" },
    { id: "r_app", title: "Mobile App", state: "active", owner: { name: "rey" }, clickupBigSwingOptionId: "sw_app" },
    { id: "r_old", title: "Shipped thing", state: "shipped", clickupBigSwingOptionId: "sw_old" },
  ],
};

test("without the pool collected, the check says so instead of reporting an empty sprint", () => {
  const out = preSprintCheck({ backlogReady: null, leadership, config, error: "HTTP 500" });
  assert.equal(out.available, false);
  assert.equal(out.reason, "HTTP 500");
});

test("the pool is checked per person, per rock and per ticket", () => {
  const out = preSprintCheck({
    backlogReady: [
      { ...task({ id: "b1", name: "Quiz results page", bigSwing: QUIZ }), ...own("u1", "dana") },
      { ...task({ id: "b2", name: "Footer copy", bigSwing: null }), ...own("u2", "rey") },
      { ...task({ id: "b3", name: "Fix 404s", bigSwing: { optionId: "sw_bau", label: "BAU" } }), ...own("u2", "rey") },
      { ...task({ id: "b4", name: "Old project tweak", bigSwing: { optionId: "sw_x", label: "AB Testing" } }), taskOwners: [], assignees: [] },
    ],
    sprintTasks: [],
    leadership,
    config,
  });
  assert.equal(out.available, true);
  assert.equal(out.readyCount, 4);
  const byName = Object.fromEntries(out.people.map((p) => [p.name, p]));
  assert.deepEqual(byName.dana.rocks, ["Quiz"]);
  assert.equal(byName.rey.noBigSwing, true, "rey's pool is BAU and an unlinked ticket");
  assert.equal(out.people[0].name, "rey", "people with no big swing come first");
  assert.equal(byName.alex, undefined, "someone who does not count toward capacity is not checked");
  assert.deepEqual(out.unqueuedRocks.map((r) => r.title), ["Mobile App"], "the shipped rock is not expected to have work queued");
  assert.deepEqual(out.noSwing.map((t) => t.name), ["Footer copy"], "BAU needs no Big Swing");
  assert.deepEqual(out.unclaimedSwing.map((t) => t.name), ["Old project tweak"]);
  assert.deepEqual(out.unowned.map((t) => t.name), ["Old project tweak"]);
});

test("work still open in the current sprint counts as queued", () => {
  const out = preSprintCheck({
    backlogReady: [],
    sprintTasks: [{ ...task({ id: "s1", bigSwing: APP, bucket: "inProgress" }), ...own("u2", "rey") }],
    leadership,
    config,
  });
  const rey = out.people.find((p) => p.name === "rey");
  assert.deepEqual(rey.carryover, ["Mobile App"]);
  assert.equal(rey.noBigSwing, false);
  assert.deepEqual(out.unqueuedRocks.map((r) => r.title), ["Quiz"]);
});

test("the backlog is asked only for open tickets marked Ready, filtered by ClickUp", async () => {
  const { fetchBacklogReady } = await import("../src/collectors/clickup.js");
  const { loadConfig } = await import("../src/config.js");
  const live = loadConfig();
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    // One Ready by option id, one Ready by orderindex, one not Ready: the filter is
    // checked locally too, in case ClickUp ever ignores it.
    const ready = "72c5ec33-ab55-466c-980c-53b10c6f916a";
    const tasks = [
      { id: "t1", custom_fields: [{ id: ready, value: "2751e6bb-4516-49da-a4d0-3b0ef8808f1d" }] },
      { id: "t2", custom_fields: [{ id: ready, value: 1 }] },
      { id: "t3", custom_fields: [{ id: ready, value: 0 }] },
    ];
    return new Response(JSON.stringify({ tasks, last_page: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await fetchBacklogReady({ config: live, token: "pk_x", fetchImpl, sleep: async () => {} });
  assert.deepEqual(result.items.map((t) => t.id), ["t1", "t2"]);
  const url = new URL(urls[0]);
  assert.match(url.pathname, /\/list\/901111926996\/task$/, "the Site Backlog list");
  assert.equal(url.searchParams.get("include_closed"), "false");
  assert.deepEqual(JSON.parse(url.searchParams.get("custom_fields")), [
    { field_id: "72c5ec33-ab55-466c-980c-53b10c6f916a", operator: "=", value: "2751e6bb-4516-49da-a4d0-3b0ef8808f1d" },
  ]);
});

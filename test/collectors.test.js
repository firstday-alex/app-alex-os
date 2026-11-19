// Collector normalization. The error states the spec asks to design for on purpose:
// a renamed dropdown option, a missing custom field, an unmapped status, null profit
// metrics, and comments fetched only for tasks that moved.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFieldMap, normalizeTask, statusBucket, fetchCommentsForChanged } from "../src/collectors/clickup.js";
import { normalizeMetric, normalizeExperiment, metricNamesFor, assessStability } from "../src/collectors/intelligems.js";
import { testConfig } from "./fixtures/config.js";
import { CLICKUP_LIST } from "./fixtures/intelligems-real.js";
import { task } from "./fixtures/tasks.js";

const config = testConfig();

const RAW_FIELDS = [
  { id: "f_owner", name: "Task Owner", type: "users" },
  {
    id: "f_priority",
    name: "Leadership Priority",
    type: "drop_down",
    type_config: { options: [{ id: "opt_sub", name: "Subscription upsell" }, { id: "opt_bau", name: "Business as usual" }] },
  },
  { id: "f_other", name: "Sprint Points", type: "number" },
];

test("custom fields resolve by name when no id is configured; the retired Project Owner field is not read", () => {
  const noIds = { ...config.clickup, customFields: { leadershipPriority: { id: null, matchName: ["Leadership Priority"] } } };
  const map = buildFieldMap(RAW_FIELDS, noIds);
  assert.equal(map.taskOwner, undefined);
  assert.equal(map.leadershipPriority.id, "f_priority");
  assert.equal(map.options.f_priority.opt_sub.label, "Subscription upsell");
});

test("the alternate field name is accepted (ROCK was Big Swing)", () => {
  const fields = [{ id: "f_rock", name: "ROCK", type: "drop_down" }];
  const map = buildFieldMap(fields, { customFields: { bigSwing: { id: null, matchName: ["ROCK", "Big Swing"] } } });
  assert.equal(map.bigSwing.id, "f_rock");
});

test("a dropdown value returns an option id, and the label is looked up not trusted", () => {
  const map = buildFieldMap(RAW_FIELDS, config.clickup);
  const normalized = normalizeTask(
    { id: "t1", status: { status: "in progress" }, custom_fields: [{ id: "f_priority", value: "opt_sub" }] },
    { fieldMap: map, statusMap: config.clickup.statusMap },
  );
  assert.equal(normalized.leadershipPriority.optionId, "opt_sub");
  assert.equal(normalized.leadershipPriority.label, "Subscription upsell");
});

test("a custom field missing on a task is null, not an error", () => {
  const map = buildFieldMap(RAW_FIELDS, config.clickup);
  const normalized = normalizeTask({ id: "t1", status: { status: "to do" }, custom_fields: [] }, { fieldMap: map, statusMap: config.clickup.statusMap });
  assert.equal(normalized.leadershipPriority, null);
  assert.equal(normalized.taskOwners, undefined);
  assert.equal(normalized.bucket, "notStarted");
});

test("status matching is case-insensitive, and an unmapped status is logged not crashed on", () => {
  const warnings = [];
  const logger = { warn: (event, fields) => warnings.push({ event, fields }) };
  assert.equal(statusBucket("IN PROGRESS", config.clickup.statusMap), "inProgress");
  assert.equal(statusBucket("Complete", config.clickup.statusMap), "done");
  assert.equal(statusBucket("waiting on vendor", config.clickup.statusMap, logger), "notStarted");
  assert.equal(warnings[0].event, "clickup.status_unmapped");
});

test("comments are fetched only for tasks whose date_updated moved", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    return { status: 200, headers: new Headers(), text: async () => JSON.stringify({ comments: [{ id: 1, comment_text: "hi", user: { username: "dana" }, date: "1" }] }) };
  };

  const result = await fetchCommentsForChanged({
    config,
    token: "pk_x",
    tasks: [task({ id: "moved", dateUpdated: 2000 }), task({ id: "still", dateUpdated: 1000 })],
    baselineTasks: [task({ id: "moved", dateUpdated: 1000, lastComment: null }), task({ id: "still", dateUpdated: 1000, lastComment: null })],
    fetchImpl,
    sleep: async () => {},
  });

  assert.equal(requested.length, 1, "only the task that moved costs a request");
  assert.ok(requested[0].includes("/task/moved/comment"));
  assert.equal(result.comments.moved.count, 1);
  assert.equal(result.comments.moved.latest.user, "dana");
  assert.deepEqual(result.comments.moved.latest.mentions, []);
});

test("an open ticket whose latest comment was never read is read once, even if it has not moved", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    return { status: 200, headers: new Headers(), text: async () => JSON.stringify({ comments: [] }) };
  };
  await fetchCommentsForChanged({
    config,
    token: "pk_x",
    tasks: [task({ id: "unread", dateUpdated: 1000 }), task({ id: "read", dateUpdated: 1000 })],
    baselineTasks: [task({ id: "unread", dateUpdated: 1000 }), task({ id: "read", dateUpdated: 1000, lastComment: null })],
    fetchImpl,
    sleep: async () => {},
  });
  assert.deepEqual(requested.map((u) => u.match(/task\/([^/]+)\/comment/)[1]), ["unread"]);
});

test("one task's comment fetch failing does not sink the collector", async () => {
  const fetchImpl = async () => ({ status: 500, headers: new Headers(), text: async () => "boom" });
  const result = await fetchCommentsForChanged({
    config,
    token: "pk_x",
    tasks: [task({ id: "a", dateUpdated: 2 })],
    baselineTasks: [task({ id: "a", dateUpdated: 1 })],
    fetchImpl,
    sleep: async () => {},
    logger: { warn: () => {} },
  });
  assert.equal(result.comments.a.error, true);
  assert.equal(result.comments.a.count, null, "unknown, not zero");
});

/* ------------------------------- intelligems -------------------------------
   Intelligems normalization is tested against a REAL captured payload in
   test/intelligems-real.test.js. The tests that used to live here asserted the shape
   this collector was first assumed to have, and they passed while the collector could
   not read a single confidence interval from the live API. A test written from the same
   guess as the code cannot catch the guess being wrong, so they were deleted rather
   than corrected. */

test("the real Current Sprint statuses all bucket correctly", () => {
  // Read live from list 901112668495 on 2026-09-10. The first config had "in progress"
  // with a space, and knew nothing about vqa, qa or ready for deploy, so four of the six
  // statuses fell through to Not Started with only a log line to show for it.
  const warnings = [];
  const logger = { warn: (event) => warnings.push(event) };

  assert.equal(statusBucket("to do", config.clickup.statusMap, logger), "notStarted");
  assert.equal(statusBucket("in-progress", config.clickup.statusMap, logger), "inProgress");
  assert.equal(statusBucket("vqa", config.clickup.statusMap, logger), "inProgress");
  assert.equal(statusBucket("qa", config.clickup.statusMap, logger), "inProgress");
  assert.equal(statusBucket("ready for deploy", config.clickup.statusMap, logger), "inProgress");
  assert.equal(statusBucket("complete", config.clickup.statusMap, logger), "done");

  assert.deepEqual(warnings, [], "no live status should be falling through to the default");
});

test("Last Sprint list: its finished tickets are merged into the sprint read, open ones and duplicates left out", async () => {
  const { collectClickUp } = await import("../src/collectors/clickup.js");
  const { loadConfig } = await import("../src/config.js");
  const config = loadConfig();
  const task = (id, status, type) => ({ id, name: `T${id}`, status: { status, type }, assignees: [], custom_fields: [], date_updated: "1", url: `u${id}` });
  const fetchImpl = async (url) => {
    const u = String(url);
    const body = u.includes(`/list/${config.clickup.lastSprintListId}/task`)
      ? { tasks: [task("b", "complete", "closed"), task("c", "to do", "open"), task("a", "complete", "closed")], last_page: true }
      : u.includes(`/list/${config.clickup.sprintListId}/task`)
        ? { tasks: [task("a", "in-progress", "custom")], last_page: true }
        : u.includes("/field") ? { fields: [] } : { tasks: [], comments: [], last_page: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const store = { backend: { get: async () => null, set: async () => {} }, getCached: async () => null, setCached: async () => {}, getFieldMap: async () => null, setFieldMap: async () => {} };
  const snap = await collectClickUp({ config: { ...config, clickup: { ...config.clickup, backlogListId: null } }, token: "pk", store, fetchImpl, sleep: async () => {} });
  const by = Object.fromEntries(snap.items.map((t) => [t.id, t]));
  assert.deepEqual(Object.keys(by).sort(), ["a", "b"]);
  assert.equal(by.a.status, "in-progress", "a ticket on both lists keeps its Current Sprint copy");
  assert.equal(by.b.bucket, "done");
});

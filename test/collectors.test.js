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

test("custom fields resolve by name when no id is configured", () => {
  const noIds = { ...config.clickup, customFields: { taskOwner: { id: null, matchName: ["Task Owner", "Task Project Manager"] }, leadershipPriority: { id: null, matchName: ["Leadership Priority"] } } };
  const map = buildFieldMap(RAW_FIELDS, noIds);
  assert.equal(map.taskOwner.id, "f_owner");
  assert.equal(map.leadershipPriority.id, "f_priority");
  assert.equal(map.options.f_priority.opt_sub.label, "Subscription upsell");
});

test("the alternate field name is accepted, since the spec allows either", () => {
  const fields = [{ id: "f_pm", name: "Task Project Manager", type: "users" }];
  const map = buildFieldMap(fields, { customFields: { taskOwner: { id: null, matchName: ["Task Owner", "Task Project Manager"] } } });
  assert.equal(map.taskOwner.id, "f_pm");
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
  assert.deepEqual(normalized.taskOwners, []);
  assert.equal(normalized.bucket, "notStarted");
});

test("a user-type field returns an array of users", () => {
  const map = buildFieldMap(RAW_FIELDS, config.clickup);
  const normalized = normalizeTask(
    { id: "t1", status: { status: "to do" }, custom_fields: [{ id: "f_owner", value: [{ id: 7, username: "rey" }] }] },
    { fieldMap: map, statusMap: config.clickup.statusMap },
  );
  assert.deepEqual(normalized.taskOwners, [{ id: "7", username: "rey" }]);
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
    baselineTasks: [task({ id: "moved", dateUpdated: 1000 }), task({ id: "still", dateUpdated: 1000 })],
    fetchImpl,
    sleep: async () => {},
  });

  assert.equal(requested.length, 1, "only the task that moved costs a request");
  assert.ok(requested[0].includes("/task/moved/comment"));
  assert.equal(result.comments.moved.count, 1);
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

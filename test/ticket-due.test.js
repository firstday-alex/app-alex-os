// Set due date from a flag card: only the due date, only on an open ticket in the latest
// readout, only a sensible date, and every write recorded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setDueDate, dueMs } from "../src/send/clickup-due.js";

const config = { clickup: { apiBase: "https://api.clickup.com/api/v2" }, system: { http: { maxAttempts: 1 } } };
const report = { detail: { clickup: { tasks: [{ id: "t1", name: "GWP engine", bucket: "inProgress" }, { id: "t2", name: "Shipped", bucket: "done" }] } } };
const now = new Date("2026-11-18T15:00:00Z");

test("sets only the due date, as a date, and records it; refuses done, unknown and past", async () => {
  const calls = [];
  const written = [];
  const store = { getLatestReport: async () => report, backend: { set: async (k) => written.push(k) } };
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const out = await setDueDate({ config, store, token: "pk", taskId: "t1", date: "2026-11-21", fetchImpl, now });
  assert.deepEqual(calls, [{ url: "https://api.clickup.com/api/v2/task/t1", method: "PUT", body: { due_date: dueMs("2026-11-21"), due_date_time: false } }]);
  assert.equal(new Date(out.dueDate).toISOString().slice(0, 10), "2026-11-21");
  assert.equal(written.length, 1);
  await assert.rejects(setDueDate({ config, store, token: "pk", taskId: "t2", date: "2026-11-21", fetchImpl, now }), /already done/);
  await assert.rejects(setDueDate({ config, store, token: "pk", taskId: "zz", date: "2026-11-21", fetchImpl, now }), /latest readout/);
  await assert.rejects(setDueDate({ config, store, token: "pk", taskId: "t1", date: "2026-11-01", fetchImpl, now }), /passed/);
});

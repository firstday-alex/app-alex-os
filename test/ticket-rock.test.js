// Set ROCK from a flag card: only the ROCK field, only to a live rock, only on tickets the
// latest readout holds, and every write recorded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setRock, rockChoices } from "../src/send/clickup-rock.js";
import { createBackend } from "../src/lib/storage.js";

const config = { clickup: { apiBase: "https://api.clickup.com/api/v2", customFields: { bigSwing: { id: "f-rock" } } }, system: { http: { maxAttempts: 1 } } };
const report = {
  detail: {
    leadership: { queue: [
      { id: "r1", title: "Bundles 2.0", state: "active", clickupBigSwingOptionIds: ["opt-1"] },
      { id: "r2", title: "Old rock", state: "shipped", clickupBigSwingOptionIds: ["opt-2"] },
      { id: "r3", title: "No option", state: "active" },
    ] },
    clickup: { tasks: [{ id: "t1" }, { id: "t2" }] },
  },
};

test("Set ROCK posts the rock's ClickUp option to the ROCK field, records it, and refuses anything else", async () => {
  const mem = await createBackend({ mode: "memory" });
  const written = [];
  const backend = { get: (k) => mem.get(k), set: (k, v) => (written.push(k), mem.set(k, v)) };
  const store = { backend, getLatestReport: async () => report };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  assert.deepEqual(rockChoices(report).map((r) => r.id), ["r1"], "only active rocks with a ClickUp option");
  const out = await setRock({ config, store, token: "pk", taskIds: ["t1", "zz"], rockId: "r1", fetchImpl });
  assert.deepEqual(out.set, ["t1"]);
  assert.equal(out.failed[0].taskId, "zz");
  assert.deepEqual(calls, [{ url: "https://api.clickup.com/api/v2/task/t1/field/f-rock", method: "POST", body: { value: "opt-1" } }]);
  assert.equal(written.length, 1);
  assert.match(written[0], /^clickup\/writes\/.*-rock\.json$/);
  await assert.rejects(setRock({ config, store, token: "pk", taskIds: ["t1"], rockId: "r2", fetchImpl }), /live rocks/);
  await assert.rejects(setRock({ config, store, token: "pk", taskIds: ["zz"], rockId: "r1", fetchImpl }), /latest readout/);
});

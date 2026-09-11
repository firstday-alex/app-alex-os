// The rocks store. Layer 1's data moved out of config and into a real store, so the
// things worth testing are the ones a config file gave us for free: validation,
// not losing a concurrent write, and an audit trail that says what changed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RocksStore, RockValidationError, normalizeRock } from "../src/store/rocks.js";
import { Store } from "../src/lib/storage.js";
import { collectLeadership } from "../src/collectors/leadership.js";
import { testConfig } from "./fixtures/config.js";

async function freshStore() {
  const backing = await Store.open({ config: testConfig(), mode: "memory" });
  return new RocksStore(backing.backend, null);
}

test("a rock needs a title", () => {
  assert.throws(() => normalizeRock({ title: "   " }), RockValidationError);
});

test("state is constrained to the three Layer 1 states", () => {
  assert.throws(() => normalizeRock({ title: "A", state: "in progress" }), /state must be one of/);
  for (const state of ["active", "shipped", "backlog"]) {
    assert.equal(normalizeRock({ title: "A", state, shippedAt: "2026-01-01" }).state, state);
  }
});

test("a shipped rock must carry a shipped date, because the mini readout window is measured from it", () => {
  assert.throws(() => normalizeRock({ title: "A", state: "shipped" }), /needs a shippedAt/);
  assert.equal(normalizeRock({ title: "A", state: "shipped", shippedAt: "2026-08-01" }).shippedAt, "2026-08-01");
});

test("an id is derived from the title when none is given", () => {
  assert.equal(normalizeRock({ title: "Sub opt-in for NC" }).id, "sub-opt-in-for-nc");
});

test("a bad date is rejected rather than stored as garbage", () => {
  assert.throws(() => normalizeRock({ title: "A", lastMiniReadoutAt: "last tuesday" }), /is not a date/);
});

test("create, update and list round-trips", async () => {
  const rocks = await freshStore();
  await rocks.upsert({ title: "Redesigned Homepage", type: "initiative", owner: "87349065" });
  let listed = await rocks.list();
  assert.equal(listed.rocks.length, 1);
  assert.equal(listed.queue.length, 1);
  assert.equal(listed.rocks[0].owner, "87349065");

  await rocks.upsert({ id: "redesigned-homepage", state: "shipped", shippedAt: "2026-09-01" });
  listed = await rocks.list();
  assert.equal(listed.rocks.length, 1, "updating does not create a second rock");
  assert.equal(listed.rocks[0].state, "shipped");
  assert.equal(listed.rocks[0].title, "Redesigned Homepage", "fields not sent are preserved");
});

test("backlog rocks are separated from the active queue", async () => {
  const rocks = await freshStore();
  await rocks.upsert({ title: "Active one" });
  await rocks.upsert({ title: "Later one", state: "backlog" });
  const listed = await rocks.list();
  assert.equal(listed.queue.length, 1);
  assert.equal(listed.backlog.length, 1);
  assert.equal(listed.backlog[0].title, "Later one");
});

test("a stale write is rejected instead of clobbering the newer one", async () => {
  const rocks = await freshStore();
  await rocks.upsert({ title: "First" });
  const stale = (await rocks.list()).version;

  await rocks.upsert({ title: "Second" }); // someone else moves the store on

  await assert.rejects(
    () => rocks.upsert({ title: "Third" }, { expectedVersion: stale }),
    /changed since you loaded them/,
  );
});

test("the audit trail records what actually changed", async () => {
  const rocks = await freshStore();
  await rocks.upsert({ title: "Sub opt-in for NC", owner: null });
  await rocks.upsert({ id: "sub-opt-in-for-nc", owner: "44140689" });

  const trail = await rocks.auditTrail();
  assert.ok(trail.length >= 2);

  const latest = trail[0];
  const change = latest.changes.find((c) => c.id === "sub-opt-in-for-nc");
  assert.equal(change.change, "updated");
  assert.deepEqual(change.diff.owner, { from: null, to: "44140689" });
});

test("removing a rock is recorded, and removing a missing one errors", async () => {
  const rocks = await freshStore();
  await rocks.upsert({ title: "Temp" });
  await rocks.remove("temp");
  assert.equal((await rocks.list()).rocks.length, 0);
  await assert.rejects(() => rocks.remove("temp"), /No rock with id/);
});

test("an empty store seeds itself from config once, ignoring the example placeholder", async () => {
  const rocks = await freshStore();
  const seeded = await rocks.list({
    seed: [
      { id: "example-1", title: "EXAMPLE. Replace this." },
      { id: "real-one", title: "Redesigned Homepage", state: "active" },
    ],
  });
  assert.equal(seeded.rocks.length, 1, "the example is not imported");
  assert.equal(seeded.rocks[0].title, "Redesigned Homepage");

  // Seeding happens once. A later read must not re-import.
  await rocks.remove("real-one");
  const after = await rocks.list({ seed: [{ id: "real-one", title: "Redesigned Homepage" }] });
  assert.equal(after.rocks.length, 0, "seeding is a first-write migration, not a merge on every read");
});

test("the collector reads the store when it has one, and says where the data came from", async () => {
  const rocks = await freshStore();
  await rocks.upsert({ title: "Sub opt-in for NC", owner: "87349065" });

  const snapshot = await collectLeadership({
    config: testConfig({ leadershipQueue: { queue: [], backlog: [] } }),
    clickupSnapshot: { fieldMap: {}, members: [] },
    rocksStore: rocks,
  });

  assert.equal(snapshot.meta.source, "store");
  assert.equal(snapshot.queue.length, 1);
  assert.equal(snapshot.queue[0].title, "Sub opt-in for NC");
  assert.equal(snapshot.queue[0].priority, "P1", "everything in the queue is still a P1");
});

test("a store outage falls back to config rather than emptying Layer 1", async () => {
  const broken = { get: async () => { throw new Error("blobs unavailable"); }, set: async () => {}, keys: async () => [] };
  const rocks = new RocksStore(broken, null);
  const warnings = [];

  const snapshot = await collectLeadership({
    config: testConfig({ leadershipQueue: { queue: [{ id: "cfg", title: "From config", state: "active" }], backlog: [] } }),
    clickupSnapshot: { fieldMap: {}, members: [] },
    rocksStore: rocks,
    logger: { warn: (event, f) => warnings.push(event) },
  });

  assert.equal(snapshot.meta.source, "config");
  assert.equal(snapshot.queue[0].title, "From config");
  assert.ok(warnings.includes("leadership.store_unavailable"));
});

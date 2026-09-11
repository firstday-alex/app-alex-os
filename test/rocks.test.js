// The rocks store. Layer 1's data moved out of config and into a real store, so the
// things worth testing are the ones a config file gave us for free: validation,
// not losing a concurrent write, and an audit trail that says what changed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RocksStore, RockValidationError, normalizeRock, experienceIdFromUrl } from "../src/store/rocks.js";
import { Store } from "../src/lib/storage.js";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../src/config.js";
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

/* ------------------------- the fields Alex asked for ------------------------- */

test("status is the health field and is constrained to the three real options", () => {
  assert.throws(() => normalizeRock({ title: "A", status: "going ok" }), /status must be one of/);
  assert.equal(normalizeRock({ title: "A" }).status, "on_track", "defaults to On Track");
  for (const s of ["on_track", "at_risk", "done"]) {
    assert.equal(normalizeRock({ title: "A", status: s }).status, s);
  }
});

test("a rock still holding the retired off_track status loads as At Risk", () => {
  // A status that no longer exists must not make an existing rock uneditable.
  assert.equal(normalizeRock({ title: "A", status: "off_track" }).status, "at_risk");
});

test("status and state are independent: a rock can be active and At Risk", () => {
  const rock = normalizeRock({ title: "Redesigned Homepage", state: "active", status: "at_risk" });
  assert.equal(rock.state, "active");
  assert.equal(rock.status, "at_risk");
});

test("check-in date and the spec's mini readout are the same field", () => {
  // lastMiniReadoutAt is accepted as an alias so the config seed and older stored rocks load.
  assert.equal(normalizeRock({ title: "A", checkInDate: "2026-09-05" }).checkInDate, "2026-09-05");
  assert.equal(normalizeRock({ title: "A", lastMiniReadoutAt: "2026-09-05" }).checkInDate, "2026-09-05");
});

test("start date, KPI and notes round-trip", () => {
  const rock = normalizeRock({
    title: "Sub opt-in for NC",
    startDate: "2026-07-01",
    kpi: "pct_subscription_orders",
    notes: "Blocked on the subscription platform RFP",
  });
  assert.equal(rock.startDate, "2026-07-01");
  assert.equal(rock.kpi, "pct_subscription_orders");
  assert.match(rock.notes, /RFP/);
});

test("a start date after the shipped date is rejected", () => {
  assert.throws(
    () => normalizeRock({ title: "A", state: "shipped", startDate: "2026-09-01", shippedAt: "2026-08-01" }),
    /startDate is after shippedAt/,
  );
});

test("the ClickUp link is stored by option id, which survives a rename", () => {
  const rock = normalizeRock({ title: "Sub opt-in for NC", clickupOptionId: "f094b171-a5f8-4f88-904f-1bf17573bce5" });
  assert.equal(rock.clickupOptionId, "f094b171-a5f8-4f88-904f-1bf17573bce5");
  assert.equal(rock.title in rock, false, "the label is never stored as the link");
});

/* ------------------------------ links + readout ------------------------------ */

test("an Intelligems experiment id is read out of a pasted URL", () => {
  assert.equal(
    experienceIdFromUrl("https://app.intelligems.io/experiments/5aacbb4f-c08e-49f0-853f-dce08fd83446/results"),
    "5aacbb4f-c08e-49f0-853f-dce08fd83446",
  );
  assert.equal(experienceIdFromUrl("https://example.com/nothing-here"), null);
});

test("links accept a bare domain and are normalized, because an unclickable link is worse", () => {
  const rock = normalizeRock({ title: "A", websiteUrl: "first-day-inc.netlify.app" });
  assert.equal(rock.websiteUrl, "https://first-day-inc.netlify.app/");
});

test("a non-URL is rejected rather than stored", () => {
  assert.throws(() => normalizeRock({ title: "A", websiteUrl: "not a url at all" }), /is not a URL/);
});

test("the three-link caps are enforced", () => {
  assert.throws(() => normalizeRock({ title: "A", experimentLinks: ["a.com", "b.com", "c.com", "d.com"] }), /At most 3/);
  assert.throws(() => normalizeRock({ title: "A", reportLinks: ["a.com", "b.com", "c.com", "d.com"] }), /At most 3/);
  assert.equal(normalizeRock({ title: "A", experimentLinks: ["a.com", "b.com", "c.com"] }).experimentLinks.length, 3);
});

test("empty link rows are dropped, not stored as blanks", () => {
  const rock = normalizeRock({ title: "A", experimentLinks: [{ url: "", label: "x" }, { url: "a.com" }] });
  assert.equal(rock.experimentLinks.length, 1);
});

test("the per-rock readout joins the latest Intelligems snapshot", async () => {
  const { buildRockReadout } = await import("../src/store/rock-readout.js");
  const { snapshot, test: makeTest } = await import("./fixtures/tests.js");
  const config = testConfig();

  const rock = normalizeRock({
    title: "Price per gummy",
    experimentLinks: ["https://app.intelligems.io/experiments/5aacbb4f-c08e-49f0-853f-dce08fd83446"],
  });
  const snap = snapshot([makeTest({ id: "5aacbb4f-c08e-49f0-853f-dce08fd83446", name: "Price per Gummy", daysRunning: 42, minOrdersPerGroup: 238 })]);

  const readout = buildRockReadout(rock, snap, config);
  assert.equal(readout.state, "ok");
  assert.equal(readout.tests[0].found, true);
  assert.equal(readout.tests[0].name, "Price per Gummy");
  assert.equal(readout.tests[0].gateMet, false, "238 orders is short of 300");
  assert.equal(readout.headline, "Keep Running");
});

test("the readout says which of the three states it is in rather than showing nothing", async () => {
  const { buildRockReadout } = await import("../src/store/rock-readout.js");
  const { snapshot } = await import("./fixtures/tests.js");
  const config = testConfig();

  assert.equal(buildRockReadout(normalizeRock({ title: "A" }), snapshot([]), config).state, "no_experiments");

  const linked = normalizeRock({ title: "A", experimentLinks: ["https://app.intelligems.io/x/5aacbb4f-c08e-49f0-853f-dce08fd83446"] });
  assert.equal(buildRockReadout(linked, null, config).state, "no_snapshot");

  // Linked but absent from the running roster: reported as such, not silently empty.
  const gone = buildRockReadout(linked, snapshot([]), config);
  assert.equal(gone.state, "not_running");
  assert.equal(gone.tests[0].found, false);
  assert.match(gone.tests[0].message, /probably ended/);
});

/* ---------------------- the ClickUp link survives editing ---------------------- */

test("the rock editor's option list keeps an unrecognised link instead of dropping it", () => {
  // Lifted from the shipped file so the test cannot drift from the renderer.
  const app = fs.readFileSync(path.join(repoRoot, "public", "app.js"), "utf8");
  const start = app.indexOf("  const opts = (list, selected, blank) => {");
  assert.ok(start > 0, "the option renderer is still where the test expects it");
  const end = app.indexOf("\n  };", start) + "\n  };".length;
  const esc = (s) => String(s ?? "");
  const opts = new Function("esc", `${app.slice(start, end)}\n return opts;`)(esc);

  const list = [
    { id: "23eba93e", label: "Family Bundle Builder" },
    { id: "00eaa598", label: "New Problem Based Bundle Buy Box" },
  ];

  // The happy path: the stored id is on the field, and it is the one selected.
  const normal = opts(list, "23eba93e", "not linked");
  assert.match(normal, /value="23eba93e" selected/);
  assert.ok(!/no longer on this field/.test(normal));

  // The dangerous path: the stored id is NOT on the field. Without the orphan option the
  // browser would select the first entry, and saving would relink the rock to a
  // different Big Swing without anyone touching that field.
  const orphaned = opts(list, "deleted-option-id", "not linked");
  assert.match(orphaned, /value="deleted-option-id" selected/);
  assert.match(orphaned, /no longer on this field/);
  assert.ok(!/value="23eba93e" selected/.test(orphaned), "the first real option must not steal the selection");

  // And an unlinked rock still defaults to the blank entry rather than the first option.
  const blank = opts(list, null, "not linked");
  assert.match(blank, /<option value="" selected>not linked<\/option>/);
});

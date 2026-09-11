// Baseline selection. Tuesday picks Monday. Monday picks Friday. First run picks nothing.
// A refresh at 2 PM picks the same baseline as 8 AM did.

import { test } from "node:test";
import assert from "node:assert/strict";
import { previousWorkingDayKey, baselineCandidateKeys, shouldRunScheduled, dateKey } from "../src/lib/time.js";
import { Store } from "../src/lib/storage.js";
import { testConfig } from "./fixtures/config.js";

const config = testConfig();

test("Tuesday picks Monday", () => {
  assert.equal(previousWorkingDayKey("2026-09-08"), "2026-09-07"); // Tue -> Mon
});

test("Monday picks Friday, not Sunday", () => {
  assert.equal(previousWorkingDayKey("2026-09-07"), "2026-09-04"); // Mon -> Fri
});

test("the baseline candidate list starts at the previous working day and walks back", () => {
  const { today, candidates } = baselineCandidateKeys(new Date("2026-09-07T13:00:00Z"), config);
  assert.equal(today, "2026-09-07");
  assert.deepEqual(candidates.slice(0, 3), ["2026-09-04", "2026-09-03", "2026-09-02"]);
  assert.equal(candidates.length, config.system.storage.baselineLookbackWorkingDays);
});

test("a refresh at 2 PM picks the same baseline as the 8 AM run did", () => {
  const morning = baselineCandidateKeys(new Date("2026-09-10T13:00:00Z"), config); // 8 AM Central
  const afternoon = baselineCandidateKeys(new Date("2026-09-10T19:00:00Z"), config); // 2 PM Central
  assert.deepEqual(afternoon.candidates, morning.candidates, "the baseline must not float during the day");
  assert.equal(afternoon.today, morning.today);
});

test("first run picks nothing, because there is no official snapshot to pick", async () => {
  const store = await Store.open({ config, mode: "memory" });
  const { candidates } = baselineCandidateKeys(new Date("2026-09-10T13:00:00Z"), config);
  const baseline = await store.getBaseline("clickup", candidates);
  assert.equal(baseline.snapshot, null);
  assert.equal(baseline.key, null);
});

test("the baseline is the previous working day's OFFICIAL snapshot, not a refresh from it", async () => {
  const store = await Store.open({ config, mode: "memory" });
  await store.putSnapshot("clickup", { items: [{ id: "a" }], takenAt: "x" }, { dateKey: "2026-09-09", timeKey: "08-00", mode: "official", runId: "r1" });
  await store.putSnapshot("clickup", { items: [{ id: "b" }], takenAt: "y" }, { dateKey: "2026-09-09", timeKey: "14-30", mode: "refresh", runId: "r2" });

  const { candidates } = baselineCandidateKeys(new Date("2026-09-10T13:00:00Z"), config);
  const baseline = await store.getBaseline("clickup", candidates);
  assert.equal(baseline.dateKey, "2026-09-09");
  assert.equal(baseline.snapshot.items[0].id, "a", "a mid-day refresh must not become the next day's baseline");
  assert.equal(baseline.stale, false);
});

test("a missed day walks further back and marks the baseline stale", async () => {
  const store = await Store.open({ config, mode: "memory" });
  // Nothing on Wednesday. Tuesday is the most recent official snapshot.
  await store.putSnapshot("clickup", { items: [{ id: "tue" }] }, { dateKey: "2026-09-08", timeKey: "08-00", mode: "official", runId: "r1" });
  const { candidates } = baselineCandidateKeys(new Date("2026-09-10T13:00:00Z"), config);
  const baseline = await store.getBaseline("clickup", candidates);
  assert.equal(baseline.dateKey, "2026-09-08");
  assert.equal(baseline.stale, true, "an older-than-yesterday baseline has to say so in the readout");
});

test("a collapsed pull is not stored, so it cannot destroy the baseline", async () => {
  const store = await Store.open({ config, mode: "memory" });
  await store.putSnapshot("clickup", { items: [{ id: "good" }] }, { dateKey: "2026-09-09", timeKey: "08-00", mode: "official", runId: "r1" });

  // No items, and the collector recorded failures. That is a collapse, not an answer.
  const result = await store.putSnapshot(
    "clickup",
    { items: [], failures: [{ error: "upstream 500" }] },
    { dateKey: "2026-09-10", timeKey: "08-00", mode: "official", runId: "r2" },
  );
  assert.equal(result.stored, false);

  const { candidates } = baselineCandidateKeys(new Date("2026-09-11T13:00:00Z"), config);
  const baseline = await store.getBaseline("clickup", candidates);
  assert.equal(baseline.snapshot.items[0].id, "good", "yesterday's good snapshot still stands");
});

test("a snapshot marked empty by its collector is refused too", async () => {
  const store = await Store.open({ config, mode: "memory" });
  const result = await store.putSnapshot("clickup", { items: [], empty: true }, { dateKey: "2026-09-10", timeKey: "08-00", mode: "official", runId: "r1" });
  assert.equal(result.stored, false);
});

test("a legitimately empty result IS stored, so those sources still get a baseline", async () => {
  // Zero tests running, or an empty leadership queue, are real answers. Refusing them
  // would leave Layer 3 and Layer 1 without a baseline forever.
  const store = await Store.open({ config, mode: "memory" });
  const lines = [];
  store.logger = { info: (event, f) => lines.push(event), warn: () => {} };

  const result = await store.putSnapshot("intelligems", { items: [], failures: [] }, { dateKey: "2026-09-10", timeKey: "08-00", mode: "official", runId: "r1" });
  assert.equal(result.stored, true);
  assert.ok(lines.includes("snapshot.no_items"), "stored, but said out loud");

  const { candidates } = baselineCandidateKeys(new Date("2026-09-11T13:00:00Z"), config);
  const baseline = await store.getBaseline("intelligems", candidates);
  assert.deepEqual(baseline.snapshot.items, []);
});

test("the schedule runs at 8 AM Central in both halves of the year and never at the wrong hour", () => {
  // Cron fires 13:00 and 14:00 UTC. Exactly one is 8 AM Central on a given day.
  assert.equal(shouldRunScheduled(new Date("2026-09-10T13:00:00Z"), config).run, true, "summer, CDT");
  assert.equal(shouldRunScheduled(new Date("2026-09-10T14:00:00Z"), config).run, false);
  assert.equal(shouldRunScheduled(new Date("2026-01-13T14:00:00Z"), config).run, true, "winter, CST");
  assert.equal(shouldRunScheduled(new Date("2026-01-13T13:00:00Z"), config).run, false);
});

test("the schedule skips the weekend", () => {
  assert.equal(dateKey(new Date("2026-09-12T13:00:00Z"), "America/Chicago"), "2026-09-12");
  assert.equal(shouldRunScheduled(new Date("2026-09-12T13:00:00Z"), config).run, false, "Saturday");
  assert.equal(shouldRunScheduled(new Date("2026-09-13T13:00:00Z"), config).run, false, "Sunday");
});

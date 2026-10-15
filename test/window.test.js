// Comparison windows. What matters: each window picks the snapshot it claims to, says so
// honestly when nothing is old enough, and hourly snapshots are pruned without ever
// touching the readout's own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startOfLocalDay, windowStart, pickBaselineEntry, mergeComments, rockChangesSince } from "../src/delta/window.js";
import { pruneHourly, takeHourlySnapshot } from "../src/hourly-snapshot.js";
import { Store } from "../src/lib/storage.js";
import { testConfig } from "./fixtures/config.js";

const TZ = "America/Chicago";

test("today starts at local midnight, not UTC midnight", () => {
  // 2026-10-15 14:30 Central (CDT, UTC-5) is 19:30 UTC.
  const now = new Date("2026-10-15T19:30:00Z");
  assert.equal(startOfLocalDay(now, TZ).toISOString(), "2026-10-15T05:00:00.000Z");
});

test("24 hours is 24 hours back from now", () => {
  const now = new Date("2026-10-15T19:30:00Z");
  assert.equal(windowStart("24h", now, TZ).toISOString(), "2026-10-14T19:30:00.000Z");
  assert.throws(() => windowStart("week", now, TZ), /window must be one of/);
});

const at = (iso, key = iso) => ({ key, takenAt: iso, mode: "hourly" });

test("the baseline is the newest snapshot at or before the window's start", () => {
  const entries = [at("2026-10-14T18:05:00Z"), at("2026-10-14T19:05:00Z"), at("2026-10-14T20:05:00Z"), at("2026-10-15T19:05:00Z")];
  const pick = pickBaselineEntry(entries, new Date("2026-10-14T19:30:00Z"));
  assert.equal(pick.entry.takenAt, "2026-10-14T19:05:00Z");
  assert.equal(pick.gapMinutes, 25);
  assert.equal(pick.coversWindow, true);
});

test("when nothing is old enough, the oldest stands in and says it covers less", () => {
  const pick = pickBaselineEntry([at("2026-10-15T10:05:00Z"), at("2026-10-15T12:05:00Z")], new Date("2026-10-14T19:30:00Z"));
  assert.equal(pick.entry.takenAt, "2026-10-15T10:05:00Z");
  assert.equal(pick.coversWindow, false);
  assert.equal(pickBaselineEntry([], new Date()), null);
});

test("comments merge across the window with the newest winning", () => {
  const merged = mergeComments([
    { comments: { a: { latest: { text: "old" } }, b: { latest: { text: "only" } } } },
    { comments: { a: { latest: { text: "new" } } } },
  ]);
  assert.equal(merged.a.latest.text, "new");
  assert.equal(merged.b.latest.text, "only");
});

test("rock changes are the audit entries inside the window, newest first", () => {
  const entries = [{ at: "2026-10-14T10:00:00Z" }, { at: "2026-10-15T12:00:00Z" }, { at: "2026-10-15T09:00:00Z" }];
  assert.deepEqual(rockChangesSince(entries, new Date("2026-10-15T05:00:00Z")).map((e) => e.at), ["2026-10-15T12:00:00Z", "2026-10-15T09:00:00Z"]);
});

test("pruning removes old hourly snapshots only, never the readout's", async () => {
  const store = await Store.open({ config: testConfig(), mode: "memory" });
  const prefix = `${store.prefixes.snapshotPrefix ?? "snapshots"}/clickup/`;
  for (const key of ["2026-09-01T09-05-hourly.json", "2026-09-01T08-00-official.json", "2026-09-01T10-00-refresh.json", "2026-10-14T09-05-hourly.json"]) {
    await store.backend.set(prefix + key, { takenAt: "x" });
  }
  assert.equal(await pruneHourly({ store, today: "2026-10-15", keepDays: 14 }), 1);
  const left = (await store.backend.keys(prefix)).map((k) => k.slice(prefix.length)).sort();
  assert.deepEqual(left, ["2026-09-01T08-00-official.json", "2026-09-01T10-00-refresh.json", "2026-10-14T09-05-hourly.json"]);
});

test("an hourly run within half an hour of the last snapshot is skipped without calling ClickUp", async () => {
  const config = testConfig();
  const store = await Store.open({ config, mode: "memory" });
  await store.putSnapshot("clickup", { takenAt: "2026-10-15T13:00:00Z", items: [{ id: "1" }] }, { dateKey: "2026-10-15", timeKey: "08-00", mode: "official", runId: "r" });
  let called = false;
  const result = await takeHourlySnapshot({
    config, store, token: "t", now: new Date("2026-10-15T13:05:00Z"),
    fetchImpl: async () => { called = true; throw new Error("should not fetch"); },
  });
  assert.equal(result.skipped, true);
  assert.equal(called, false);
});

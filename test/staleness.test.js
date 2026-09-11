// Time in status.
//
// ClickUp's own time_in_status endpoint returns an empty history on this plan, so the
// clock is kept from this system's daily snapshots. That makes two things worth pinning
// down: a ticket first seen mid-flight must report a floor rather than a guess, and
// running twice in a day must not restamp the clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { StatusLedger, statusAge, isStale, stalenessThreshold } from "../src/store/status-ledger.js";

const DAY = 86_400_000;

function backend() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? JSON.parse(map.get(key)) : null;
    },
    async set(key, value) {
      map.set(key, JSON.stringify(value));
    },
  };
}

const config = {
  clickup: {
    staleness: {
      enabled: true,
      thresholdDaysByStatus: { "in-progress": 7, vqa: 3 },
      thresholdDaysByBucket: { inProgress: 7 },
    },
  },
};

const ticket = (over = {}) => ({
  id: "t1",
  name: "Ship the thing",
  status: "in-progress",
  bucket: "inProgress",
  statusType: "custom",
  closed: false,
  ...over,
});

test("a ticket first seen mid-flight reports a floor, not a guess", async () => {
  const now = new Date("2026-09-11T13:00:00Z");
  const ledger = new StatusLedger(backend());

  // Nothing has touched it for 16 days. date_updated moves on ANY activity including a
  // status change, so it has been in this status for at least 16 days.
  const doc = await ledger.update(
    [ticket({ dateUpdated: now.getTime() - 16 * DAY, dateCreated: now.getTime() - 66 * DAY })],
    now,
  );

  const age = statusAge(doc.entries.t1, now);
  assert.equal(age.days, 16);
  assert.equal(age.exact, false, "we did not watch the transition, so this is a bound");
  assert.equal(age.ceilingDays, 66, "and the ticket cannot have been there longer than it has existed");
});

test("once a transition is watched the number becomes exact and loses its ceiling", async () => {
  const be = backend();
  const ledger = new StatusLedger(be);
  const day1 = new Date("2026-09-01T13:00:00Z");
  await ledger.update([ticket({ dateUpdated: day1.getTime() - 16 * DAY, dateCreated: day1.getTime() - 66 * DAY })], day1);

  // Ten days later it moves to QA.
  const day11 = new Date("2026-09-11T13:00:00Z");
  const doc = await ledger.update([ticket({ status: "vqa", dateUpdated: day11.getTime() })], day11);

  const age = statusAge(doc.entries.t1, day11);
  assert.equal(age.days, 0, "the clock restarted when the status changed");
  assert.equal(age.exact, true);
  assert.equal(age.ceilingDays, null, "a measured age needs no upper bound");
  assert.equal(age.previousStatus, "in-progress");
});

test("running twice in a day does not restamp the clock", async () => {
  const be = backend();
  const ledger = new StatusLedger(be);
  const day1 = new Date("2026-09-01T13:00:00Z");
  await ledger.update([ticket({ dateUpdated: day1.getTime() - 10 * DAY })], day1);

  const later = new Date("2026-09-08T13:00:00Z");
  await ledger.update([ticket({ dateUpdated: later.getTime() })], later);
  const doc = await ledger.update([ticket({ dateUpdated: later.getTime() })], later);

  // A transition is "the status differs from the one on file", not "a run happened".
  // Seven days of sitting still must survive a second run, and a third.
  assert.equal(statusAge(doc.entries.t1, later).days, 17);
  assert.equal(doc.entries.t1.exact, false, "no transition was ever observed");
});

test("a refresh can observe without recording", async () => {
  const be = backend();
  const ledger = new StatusLedger(be);
  const now = new Date("2026-09-11T13:00:00Z");
  await ledger.update([ticket({ dateUpdated: now.getTime() })], now, { persist: false });
  assert.equal(be.map.size, 0, "a mid-day refresh must not restamp what the 8 AM run dated");
});

test("closed work is not tracked, so the ledger does not grow without bound", async () => {
  const ledger = new StatusLedger(backend());
  const now = new Date("2026-09-11T13:00:00Z");
  const doc = await ledger.update(
    [
      ticket({ id: "open", dateUpdated: now.getTime() }),
      ticket({ id: "shipped", status: "complete", bucket: "done", closed: true }),
    ],
    now,
  );
  // 229 of 242 tickets on the live board are complete.
  assert.deepEqual(Object.keys(doc.entries), ["open"]);
});

test("a ticket that leaves the query is dropped, and comes back with a fresh clock", async () => {
  const be = backend();
  const ledger = new StatusLedger(be);
  const day1 = new Date("2026-09-01T13:00:00Z");
  await ledger.update([ticket({ dateUpdated: day1.getTime() })], day1);
  const gone = await ledger.update([], new Date("2026-09-02T13:00:00Z"));
  assert.deepEqual(Object.keys(gone.entries), []);
});

test("an untracked ticket is unknown, never zero days", () => {
  assert.equal(statusAge(undefined, new Date()), null);
  assert.equal(statusAge({ since: null }, new Date()), null);
});

test("Not Started has no limit at all, however long it sits", () => {
  const backlog = ticket({ status: "to do", bucket: "notStarted" });
  assert.equal(stalenessThreshold(backlog, config), null);
  assert.equal(isStale(backlog, { days: 400, exact: true }, config), null, "a backlog is supposed to sit");
});

test("the limit comes from the status before the bucket", () => {
  // Both are the inProgress bucket. A week in progress is work; a week in QA is a queue.
  assert.equal(stalenessThreshold(ticket({ status: "in-progress" }), config), 7);
  assert.equal(stalenessThreshold(ticket({ status: "vqa" }), config), 3);

  assert.equal(isStale(ticket({ status: "vqa" }), { days: 4, exact: true }, config).over, 1);
  assert.equal(isStale(ticket({ status: "in-progress" }), { days: 4, exact: true }, config), null);
});

test("a status with no number of its own falls back to its bucket", () => {
  assert.equal(stalenessThreshold(ticket({ status: "ready for deploy" }), config), 7);
});

/* --------------------------------- backfill --------------------------------- */

test("the ledger rebuilds from stored snapshots, dating transitions to when they happened", async () => {
  const be = backend();
  const ledger = new StatusLedger(be);

  // Three days of official snapshots. The ticket moves to QA on the 3rd.
  const snapshots = {
    "snapshots/clickup/2026-09-01.json": [ticket({ status: "in-progress", dateUpdated: Date.parse("2026-08-20") })],
    "snapshots/clickup/2026-09-02.json": [ticket({ status: "in-progress" })],
    "snapshots/clickup/2026-09-03.json": [ticket({ status: "vqa" })],
  };
  const store = {
    async readIndex() {
      return {
        officialByDate: {
          "2026-09-01": "snapshots/clickup/2026-09-01.json",
          "2026-09-02": "snapshots/clickup/2026-09-02.json",
          "2026-09-03": "snapshots/clickup/2026-09-03.json",
        },
      };
    },
    async getSnapshot(key) {
      return { items: snapshots[key] };
    },
  };

  const result = await ledger.backfill(store, new Date("2026-09-11T13:00:00Z"));
  assert.equal(result.snapshotsFolded, 3);

  const doc = await ledger.read();
  const age = statusAge(doc.entries.t1, new Date("2026-09-11T13:00:00Z"));

  // The move to QA is dated to 2026-09-03, the day it was observed — not to the day the
  // backfill ran. Eight days in QA, and exact, because we have the two snapshots that
  // bracket the change.
  assert.equal(age.exact, true, "a transition between two stored snapshots was genuinely witnessed");
  assert.equal(age.days, 8);
  assert.equal(age.previousStatus, "in-progress");
});

test("a backfill with no stored snapshots says so rather than inventing a clock", async () => {
  const ledger = new StatusLedger(backend());
  const result = await ledger.backfill({ async readIndex() { return { officialByDate: {} }; } }, new Date());
  assert.equal(result.rebuilt, false);
});

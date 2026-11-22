import { test } from "node:test";
import assert from "node:assert/strict";
import { assigneeDrift, sprintDriftFromStore } from "../src/delta/assignee-drift.js";
import { restoreAssignees } from "../src/send/clickup-assignee.js";
import { Store } from "../src/lib/storage.js";
import { zonedParts, shiftDateKey } from "../src/lib/time.js";

const ana = { id: "1", username: "Ana" };
const ben = { id: "2", username: "Ben" };
const t = (id, status, assignees) => ({ id, name: `Ticket ${id}`, url: `https://app.clickup.com/t/${id}`, status, assignees });

test("a done ticket that changed hands since it came onto the sprint is flagged, with who it had then and now", () => {
  const snapshots = [
    { key: "s/2026-11-16T0800", dateKey: "2026-11-16", items: [t("a", "to do", [ana]), t("b", "to do", [ana]), t("c", "to do", [])] },
    { key: "s/2026-11-18T0800", dateKey: "2026-11-18", items: [t("a", "qa", [ben]), t("b", "qa", [ana]), t("c", "qa", [ben]), t("d", "to do", [ana])] },
    { key: "s/2026-11-20T0800", dateKey: "2026-11-20", items: [t("a", "done (this sprint)", [ben]), t("b", "done (this sprint)", [ana]), t("c", "done (this sprint)", [ben]), t("d", "done (this sprint)", [ben]), t("e", "done (this sprint)", [ben])] },
  ];
  const out = assigneeDrift({ snapshots, current: snapshots[2].items });
  // a: Ana → Ben, flagged. b: unchanged. c: nobody at first, so nothing to put back. d: first seen
  // Wednesday on Ana, now Ben. e: only in the latest snapshot, no history.
  assert.deepEqual(out.map((x) => [x.id, x.firstSeen, x.was.map((u) => u.username).join(), x.now.map((u) => u.username).join()]), [
    ["a", "2026-11-16", "Ana", "Ben"],
    ["d", "2026-11-18", "Ana", "Ben"],
  ]);
});

test("a ticket not yet done is left alone, however it moved", () => {
  const snapshots = [
    { key: "1", dateKey: "2026-11-16", items: [t("a", "to do", [ana])] },
    { key: "2", dateKey: "2026-11-17", items: [t("a", "in-progress", [ben])] },
  ];
  assert.equal(assigneeDrift({ snapshots, current: snapshots[1].items }).length, 0);
});

const config = (extra = {}) => ({ system: { timezone: "America/Chicago", http: { maxAttempts: 1, backoffMsSchedule: [0] } }, clickup: { apiBase: "https://api.clickup.com/api/v2" }, people: { team: [] }, ...extra });

async function storeWith(snaps) {
  const store = await Store.open({ config: config(), mode: "memory" });
  for (const s of snaps) await store.putSnapshot("clickup", { takenAt: s.at, items: s.items }, { dateKey: s.dateKey, timeKey: s.timeKey, mode: "official", runId: s.timeKey });
  return store;
}

test("put back: only a flagged ticket, adds who it had and removes who was not on it", async () => {
  const store = await storeWith([
    { dateKey: "2026-11-16", timeKey: "0800", items: [t("a", "to do", [ana]), t("b", "to do", [ana])] },
    { dateKey: "2026-11-20", timeKey: "0800", items: [t("a", "done (this sprint)", [ben]), t("b", "done (this sprint)", [ana])] },
  ]);
  const now = new Date("2026-11-20T18:00:00Z");
  const found = await sprintDriftFromStore({ store, config: config(), now, zonedParts, shiftDateKey });
  assert.equal(found.since, "2026-11-16");
  assert.deepEqual(found.tickets.map((x) => x.id), ["a"]);

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const out = await restoreAssignees({ config: config(), store, token: "tok", taskId: "a", fetchImpl, now });
  assert.deepEqual(calls, [{ url: "https://api.clickup.com/api/v2/task/a", body: { assignees: { add: [1], rem: [2] } } }]);
  assert.deepEqual(out.assignees.map((u) => u.username), ["Ana"]);
  await assert.rejects(restoreAssignees({ config: config(), store, token: "tok", taskId: "b", fetchImpl, now }), /not flagged/);
  assert.equal(calls.length, 1);
});

// Starred wins: graded A+ / A / A-, kept for good, grouped by week or month of completion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { starWin, unstarWin, readStarred, starRecord, StarError } from "../src/store/starred-wins.js";
import { groupStarred } from "../public/starred.js";

const memory = () => {
  const m = new Map();
  return { get: async (k) => structuredClone(m.get(k) ?? null), set: async (k, v) => void m.set(k, structuredClone(v)) };
};
const win = { key: "task:abc123", title: "BYOB gridwall", url: "https://app.clickup.com/t/abc123", rock: "Upsells / Bundles 2.0", why: "It shipped.", kudos: [{ name: "Akansha Rao", for: "QA" }], who: ["Akansha Rao"], date: "2026-11-18T15:00:00.000Z" };

test("starring keeps a clean copy of the win, regrading keeps when it was first starred, unstar removes it", async () => {
  const b = memory();
  const first = await starWin(b, { win, grade: "A", now: new Date("2026-11-20T10:00:00Z") });
  assert.equal(first.grade, "A");
  assert.equal(first.completedAt, "2026-11-18T15:00:00.000Z");
  const again = await starWin(b, { win, grade: "A+", now: new Date("2026-11-21T10:00:00Z") });
  assert.equal(again.grade, "A+");
  assert.equal(again.starredAt, "2026-11-20T10:00:00.000Z");
  assert.equal(Object.keys((await readStarred(b)).items).length, 1);
  assert.equal(await unstarWin(b, { key: win.key }), true);
  assert.deepEqual((await readStarred(b)).items, {});
});

test("only A+, A or A-, a real win key, and https links are kept", () => {
  assert.throws(() => starRecord(win, "B"), StarError);
  assert.throws(() => starRecord({ ...win, key: "../x" }, "A"), StarError);
  assert.equal(starRecord({ ...win, url: "javascript:alert(1)" }, "A").url, null);
  assert.equal(starRecord({ ...win, date: null }, "A", new Date("2026-11-20T10:00:00Z")).completedAt, "2026-11-20T10:00:00.000Z");
});

test("grouped by week (Monday) or month, newest first; A+ before A before A- within a group", () => {
  const items = [
    { key: "a", grade: "A-", completedAt: new Date(2026, 10, 18, 12).toISOString() },
    { key: "b", grade: "A+", completedAt: new Date(2026, 10, 17, 12).toISOString() },
    { key: "c", grade: "A", completedAt: new Date(2026, 10, 4, 12).toISOString() },
    { key: "d", grade: "A", completedAt: new Date(2026, 9, 30, 12).toISOString() },
  ];
  const weeks = groupStarred(items, "week");
  assert.deepEqual(weeks.map((g) => g.id), ["2026-11-16", "2026-11-02", "2026-10-26"]);
  assert.deepEqual(weeks[0].items.map((i) => i.key), ["b", "a"]);
  const months = groupStarred(items, "month");
  assert.deepEqual(months.map((g) => g.id), ["2026-11", "2026-10"]);
  assert.deepEqual(months[0].items.map((i) => i.key), ["b", "c", "a"]);
});

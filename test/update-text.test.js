// The daily update text. It has to pick the right tickets (touched since the previous
// working day, in one of the statuses that go in the update) and say only what ClickUp says.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpdate, updateText, windowStart, cleanName, kindEmoji } from "../public/update-text.js";

const DAY = 86_400_000;
const handleFor = (u) => u.username.split(" ")[0];
const robson = { id: "1", username: "Robson Lopes" };
const akansha = { id: "2", username: "Akansha Gupta" };

test("the window opens at the start of the previous working day, Friday on a Monday", () => {
  const tuesday = new Date(2026, 9, 27, 10, 0);
  assert.equal(new Date(windowStart(tuesday)).getDate(), 26);
  const monday = new Date(2026, 9, 26, 10, 0);
  const start = new Date(windowStart(monday));
  assert.equal(start.getDay(), 5);
  assert.equal(start.getHours(), 0);
});

test("only tickets touched in the window, in an update status, grouped by Big Swing", () => {
  const now = Date.now();
  const since = now - DAY;
  const tasks = [
    { id: "a", name: "Design -Support Secondary CTA", status: "qa", bucket: "active", assignees: [robson], dateUpdated: now - 3600_000, bigSwing: { label: "Upsells" } },
    { id: "b", name: "Bundle page build", status: "done", bucket: "done", taskOwners: [robson, akansha], dateClosed: now - 7200_000, bigSwing: { label: "Upsells" } },
    { id: "c", name: "Old ticket", status: "in-progress", bucket: "active", assignees: [robson], dateUpdated: now - 5 * DAY, bigSwing: { label: "Upsells" } },
    { id: "d", name: "Commented on", status: "to do", bucket: "active", assignees: [akansha], dateUpdated: now - 5 * DAY, lastComment: { date: now - 600_000 } },
    { id: "e", name: "Done long ago, edited today", status: "done", bucket: "done", assignees: [akansha], dateClosed: now - 9 * DAY, dateUpdated: now },
    { id: "f", name: "Parked", status: "blocked", bucket: "active", assignees: [akansha], dateUpdated: now },
  ];
  const groups = buildUpdate(tasks, { since, handleFor });
  assert.deepEqual(groups.map((g) => g.label), ["Upsells", "No Big Swing"]);
  assert.deepEqual(groups[0].tasks.map((x) => x.task.id), ["b", "a"]);
  assert.equal(groups[0].tasks[0].text, "✅ @Robson + @Akansha Bundle page build (done)");
  assert.equal(groups[0].tasks[1].text, "🎨 @Robson Support Secondary CTA (in qa)");
  assert.equal(groups[1].tasks[0].text, "@Akansha Commented on (to do)");

  assert.equal(updateText(groups), "Upsells\nUpdate: ✅ @Robson + @Akansha Bundle page build (done) 🎨 @Robson Support Secondary CTA (in qa)\n\nNo Big Swing\nUpdate: @Akansha Commented on (to do)");
  assert.equal(updateText(groups, new Set(["d"])), "Upsells\nUpdate: ✅ @Robson + @Akansha Bundle page build (done) 🎨 @Robson Support Secondary CTA (in qa)");
});

test("type prefixes come off the name, and the emoji is read off keywords or left out", () => {
  assert.equal(cleanName("DEV - All in 1 Bundle Page"), "All in 1 Bundle Page");
  assert.equal(cleanName("[DEV] Gifts should show value at Checkout"), "Gifts should show value at Checkout");
  assert.equal(kindEmoji("AB Test - Expedited Shipping Addition"), "🧪");
  assert.equal(kindEmoji("Preorder ship date missing from checkout"), "");
});

test("accomplishments are the tickets closed since Monday, grouped by Big Swing, in the order they closed", async () => {
  const { buildAccomplishments, accomplishmentsText, weekStart } = await import("../public/update-text.js");
  const thursday = new Date(2026, 9, 29, 15, 0);
  const monday = weekStart(thursday);
  assert.equal(new Date(monday).getDay(), 1);
  assert.equal(new Date(monday).getDate(), 26);
  assert.equal(weekStart(new Date(2026, 9, 26, 9, 0)), monday);

  const tasks = [
    { id: "a", name: "Second win", bucket: "done", status: "done", assignees: [robson], dateClosed: monday + 2 * DAY, bigSwing: { label: "Quiz" } },
    { id: "b", name: "First win", bucket: "done", status: "done", assignees: [akansha], dateClosed: monday + 3600_000, bigSwing: { label: "Quiz" } },
    { id: "c", name: "Last week", bucket: "done", status: "done", assignees: [akansha], dateClosed: monday - 3600_000 },
    { id: "d", name: "Still open", bucket: "active", status: "qa", assignees: [akansha], dateUpdated: monday + DAY },
  ];
  const groups = buildAccomplishments(tasks, { since: monday, handleFor });
  assert.equal(accomplishmentsText(groups), "Quiz\n✅ @Akansha First win\n✅ @Robson Second win");
});

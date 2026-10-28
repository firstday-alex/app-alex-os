// The daily update and accomplishments text. They have to pick the right tickets (the
// update: touched since the previous working day, never "complete"; accomplishments: done
// in the window) and say only what ClickUp says.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAccomplishments, buildUpdate, cleanName, groupsText, shortDate, windowStart } from "../public/update-text.js";

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

test("the update: touched in the window, done (this sprint) but never complete, grouped by **Big Swing**, one per line", () => {
  const now = Date.now();
  const since = now - DAY;
  const tasks = [
    { id: "a", name: "Design -Support Secondary CTA", status: "qa", assignees: [robson], taskOwners: [akansha], dateUpdated: now - 3600_000, bigSwing: { label: "Upsells" } },
    { id: "b", name: "Bundle page build", status: "done (this sprint)", assignees: [robson, akansha], dateUpdated: now - 7200_000, bigSwing: { label: "Upsells" } },
    { id: "c", name: "Old ticket", status: "in-progress", assignees: [robson], dateUpdated: now - 5 * DAY, bigSwing: { label: "Upsells" } },
    { id: "d", name: "Commented on", status: "to do", assignees: [akansha], dateUpdated: now - 5 * DAY, lastComment: { date: now - 600_000 } },
    { id: "e", name: "Closed today", status: "complete", bucket: "done", assignees: [akansha], dateClosed: now - 600_000, dateUpdated: now },
    { id: "f", name: "Parked", status: "blocked", assignees: [akansha], dateUpdated: now },
  ];
  const groups = buildUpdate(tasks, { since, handleFor });
  assert.deepEqual(groups.map((g) => g.label), ["Upsells", "No Big Swing"]);
  assert.deepEqual(groups[0].tasks.map((x) => x.task.id), ["b", "a"]);
  const today = shortDate(now);
  assert.equal(groups[0].tasks[0].text, `✅ @Robson + @Akansha – Bundle page build – done ${shortDate(now - 7200_000)}`);
  assert.equal(groups[0].tasks[1].text, `@Robson – QA – Support Secondary CTA – last update: ${today}`);
  assert.equal(groups[1].tasks[0].text, `@Akansha – To do – Commented on – last update: ${today}`);

  assert.equal(
    groupsText(groups),
    `**Upsells**\n${groups[0].tasks[0].text}\n${groups[0].tasks[1].text}\n\n**No Big Swing**\n${groups[1].tasks[0].text}`,
  );
  assert.equal(groupsText(groups, new Set(["d"])), `**Upsells**\n${groups[0].tasks[0].text}\n${groups[0].tasks[1].text}`);
});

test("accomplishments: complete or done (this sprint) inside the window, newest first", () => {
  const now = Date.now();
  const tasks = [
    { id: "a", name: "Older win", status: "complete", bucket: "done", assignees: [robson], dateClosed: now - 20 * DAY, bigSwing: { label: "Quiz" } },
    { id: "b", name: "Newer win", status: "complete", bucket: "done", assignees: [akansha], dateClosed: now - 2 * DAY, bigSwing: { label: "Quiz" } },
    { id: "c", name: "This sprint", status: "done (this sprint)", assignees: [akansha], dateUpdated: now - DAY, bigSwing: { label: "Quiz" } },
    { id: "d", name: "Too old", status: "complete", bucket: "done", assignees: [akansha], dateClosed: now - 40 * DAY, dateUpdated: now },
    { id: "e", name: "Still open", status: "qa", assignees: [akansha], dateUpdated: now },
  ];
  const groups = buildAccomplishments(tasks, { since: now - 30 * DAY, handleFor });
  assert.deepEqual(groups[0].tasks.map((x) => x.task.id), ["c", "b", "a"]);
  assert.equal(groups[0].tasks[2].text, `✅ @Robson – Older win – done ${shortDate(now - 20 * DAY)}`);
  assert.equal(buildAccomplishments(tasks, { since: now - 7 * DAY, handleFor })[0].tasks.length, 2);
});

test("type prefixes come off the name, and dates read MM/DD", () => {
  assert.equal(cleanName("DEV - All in 1 Bundle Page"), "All in 1 Bundle Page");
  assert.equal(cleanName("[DEV] Gifts should show value at Checkout"), "Gifts should show value at Checkout");
  assert.equal(shortDate(new Date(2026, 9, 7).getTime()), "10/07");
});

test("update + stand-up: a line goes under the poster's ticket it names, pulls in an untouched one, and the rest is listed", async () => {
  const { buildStandupUpdate, standupUpdateText, matchScore, wordCounts } = await import("../public/update-text.js");
  const now = Date.now();
  const cris = { id: "3", username: "Cristobal Alanis" };
  const tasks = [
    { id: "fbb", name: "Family Bundle Builder V4 + Analysis V3", status: "in-progress", assignees: [cris], dateUpdated: now - 5 * DAY, bigSwing: { label: "FBB" } },
    { id: "card", name: "Checkout card: wrong offer on box carts", status: "done (this sprint)", assignees: [], dateUpdated: now - 3600_000 },
    { id: "gwp", name: "GWP Opt-in (cart + checkout)", status: "in-progress", assignees: [robson], dateUpdated: now - 3600_000 },
    { id: "gift", name: "Gifts should show value at Checkout", status: "qa", assignees: [robson], dateUpdated: now - 3600_000 },
    { id: "pre", name: "Preorder ship date missing from checkout and cart", status: "qa", assignees: [cris], dateUpdated: now - 3600_000 },
  ];
  const days = [
    {
      dateKey: "x",
      posts: [
        { name: "Cristobal Alanis", postedAt: now - 600_000, yesterday: ["Checkout card fix live, no wrong offer on box carts", "Clarity data"], today: ["FBB V4: match the mock"], blockers: ["need admin"] },
        { name: "Robson Lopes", postedAt: now - 600_000, yesterday: ["Testing cart/checkout"], today: [], blockers: [] },
      ],
    },
  ];
  const built = buildStandupUpdate(tasks, days, { since: now - DAY, handleFor });
  const notesOf = (id) => built.groups.flatMap((g) => g.tasks).find((x) => x.task.id === id)?.notes.map((n) => n.text);
  assert.deepEqual(notesOf("fbb"), ["FBB V4: match the mock"]);
  assert.equal(built.groups.flatMap((g) => g.tasks).find((x) => x.task.id === "fbb").fromStandup, true);
  assert.deepEqual(notesOf("card"), ["Checkout card fix live, no wrong offer on box carts"]);
  // Two words that are on most tickets are not enough.
  assert.deepEqual(notesOf("gwp"), []);
  assert.deepEqual(built.extra.map((e) => e.text), ["Clarity data", "Testing cart/checkout"]);
  assert.ok(matchScore("checkout cart", tasks[2], wordCounts(tasks)) < 1.5);

  const text = standupUpdateText(built, handleFor);
  assert.match(text, /\*\*FBB\*\*\n@Cristobal – In progress – Family Bundle Builder V4 \+ Analysis V3 – last update: \d\d\/\d\d\n {4}↳ Today: FBB V4: match the mock/);
  assert.match(text, /\*\*Also from stand-up\*\*\n@Cristobal – Yesterday: Clarity data\n@Robson – Yesterday: Testing cart\/checkout/);
  assert.match(text, /\*\*Blockers\*\*\n@Cristobal – need admin$/);
  assert.doesNotMatch(standupUpdateText(built, handleFor, new Set(["fbb", "blocker:0"])), /Family Bundle|need admin/);
});

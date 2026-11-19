// The workshop agenda: one item per rock × tactic plus rock updates, ranked by priority and
// activity over two weekly sprints, with quiet items grayed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgenda, sprintWindowStart, agendaText } from "../public/workshop.js";

const now = new Date(2026, 10, 19, 10); // Thursday, local
const since = sprintWindowStart(now);
const day = (d) => new Date(2026, 10, d, 12).getTime();

test("the window starts Monday of last week", () => {
  assert.equal(new Date(since).toDateString(), new Date(2026, 10, 9).toDateString());
});

test("live items ranked by workshop priority, trouble and activity; quiet ones grayed with why; rock updates for untactic'd work", () => {
  const rocks = [
    { id: "R1", title: "Bundles", status: "on_track", owner: { name: "Alex Turney" }, tactics: [
      { id: "T1", title: "Family Builder", kind: "Workshop Priority", status: "on_track" },
      { id: "T2", title: "All-in-1", kind: "Workshop Priority", status: "overdue" },
      { id: "T3", title: "Old idea", kind: "Other", status: "on_track" },
    ] },
    { id: "R2", title: "Subs", status: "on_track", tactics: [] },
  ];
  const tasks = [
    { id: "a", name: "Builder live", status: "done (this sprint)", place: ["R1", "T1"], assignees: [{ username: "Akansha Rao" }] },
    { id: "b", name: "Builder v2", status: "in progress", bucket: "active", dateUpdated: day(18), place: ["R1", "T1"] },
    { id: "c", name: "All-in-1 page", status: "to do", bucket: "todo", dateUpdated: day(1), place: ["R1", "T2"] },
    { id: "d", name: "Subs gift", status: "complete", bucket: "done", dateDone: day(12), place: ["R2", null] },
    { id: "e", name: "Old shipped", status: "complete", bucket: "done", dateDone: day(1), place: ["R1", "T3"] },
  ];
  const placeOf = (t) => ({ rockId: t.place[0], tacticId: t.place[1] });
  const a = buildAgenda({ rocks, courses: new Map([["R2", { course: "drift" }]]), tasks, placeOf, now });
  assert.deepEqual(a.live.map((i) => [i.key, i.reasons.join(", ")]), [
    ["R1:T1", "1 done this sprint, 1 moving"],
    ["R2:rock", "1 done last sprint"],
  ]);
  assert.deepEqual(a.live[0].show.map((s) => [s.name, s.who.join()]), [["Builder live", "Akansha"]]);
  assert.deepEqual(a.quiet.map((i) => [i.key, /^(1 open, none touched|nothing done or moving) since/.test(i.quietWhy)]), [["R1:T2", true], ["R1:T3", true]]);
  assert.equal(a.quiet[0].trouble, true, "overdue and quiet sorts first among the grayed");
  const text = agendaText(a, { include: new Set(["R1:T2"]) });
  assert.match(text, /1\. Bundles → Family Builder/);
  assert.match(text, /3\. Bundles → All-in-1/);
  assert.match(text, /Skipping: Bundles → Old idea/);
});

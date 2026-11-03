// Alex's Impact: the record only grows, and no regrouping can lose an item.

import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyLedger, harvest, itemsFromSources, placeDeterministic, placeTree, placedIds, UNSORTED } from "../src/impact/ledger.js";
import { buildsFromCommits, massageImpact, reportKeysByDay } from "../src/agents/impact.js";
import { Store } from "../src/lib/storage.js";

const task = (id, over = {}) => ({ id, name: `Ticket ${id}`, status: "complete", url: `https://app.clickup.com/t/${id}`, assignees: [{ username: "Robson Lopes" }], dateClosed: 1_761_000_000_000, ...over });
const report = (tasks, tests = [], rocks = []) => ({
  runId: "r1",
  sections: { intelligems: { present: true } },
  detail: { clickup: { tasks }, intelligems: { tests }, leadership: { queue: rocks } },
});

test("only done tickets, tests, and shipped rocks become items, each with a link", () => {
  const items = itemsFromSources({
    report: report(
      [task("a"), task("b", { status: "in-progress" }), task("c", { status: "done (this sprint)", dateClosed: null, dateUpdated: 5 }), task("d", { archived: true })],
      [{ id: "t1", name: "Bundle test", consoleUrl: "https://app.intelligems.io/experiment/t1", verdict: "not_ready", estMonthlyRevenueImpact: 1234.6 }],
      [{ id: "r1", title: "Bundles 2.0", shippedAt: "2026-10-30" }, { id: "r2", title: "Not yet", state: "active" }],
    ),
  });
  assert.deepEqual(items.map((i) => i.id), ["ticket:a", "ticket:c", "test:t1", "rock:r1"]);
  assert.ok(items.every((i) => i.url));
  assert.equal(items.find((i) => i.id === "test:t1").facts.estMonthlyRevenueImpact, 1235);
});

test("harvest adds new items, refreshes known ones, and never removes", () => {
  const ledger = emptyLedger();
  assert.deepEqual(harvest(ledger, itemsFromSources({ report: report([task("a"), task("b")]) })), ["ticket:a", "ticket:b"]);
  // Next day: a is gone from the sprint list, b renamed.
  const added = harvest(ledger, itemsFromSources({ report: report([task("b", { name: "Renamed", dateClosed: 1_762_000_000_000 })]) }));
  assert.deepEqual(added, []);
  assert.ok(ledger.items["ticket:a"], "a ticket that left the list stays in the record");
  assert.equal(ledger.items["ticket:b"].title, "Renamed");
  assert.equal(ledger.items["ticket:b"].date, new Date(1_761_000_000_000).toISOString(), "the first done date is kept");
});

test("a test that stops appearing is concluded, but only when tests were actually read", () => {
  const ledger = emptyLedger();
  harvest(ledger, itemsFromSources({ report: report([], [{ id: "t1", name: "T" }]) }), { testsCollected: true });
  harvest(ledger, [], { testsCollected: false });
  assert.equal(ledger.items["test:t1"].status, "running");
  harvest(ledger, [], { testsCollected: true });
  assert.equal(ledger.items["test:t1"].status, "concluded");
});

test("placeTree keeps every item exactly once: strays go back, invented ids are dropped", () => {
  const ledger = emptyLedger();
  harvest(ledger, itemsFromSources({ report: report([task("a"), task("b"), task("c"), task("d")]) }));
  const previous = [{ id: "old", title: "Old theme", summary: "", itemIds: ["ticket:c"], themes: [] }];
  const tree = placeTree(
    [
      { title: "Bundles", summary: "s", itemIds: ["ticket:a", "ticket:a", "ticket:zzz"], themes: [{ title: "Page", summary: "", itemIds: ["ticket:b"], themes: [{ title: "Too deep", itemIds: ["ticket:a"] }] }] },
      { title: "Empty", summary: "", itemIds: [], themes: [] },
    ],
    ledger,
    previous,
  );
  const ids = placedIds(tree);
  assert.deepEqual([...ids].sort(), ["ticket:a", "ticket:b", "ticket:c", "ticket:d"]);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(tree.map((t) => t.title), ["Bundles", "Old theme", UNSORTED]);
  assert.equal(tree[0].themes[0].themes.length, 0, "two levels at most");
});

test("plain-code placement groups by rock then Big Swing, and kinds under their own theme", () => {
  const ledger = emptyLedger();
  const added = harvest(
    ledger,
    itemsFromSources({
      report: report([task("a", { leadershipPriority: { label: "AOV" }, bigSwing: { label: "Bundles" } }), task("b")], [{ id: "t1", name: "T" }]),
    }),
  );
  const tree = placeDeterministic(ledger, added);
  assert.deepEqual(tree.map((t) => t.title).sort(), ["AOV", "Experiments", UNSORTED].sort());
  assert.equal(tree.find((t) => t.title === "AOV").themes[0].title, "Bundles");
});

test("commits group into one build item per day, merges skipped", () => {
  const builds = buildsFromCommits(
    [
      { commit: { message: "Second\n\nbody", author: { date: "2026-11-02T18:00:00Z" } } },
      { commit: { message: "First", author: { date: "2026-11-02T15:00:00Z" } } },
      { commit: { message: "Merge branch x", author: { date: "2026-11-02T16:00:00Z" } } },
      { commit: { message: "Earlier", author: { date: "2026-10-30T15:00:00Z" } } },
    ],
    { repo: "o/r", timeZone: "America/Chicago" },
  );
  assert.deepEqual(builds.map((b) => [b.dateKey, b.subjects]), [["2026-11-02", ["First", "Second"]], ["2026-10-30", ["Earlier"]]]);
  assert.match(builds[0].url, /github\.com\/o\/r\/commits\?since=2026-11-02&until=2026-11-03/);
});

test("without an Anthropic key the pass still harvests, places, and stores a dated copy", async () => {
  const store = await Store.open({ mode: "memory", config: { system: {} } });
  await store.putReport({ dateKey: "2026-11-02", mode: "official", runId: "r1", ...report([task("a")]) });
  const config = { system: { timezone: "America/Chicago" }, people: {} };
  const { ledger, run } = await massageImpact({ store, config, env: {}, now: new Date("2026-11-02T15:00:00Z") });
  assert.equal(run.added, 1);
  assert.match(run.error, /ANTHROPIC_API_KEY/);
  assert.deepEqual(placedIds(ledger.themes), ["ticket:a"]);
  assert.ok(await store.backend.get("impact/history/2026-11-02.json"));
});

test("report keys: one per day, the last of the day, oldest first; pointers skipped", () => {
  const keys = [
    "reports/2026-10-02-refresh-run_b.json",
    "reports/latest.json",
    "reports/2026-10-01-official-run_a.json",
    "reports/2026-10-02-official-run_a.json",
    "reports/sent/2026-10-01.json",
    "reports/latest-official.json",
  ];
  assert.deepEqual(reportKeysByDay(keys), ["reports/2026-10-01-official-run_a.json", "reports/2026-10-02-refresh-run_b.json"]);
});

test("the first pass backfills from every stored report, once, and concludes tests that ended", async () => {
  const store = await Store.open({ mode: "memory", config: { system: {} } });
  const config = { system: { timezone: "America/Chicago" }, people: {} };
  await store.putReport({ dateKey: "2026-10-01", mode: "official", runId: "a", generatedAt: "2026-10-01T13:00:00Z", ...report([task("old")], [{ id: "t1", name: "Ended test" }]) });
  await store.putReport({ dateKey: "2026-10-15", mode: "official", runId: "b", generatedAt: "2026-10-15T13:00:00Z", ...report([task("mid")]) });
  await store.putReport({ dateKey: "2026-11-02", mode: "official", runId: "c", generatedAt: "2026-11-02T13:00:00Z", ...report([task("new")]) });

  const first = await massageImpact({ store, config, env: {}, now: new Date("2026-11-02T15:00:00Z") });
  assert.deepEqual(Object.keys(first.ledger.items).sort(), ["test:t1", "ticket:mid", "ticket:new", "ticket:old"]);
  assert.equal(first.run.backfilled, 4);
  assert.equal(first.ledger.items["ticket:old"].firstSeen, "2026-10-01T13:00:00.000Z");
  assert.equal(first.ledger.items["test:t1"].status, "concluded");
  assert.ok(first.ledger.backfilledAt);

  const second = await massageImpact({ store, config, env: {}, now: new Date("2026-11-03T15:00:00Z") });
  assert.equal(second.run.backfilled, undefined, "backfill runs once");
  assert.equal(Object.keys(second.ledger.items).length, 4);
});

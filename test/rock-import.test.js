// The standup paste. What matters: a rename on the standup lands as a rename here rather
// than a duplicate, a weak match never steals a rock from a strong one, nothing is
// removed, and an existing ClickUp link is never overwritten by a bulk paste.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStandupRocks, planRockImport, suggestOption, titleSimilarity } from "../src/store/rock-import.js";
import { RocksStore, RockValidationError } from "../src/store/rocks.js";
import { Store } from "../src/lib/storage.js";
import { testConfig } from "./fixtures/config.js";

async function freshStore() {
  const backing = await Store.open({ config: testConfig(), mode: "memory" });
  return new RocksStore(backing.backend, null);
}

test("one title per line, with bullets and numbering stripped and repeats dropped", () => {
  const parsed = parseStandupRocks("- Grow subscriptions\n2. Launch teen multi\n\n• grow subscriptions\n");
  assert.equal(parsed.format, "lines");
  assert.deepEqual(parsed.rocks.map((r) => r.title), ["Grow subscriptions", "Launch teen multi"]);
});

test("the get-rocks JSON keeps the standup id, team and quarter, and drops business as usual", () => {
  const parsed = parseStandupRocks(JSON.stringify({
    rocks: [
      { id: "r1", title: "Grow subscriptions", owner: "Retention", quarter: "2026-Q4" },
      { id: "bau", title: "Business as usual", owner: "Retention", isBau: true },
    ],
  }));
  assert.equal(parsed.format, "json");
  assert.deepEqual(parsed.rocks, [{ title: "Grow subscriptions", standupId: "r1", team: "Retention", quarter: "2026-Q4" }]);
  assert.equal(parsed.skipped[0].reason, "business as usual");
});

test("JSON with no rocks list says so rather than importing nothing quietly", () => {
  assert.throws(() => parseStandupRocks('{"hello":1}'), /no rocks list/);
});

test("titles compare on their meaningful words, not case or punctuation", () => {
  assert.equal(titleSimilarity("Launch the Teen Multi!", "launch teen multi"), 1);
  assert.equal(titleSimilarity("Launch teen multi", "Fix checkout"), 0);
});

test("a rename on the standup follows the stored standup id, whatever the words", () => {
  const plan = planRockImport({
    pasted: [{ title: "Totally new wording", standupId: "r1" }],
    rocks: [{ id: "old", title: "Grow subscriptions", standupRockId: "r1", state: "active" }],
  });
  assert.equal(plan.items[0].action, "rename");
  assert.equal(plan.items[0].rockId, "old");
  assert.equal(plan.items[0].matchedBy, "standup id");
});

test("an exact title beats a similar one for the same rock", () => {
  const plan = planRockImport({
    pasted: [{ title: "Grow subscriptions in Q4" }, { title: "Grow subscriptions" }],
    rocks: [{ id: "a", title: "Grow subscriptions", state: "active" }],
  });
  assert.equal(plan.items[1].rockId, "a");
  assert.equal(plan.items[1].action, "unchanged");
  assert.equal(plan.items[0].action, "create", "the weaker match does not get the rock too");
});

test("a reworded title is offered as a rename when it is close enough, and a new rock when not", () => {
  const plan = planRockImport({
    pasted: [{ title: "Grow subscription opt-in" }, { title: "Fix the checkout" }],
    rocks: [{ id: "a", title: "Subscription opt-in growth", state: "active" }],
  });
  assert.equal(plan.items[0].action, "rename");
  assert.equal(plan.items[0].matchedBy, "similar title");
  assert.equal(plan.items[1].action, "create");
});

test("rocks missing from the paste are reported, not removed", () => {
  const plan = planRockImport({
    pasted: [{ title: "Grow subscriptions" }],
    rocks: [
      { id: "a", title: "Grow subscriptions", state: "active" },
      { id: "b", title: "Old rock", state: "backlog" },
      { id: "c", title: "Done rock", state: "shipped" },
    ],
  });
  assert.deepEqual(plan.notInPaste.map((r) => r.id), ["b"], "shipped rocks are expected to drop off the standup");
});

test("only the latest quarter is ticked by default", () => {
  const plan = planRockImport({
    pasted: [{ title: "Old", quarter: "2026-Q3" }, { title: "New", quarter: "2026-Q4" }],
    rocks: [],
  });
  assert.deepEqual(plan.items.map((i) => i.include), [false, true]);
});

test("a ClickUp option is suggested by name only where the rock has no link yet", () => {
  const options = [{ id: "o1", label: "Grow Subscriptions" }, { id: "o2", label: "Teen Multi Launch" }];
  assert.deepEqual(suggestOption("grow subscriptions", options), { id: "o1", label: "Grow Subscriptions", match: "exact" });
  assert.equal(suggestOption("Launch teen multi", options).id, "o2");
  assert.equal(suggestOption("Fix checkout", options), null);

  const plan = planRockImport({
    pasted: [{ title: "Grow subscriptions" }],
    rocks: [{ id: "a", title: "Grow subs", clickupOptionId: "kept", state: "active" }],
    rockReferenceOptions: options,
  });
  assert.equal(plan.items[0].suggestedRockReference, null, "an existing link is left alone");
});

test("applying renames in place, creates the rest, and writes once", async () => {
  const rocks = await freshStore();
  await rocks.upsert({ title: "Grow subs", clickupOptionId: "kept", owner: "123" });
  const before = await rocks.list();

  const result = await rocks.importFromStandup([
    { rockId: "grow-subs", title: "Grow subscriptions", standupRockId: "r1", clickupOptionId: "ignored-if-blank-only" },
    { rockId: null, title: "Launch teen multi", standupRockId: "r2", clickupBigSwingOptionId: "s1" },
  ], { expectedVersion: before.version });

  assert.equal(result.version, before.version + 1, "one write, one version");
  assert.equal(result.renamed, 1);
  assert.equal(result.created, 1);

  const after = await rocks.list();
  const renamed = after.rocks.find((r) => r.id === "grow-subs");
  assert.equal(renamed.title, "Grow subscriptions");
  assert.equal(renamed.standupRockId, "r1");
  assert.equal(renamed.owner, "123", "fields the paste does not carry are kept");
  const created = after.rocks.find((r) => r.standupRockId === "r2");
  assert.equal(created.state, "active");
  assert.equal(created.clickupBigSwingOptionId, "s1");

  const [audit] = await rocks.auditTrail({ limit: 1 });
  assert.match(audit.reason, /1 renamed, 1 created/);
});

test("an import against a stale version is rejected", async () => {
  const rocks = await freshStore();
  await rocks.upsert({ title: "A" });
  await assert.rejects(rocks.importFromStandup([{ rockId: null, title: "B" }], { expectedVersion: 0 }), RockValidationError);
});

test("two pasted rocks matched to the same rock are refused rather than one silently winning", async () => {
  const rocks = await freshStore();
  await rocks.upsert({ title: "A" });
  await assert.rejects(
    rocks.importFromStandup([{ rockId: "a", title: "A one" }, { rockId: "a", title: "A two" }]),
    /both matched/,
  );
});

test("a new rock whose name collides with an existing id gets a suffix, not an error", async () => {
  const rocks = await freshStore();
  await rocks.upsert({ title: "Grow subs" });
  await rocks.importFromStandup([{ rockId: null, title: "Grow subs" }]);
  const ids = (await rocks.list()).rocks.map((r) => r.id).sort();
  assert.deepEqual(ids, ["grow-subs", "grow-subs-2"]);
});

// Shaped like the standup's Submit update page: the same rock dropdown appears once per
// tactic, with the page's own team in "<Team>'s rocks" and everyone else after it.
const STANDUP_PAGE = `<html lang="en"><head><title>Marketing Standup</title></head><body>
  <span class="rock-title">Bundles 3.0</span>
  ${[1, 2].map(() => `<select data-rock="" aria-label="Rock this priority ladders up to"><option value="">— choose a rock —</option>
    <optgroup label="Web's rocks"><option value="w1">Bundles 3.0 · 2026-Q4</option><option value="w2" selected="">Grow Subs &amp; Payback · 2026-Q4</option><option value="w3">Business as Usual (BAU) · 2026-Q4</option></optgroup>
    <option value="bau-web">Business as usual (Web)</option>
    <optgroup label="Other teams' rocks"><option value="o1">LAUNCH: Ship it · in Nov/Dec · Brand &amp; Trade Marketing</option><option value="o2">Sign 2 retail partners · Retail</option></optgroup></select>`).join("")}
</body></html>`;

test("the standup page's HTML is read from its rock dropdown, with ids, teams and quarters", () => {
  const parsed = parseStandupRocks(STANDUP_PAGE);
  assert.equal(parsed.format, "html");
  assert.equal(parsed.ownTeam, "Web");
  assert.deepEqual(parsed.rocks, [
    { title: "Bundles 3.0", standupId: "w1", team: "Web", quarter: "2026-Q4" },
    { title: "Grow Subs & Payback", standupId: "w2", team: "Web", quarter: "2026-Q4" },
    { title: "LAUNCH: Ship it · in Nov/Dec", standupId: "o1", team: "Brand & Trade Marketing", quarter: null },
    { title: "Sign 2 retail partners", standupId: "o2", team: "Retail", quarter: null },
  ], "repeated dropdowns collapse to one list, and both kinds of business as usual are dropped");
});

test("an HTML page with no rock dropdown says where to copy it from", () => {
  assert.throws(() => parseStandupRocks("<html><body>nothing</body></html>"), /Submit update screen/);
});

test("from a whole-company page, other teams' new rocks start unticked but their matches do not", () => {
  const parsed = parseStandupRocks(STANDUP_PAGE);
  const plan = planRockImport({
    pasted: parsed.rocks,
    ownTeam: parsed.ownTeam,
    rocks: [{ id: "retail", title: "Sign 2 retail partners", state: "active" }],
  });
  const byTitle = Object.fromEntries(plan.items.map((i) => [i.title, i.include]));
  assert.equal(byTitle["Bundles 3.0"], true, "own team's new rock");
  assert.equal(byTitle["LAUNCH: Ship it · in Nov/Dec"], false, "another team's new rock");
  assert.equal(byTitle["Sign 2 retail partners"], true, "another team's rock already here");
});

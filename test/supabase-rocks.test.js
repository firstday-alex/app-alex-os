// Rocks from Supabase: read only, always; shaped into the queue the Layer 1 rules read;
// the old dashboard rocks' links carried over by title; and a rock reached through any
// Big Swing on it or its tactics.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fetchSupabaseRocks, rocksFromSupabase, quarterOf, quarterMonths, select } from "../src/collectors/supabase-rocks.js";
import { collectLeadership, ownsSwing, swingIdsOf } from "../src/collectors/leadership.js";
import { leadershipChecks } from "../src/delta/leadership-checks.js";
import { RockLinksStore, planSeed } from "../src/store/rock-links.js";
import { Store } from "../src/lib/storage.js";
import { testConfig } from "./fixtures/config.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const NOW = new Date("2026-10-28T15:00:00Z");
const memoryBackend = async () => (await Store.open({ config: testConfig(), mode: "memory" })).backend;

function config() {
  const c = testConfig();
  c.system.supabase = { url: "https://example.supabase.co", team: "Web" };
  c.people = {
    alex: { name: "Alex Turney", clickupUserId: "100" },
    team: [
      { name: "Robson Lopes", clickupUserId: "1" },
      { name: "Cristobal Alanis", clickupUserId: "3" },
    ],
  };
  return c;
}
const env = { SUPABASE_SERVICE_KEY: "eyJtest" };

const TABLES = {
  sub_functions: [{ id: "web", name: "Web", owners: "Blake & Alex" }],
  rocks: [
    { id: "r-bundles", title: "Upsells / Bundles 2.0", quarter: "2026-Q4", definition_of_done: "Double down on bundles", is_bau: false },
    { id: "r-funnels", title: "Unlock 2 New Offer Funnels ", quarter: "2026-Q4", definition_of_done: "2 New Successful Funnels", is_bau: false },
    { id: "r-bau", title: "Business as usual", quarter: "2026-Q4", definition_of_done: null, is_bau: true },
    { id: "r-old", title: "Last quarter", quarter: "2026-Q3", definition_of_done: "x", is_bau: false },
  ],
  rock_latest_status: [
    { rock_id: "r-bundles", entry_date: "2026-10-28", status: "green", reason: "", action_plan: "" },
    { rock_id: "r-funnels", entry_date: "2026-10-20", status: "amber", reason: "Quiz slipped", action_plan: "Ship V2 Friday" },
  ],
  rock_milestones: [
    { id: "m1", rock_id: "r-funnels", month: "2026-10-01", deliverable: "1 Step Quiz Bundle Builder V2", done_at: null, blocker: "" },
    { id: "m2", rock_id: "r-funnels", month: "2026-11-01", deliverable: "Build out offer funnels", done_at: null, blocker: null },
  ],
  priorities_effective: [
    { id: "t-quiz", kind: "Workshop Priority", title: "Lead Quiz", effective_status: "on_track", checkin_date: "2026-10-30", rock_sub_tasks: { rock_id: "r-funnels", sort_order: 1 } },
    { id: "t-fbb", kind: "Other", title: "Family Bundle Builder", effective_status: "on_track", rock_sub_tasks: { rock_id: "r-funnels", sort_order: 0 } },
    { id: "t-aio", kind: "Other", title: "All-in-1 Bundle", effective_status: "on_track", rock_sub_tasks: { rock_id: "r-bundles", sort_order: 0 } },
    { id: "t-done", kind: "Other", title: "Old funnel", effective_status: "done", rock_sub_tasks: { rock_id: "r-bundles", sort_order: 1 } },
    { id: "t-app", kind: "Other", title: "📱 Mobile App", effective_status: "on_track", rock_sub_tasks: { rock_id: "r-bau", sort_order: 0 } },
    { id: "t-loose", kind: "Other", title: "Not under a rock", effective_status: "done", rock_sub_tasks: null },
  ],
};

/** A PostgREST stand-in that records every request, and answers from TABLES. */
function fakeSupabase() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers ?? {} });
    const u = new URL(url);
    const table = u.pathname.split("/").pop();
    let rows = TABLES[table] ?? [];
    if (table === "rocks") rows = rows.filter((r) => r.quarter); // quarter filtering is the collector's job
    return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

test("every request to Supabase is a GET, with the key in the headers and not the URL", async () => {
  const { calls, fetchImpl } = fakeSupabase();
  await fetchSupabaseRocks({ config: config(), env, fetchImpl, now: NOW });
  assert.ok(calls.length >= 5);
  for (const c of calls) {
    assert.equal(c.method, "GET", c.url);
    assert.ok(c.url.startsWith("https://example.supabase.co/rest/v1/"), c.url);
    assert.ok(!c.url.includes("/rpc/"), c.url);
    assert.ok(!c.url.includes("eyJtest"), "the key must not be in the URL");
    assert.equal(c.headers.apikey, "eyJtest");
  }
});

test("no code can write to Supabase: only the read-only collector talks to it, and only with GET", () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m?js)$/.test(e.name)) files.push(p);
    }
  };
  for (const d of ["src", "netlify", "public", "scripts"]) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));

  const talkers = files.filter((f) => /rest\/v1|SUPABASE_SERVICE_KEY|@supabase\//.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(
    talkers.map((f) => path.relative(ROOT, f)),
    ["src/collectors/supabase-rocks.js"],
    "Only src/collectors/supabase-rocks.js may reach Supabase.",
  );

  const code = fs.readFileSync(talkers[0], "utf8").replace(/\/\/.*$/gm, "");
  assert.match(code, /const READ_METHOD = "GET";/);
  assert.equal((code.match(/method:/g) ?? []).length, 1, "one request site, using READ_METHOD");
  assert.match(code, /method: READ_METHOD/);
  for (const verb of ["POST", "PATCH", "PUT", "DELETE", "/rpc/", "Prefer"]) assert.ok(!code.includes(verb), `found ${verb}`);
});

test("without a key or a project nothing is requested", async () => {
  const { calls, fetchImpl } = fakeSupabase();
  await assert.rejects(select("rocks", "select=id", { config: config(), env: {}, fetchImpl }), /SUPABASE_SERVICE_KEY/);
  const c = config();
  delete c.system.supabase.url;
  await assert.rejects(select("rocks", "select=id", { config: c, env, fetchImpl }), /system.supabase.url/);
  assert.equal(calls.length, 0);
});

test("quarters", () => {
  assert.equal(quarterOf(NOW, "America/Chicago"), "2026-Q4");
  assert.equal(quarterOf(new Date("2027-01-01T03:00:00Z"), "America/Chicago"), "2026-Q4");
  assert.deepEqual(quarterMonths("2026-Q4"), { first: "2026-10", last: "2026-12" });
});

test("this quarter's rocks, each with its status, milestones and tactics in order", async () => {
  const { fetchImpl } = fakeSupabase();
  const source = await fetchSupabaseRocks({ config: config(), env, fetchImpl, now: NOW });
  assert.equal(source.quarter, "2026-Q4");
  assert.deepEqual(source.rocks.map((r) => r.id), ["r-bundles", "r-funnels", "r-bau"]);
  const funnels = source.rocks[1];
  assert.equal(funnels.title, "Unlock 2 New Offer Funnels");
  assert.equal(funnels.latestStatus.color, "amber");
  assert.deepEqual(funnels.tactics.map((t) => t.title), ["Family Bundle Builder", "Lead Quiz"]);
  assert.deepEqual(funnels.milestones.map((m) => m.month), ["2026-10", "2026-11"]);
  assert.equal(funnels.milestones[0].blocker, null);
});

test("shaped as queue items, with this app's owner and Big Swing links laid over", async () => {
  const { fetchImpl } = fakeSupabase();
  const c = config();
  const source = await fetchSupabaseRocks({ config: c, env, fetchImpl, now: NOW });
  const links = {
    "r-funnels": { owner: "3" },
    "t-quiz": { owner: "1", clickupBigSwingOptionId: "opt-quiz" },
    "t-fbb": { clickupBigSwingOptionId: "opt-fbb" },
    "t-done": { clickupBigSwingOptionId: "opt-old" },
  };
  const [bundles, funnels, bau] = rocksFromSupabase(source, links, c.people);
  assert.equal(funnels.status, "at_risk");
  assert.equal(funnels.statusReason, "Quiz slipped");
  assert.equal(funnels.owner.name, "Cristobal Alanis");
  assert.equal(funnels.kpi, "2 New Successful Funnels");
  assert.equal(funnels.targetMonth, "2026-12");
  assert.equal(funnels.checkInDate, "2026-10-20");
  assert.deepEqual(funnels.clickupBigSwingOptionIds.sort(), ["opt-fbb", "opt-quiz"]);
  assert.equal(funnels.tactics.find((t) => t.id === "t-quiz").owner.name, "Robson Lopes");
  assert.ok(ownsSwing(funnels, "opt-quiz") && !ownsSwing(funnels, "opt-aio"));
  // A done tactic's Big Swing no longer claims tickets for the rock.
  assert.deepEqual(swingIdsOf(bundles), []);
  assert.equal(bau.bau, true);
});

test("the rules: an amber rock is at risk, BAU is passed by, and a tactic's Big Swing counts as the rock's link", async () => {
  const { fetchImpl } = fakeSupabase();
  const c = config();
  const source = await fetchSupabaseRocks({ config: c, env, fetchImpl, now: NOW });
  const queue = rocksFromSupabase(source, { "r-funnels": { owner: "3" }, "t-quiz": { clickupBigSwingOptionId: "opt-quiz" } }, c.people);
  const { flags } = leadershipChecks({
    leadership: { queue, backlog: [], roster: [], bigSwingOptions: [{ id: "opt-quiz", label: "Quiz" }] },
    clickup: null,
    config: c,
    dateKey: "2026-10-28",
    nowIso: NOW.toISOString(),
  });
  const about = (id) => flags.filter((f) => f.subject.id.startsWith(id)).map((f) => f.rule).sort();
  assert.deepEqual(about("r-funnels"), ["leadership.check_in_overdue", "leadership.rock_at_risk"]);
  assert.deepEqual(about("r-bundles"), ["leadership.rock_not_linked", "leadership.unassigned"]);
  assert.deepEqual(about("r-bau"), []);
});

test("the old dashboard rocks' links carry over to the rock or tactic they name, closest first", () => {
  const source = {
    rocks: [
      { id: "r-bundles", title: "Upsells / Bundles 2.0", tactics: [{ id: "t-aio", title: "All-in-1 Bundle", status: "on_track" }] },
      { id: "r-funnels", title: "Unlock 2 New Offer Funnels", tactics: [{ id: "t-quiz", title: "Lead Quiz", status: "on_track" }] },
    ],
  };
  const old = [
    { id: "a", title: "Bundles / Upsells 2.0", owner: "3", clickupBigSwingOptionId: "opt-b" },
    { id: "b", title: "Quiz", owner: "1", clickupBigSwingOptionId: "opt-q", experimentLinks: [{ url: "https://app.intelligems.io/x/0b5c2a2e-5a6f-4a8e-9d55-1d6a3c5e7f10" }] },
    { id: "c", title: "AB Testing", clickupBigSwingOptionId: "opt-ab" },
  ];
  const seed = planSeed(old, source);
  assert.equal(seed.links["r-bundles"].clickupBigSwingOptionId, "opt-b");
  assert.equal(seed.links["t-quiz"].owner, "1");
  assert.equal(seed.links["t-quiz"].experimentLinks[0].experienceId, "0b5c2a2e-5a6f-4a8e-9d55-1d6a3c5e7f10");
  assert.deepEqual(seed.unmatched, [{ title: "AB Testing", clickupBigSwingOptionId: "opt-ab" }]);
});

test("the links store: seeds once, then only changes what it is told, with a version check", async () => {
  const backend = await memoryBackend();
  const store = new RockLinksStore(backend);
  const source = { rocks: [{ id: "r1", title: "Lead Quiz", tactics: [] }] };
  const first = await store.list({ oldRocks: [{ id: "q", title: "Lead Quiz", owner: "1", clickupBigSwingOptionId: "opt-q" }], source });
  assert.equal(first.version, 1);
  assert.equal(first.links.r1.owner, "1");
  // Already seeded: a second list does not reseed.
  const again = await store.list({ oldRocks: [{ id: "q", title: "Lead Quiz", owner: "9" }], source });
  assert.equal(again.links.r1.owner, "1");

  const after = await store.set("r1", { clickupBigSwingOptionId: "opt-new" }, { expectedVersion: 1, title: "Lead Quiz" });
  assert.equal(after.links.r1.owner, "1");
  assert.equal(after.links.r1.clickupBigSwingOptionId, "opt-new");
  await assert.rejects(store.set("r1", { owner: "3" }, { expectedVersion: 1 }), /changed since you loaded them/);
});

test("Layer 1 reads Supabase when configured, and falls back to the last good read when it cannot", async () => {
  const backend = await memoryBackend();
  const c = config();
  const { fetchImpl } = fakeSupabase();
  const live = await collectLeadership({ config: c, env, fetchImpl, rockLinksStore: new RockLinksStore(backend), now: NOW });
  assert.equal(live.meta.source, "supabase");
  assert.equal(live.queue.length, 3);

  const down = async () => new Response("unavailable", { status: 503 });
  const c2 = config();
  c2.system.http = { timeoutMs: 1000, maxAttempts: 1, backoffMsSchedule: [0] };
  const cached = await collectLeadership({ config: c2, env, fetchImpl: down, rockLinksStore: new RockLinksStore(backend), now: NOW });
  assert.equal(cached.meta.source, "supabase-cached");
  assert.equal(cached.queue.length, 3);
  assert.match(cached.meta.supabase.stale.reason, /./);
});

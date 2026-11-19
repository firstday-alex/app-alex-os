// Daily wins: code picks the wins, only real wins and names come out, and any
// figure the model could not have got from the data is caught. The storytelling itself is
// not tested here; whether its numbers are real is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanWins, winCandidates, numbersIn, recentlyShipped, speechText, storeForSpeech, ticketForSpeech, unverifiedNumbers } from "../src/agents/daily-speech.js";

const now = new Date("2026-11-19T14:00:00Z");
const tasks = [
  { id: "a1", name: "Gridwall V2 live", status: "done (this sprint)", assignees: [{ username: "Cristobal Ruiz" }], bigSwing: { label: "Bundles" }, url: "https://app.clickup.com/t/a1", dateDone: Date.UTC(2026, 10, 18) },
  { id: "b2", name: "BYOB gridwall QA", status: "ready for deploy", assignees: [{ username: "Akansha Rao" }, { username: "Cristobal Ruiz" }] },
  { id: "c3", name: "Still building", status: "in progress", assignees: [{ username: "Blake Tucker" }] },
  { id: "d4", name: "Called out yesterday", status: "done", assignees: [{ username: "Blake Tucker" }] },
];

test("code picks the wins: done or ready-to-ship tickets and live changes; called-out ones left off; unticked old ones carried", () => {
  const previous = [{ key: "task:z9", title: "Moved on since", stage: "done", who: ["Robson Lopes"], firstSeen: "2026-11-17T13:00:00Z", why: "old" }, { key: "task:old", title: "Too old", who: [], firstSeen: "2026-10-01T13:00:00Z" }];
  const c = winCandidates({ tasks, production: [{ date: "2026-11-18", change: "Gridwall V2 promoted", result: "Won + Promoted" }], celebrated: { "task:d4": { at: "x" } }, previous, now });
  assert.deepEqual(c.map((w) => [w.key.split(":")[0], w.title, w.stage]), [
    ["task", "Gridwall V2 live", "done"],
    ["task", "BYOB gridwall QA", "ready to ship"],
    ["change", "Gridwall V2 promoted", "live: Won + Promoted"],
    ["task", "Moved on since", "done"],
  ]);
  assert.equal(c[3].carried, true);
  assert.equal(c[3].why, undefined, "a carried win is ranked afresh");
});

test("the ranked list keeps only wins code gave, code's titles, kudos only for that win's people, and adds back skipped ones", () => {
  const c = winCandidates({ tasks, now });
  const parsed = {
    headline: " Gridwall is live ",
    close: "Keep going.",
    facts: [{ claim: "x", source: "y" }, { claim: "no source" }],
    wins: [
      { key: "task:b2", why: "Unblocks the bundle test.", kudos: [{ name: "Akansha", for: "QA on the BYOB gridwall" }, { name: "Drew", for: "made up" }, { name: "Akansha Rao", for: "twice" }] },
      { key: "task:nope", why: "invented", kudos: [] },
      { key: "task:b2", why: "dupe", kudos: [] },
    ],
  };
  const out = cleanWins(parsed, c, [{ key: "task:a1", firstSeen: "2026-11-18T13:00:00Z" }], now);
  assert.equal(out.headline, "Gridwall is live");
  assert.deepEqual(out.wins.map((w) => [w.rank, w.key, w.title]), [[1, "task:b2", "BYOB gridwall QA"], [2, "task:a1", "Gridwall V2 live"], [3, "task:d4", "Called out yesterday"]]);
  assert.deepEqual(out.wins[0].kudos, [{ name: "Akansha Rao", for: "QA on the BYOB gridwall" }]);
  assert.equal(out.wins[1].firstSeen, "2026-11-18T13:00:00Z", "first listed day is kept");
  assert.equal(out.wins[0].firstSeen, now.toISOString());
  assert.equal(out.facts.length, 1);
  assert.equal(cleanWins({ headline: "", wins: [] }, c, [], now), null);
});

test("numbers are found as written", () => {
  assert.deepEqual(numbersIn("Up 12% to $4,213.55 on 300 orders"), ["12%", "$4,213.55", "300"]);
});

test("a figure rounded the way a person says it is verified; an invented one is flagged", () => {
  const context = JSON.stringify({ tiles: [{ label: "Net sales", value: 4213.55, vs: [{ changePct: 11.8 }] }], conv: 0.0234, orders: 312 });
  assert.deepEqual(unverifiedNumbers("Net sales $4,200, up 12%, on 312 orders", context), []);
  assert.deepEqual(unverifiedNumbers("Conversion at 2.3%", context), [], "a fraction in the data matches a percent in the speech");
  assert.deepEqual(unverifiedNumbers("Up 40% with 900 orders", context), ["40%", "900"]);
});

test("small counts are not looked up, but small money and percents are", () => {
  assert.deepEqual(unverifiedNumbers("three tests, 3 people", "{}"), []);
  assert.deepEqual(unverifiedNumbers("up 3%, $5 per order", "{}"), ["3%", "$5"]);
});

test("shipped this week comes from the Impact record, newest first, without MOS build days", () => {
  const now = new Date("2026-11-06T14:00:00Z");
  const ledger = {
    items: {
      a: { kind: "ticket", title: "Old", date: "2026-10-20T00:00:00Z", who: ["Robson Lopes"] },
      b: { kind: "ticket", title: "Bundle page", date: "2026-11-04T00:00:00Z", who: ["Robson Lopes"], bigSwing: "Bundles" },
      c: { kind: "build", title: "Management OS: 3 changes", date: "2026-11-05T00:00:00Z" },
      d: { kind: "test", title: "Nav test", date: "2026-11-05T00:00:00Z", status: "concluded" },
    },
  };
  const out = recentlyShipped(ledger, now);
  assert.deepEqual(out.map((i) => i.title), ["Nav test", "Bundle page"]);
  assert.deepEqual(out[1].who, ["Robson"]);
  assert.equal(out[1].rock, "Bundles");
  assert.deepEqual(recentlyShipped(null, now), []);
});

test("store tiles keep only what is available, with their comparisons", () => {
  const s = storeForSpeech({
    primaryWindow: { label: "Yesterday" },
    tiles: [
      { label: "Conversion", available: true, format: "percent", value: 0.0234, comparisons: [{ label: "Last week", changePct: 4.1 }, { label: "LY", changePct: null }] },
      { label: "AOV", available: false },
    ],
  });
  assert.equal(s.tiles.length, 1);
  assert.equal(s.tiles[0].value, "2.34%");
  assert.deepEqual(s.tiles[0].vs, [{ window: "Last week", changePct: 4.1 }]);
  assert.equal(storeForSpeech(null), null);
});

test("a sprint ticket is reduced to what, who and where it stands", () => {
  const t = ticketForSpeech({ name: "Fix cart", status: "qa", assignees: [{ username: "Blake Tucker" }], taskOwners: [{ username: "Robson Lopes" }], bigSwing: { label: "Checkout" }, dueDate: Date.UTC(2026, 10, 7) });
  assert.deepEqual(t, { name: "Fix cart", status: "qa", who: ["Blake"], bigSwing: "Checkout", signal: null, due: "2026-11-07", closed: null });
});

/* ------------------------------ morning speech ------------------------------ */

test("the morning speech is written once per readout, never over one already there, and never throws", async () => {
  const { morningSpeech, SPEECH_KEY, SPEECH_STATUS_KEY } = await import("../src/agents/daily-speech.js");
  const { createBackend } = await import("../src/lib/storage.js");
  const backend = await createBackend({ mode: "memory" });
  const store = { backend };
  const config = { system: {} };
  const env = { ANTHROPIC_API_KEY: "k" };
  const report = { dateKey: "2026-11-16" };
  const calls = [];
  const write = async (args) => {
    calls.push(args.trigger);
    const stored = { dateKey: "2026-11-16", generatedAt: "2026-11-16T14:02:00Z", trigger: args.trigger, unverified: [] };
    await backend.set(SPEECH_KEY, stored);
    return stored;
  };

  assert.deepEqual(await morningSpeech({ store, config, env, report, write }), { written: true });
  assert.deepEqual(calls, ["morning"]);
  assert.equal((await backend.get(SPEECH_STATUS_KEY)).state, "done");

  // A retry, or Alex pressed the button first: today's speech stands.
  assert.equal((await morningSpeech({ store, config, env, report, write })).reason, "already written for this readout");
  assert.equal(calls.length, 1);

  // Off by config, and with no key, nothing is called.
  assert.equal((await morningSpeech({ store, config: { system: { dailySpeech: { writeAfterReadout: false } } }, env, report: { dateKey: "2026-11-17" }, write })).reason, "turned off");
  assert.equal((await morningSpeech({ store, config, env: {}, report: { dateKey: "2026-11-17" }, write })).reason, "no ANTHROPIC_API_KEY");

  // A failure is recorded for the tab and returned, not thrown.
  const failing = await morningSpeech({ store, config, env, report: { dateKey: "2026-11-17" }, write: async () => ({ error: "The model declined to answer." }) });
  assert.equal(failing.error, "The model declined to answer.");
  assert.equal((await backend.get(SPEECH_STATUS_KEY)).state, "failed");
  const crashed = await morningSpeech({ store, config, env, report: { dateKey: "2026-11-17" }, write: async () => { throw new Error("boom"); } });
  assert.equal(crashed.error, "boom");
});

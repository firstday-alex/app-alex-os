// Daily Speech: the right context goes in, only a well-formed speech comes out, and any
// figure the model could not have got from the data is caught. The storytelling itself is
// not tested here; whether its numbers are real is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanSpeech, numbersIn, recentlyShipped, speechText, storeForSpeech, ticketForSpeech, unverifiedNumbers } from "../src/agents/daily-speech.js";

const beats = [
  { label: "The win", text: "Robson got the bundle page live." },
  { label: "The stakes", text: "Net sales are up 12% on last week." },
  { label: "Today", text: "Blake takes checkout QA." },
];

test("a speech needs a headline and all three beats, put back in order", () => {
  assert.equal(cleanSpeech({ headline: "", beats, close: "", facts: [] }), null);
  assert.equal(cleanSpeech({ headline: "H", beats: beats.slice(0, 2), close: "", facts: [] }), null);
  const s = cleanSpeech({ headline: " Bundles are live ", beats: [beats[2], beats[0], beats[1]], close: "Go.", facts: [{ claim: "12%", source: "store" }, { claim: "x" }] });
  assert.deepEqual(s.beats.map((b) => b.label), ["The win", "The stakes", "Today"]);
  assert.equal(s.headline, "Bundles are live");
  assert.equal(s.facts.length, 1, "a fact with no source is dropped");
  assert.equal(speechText(s), "Bundles are live\n\nRobson got the bundle page live.\nNet sales are up 12% on last week.\nBlake takes checkout QA.\n\nGo.");
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

test("the XF beat is optional, and slots in after the win when present", () => {
  const xf = { label: "Across the business", text: "In #marketing, Sam asked about the holiday offer." };
  const s = cleanSpeech({ headline: "H", beats: [...beats, xf], close: "", facts: [] });
  assert.deepEqual(s.beats.map((b) => b.label), ["The win", "Across the business", "The stakes", "Today"]);
  assert.ok(cleanSpeech({ headline: "H", beats, close: "", facts: [] }), "a speech with nothing XF is still a speech");
  assert.equal(cleanSpeech({ headline: "H", beats: [beats[0], xf, beats[2]], close: "", facts: [] }), null, "XF does not stand in for the stakes");
});

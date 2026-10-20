// Flags that stay handled from one day to the next.
//
// A flag's id carries the date, so without the ledger every morning starts over. These
// tests pin what the ledger promises: age is counted in working days, a week at
// Attention becomes a P1, triage survives a run and runs out on its date, a condition
// that clears takes its triage with it, and a failed collector clears nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FlagLedger, annotateFlags, flagKey, activeTriage, flagRef } from "../src/store/flag-ledger.js";
import { handleTriage } from "../netlify/functions/slack-interactive.mjs";
import { workingDaysBetween, addWorkingDays } from "../src/lib/time.js";
import { buildReport } from "../src/render/report.js";

function backend() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? JSON.parse(map.get(key)) : null;
    },
    async set(key, value) {
      map.set(key, JSON.stringify(value));
    },
    async keys(prefix = "") {
      return [...map.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

const flag = (over = {}) => ({
  id: "2026-10-19:clickup.stalled:t1",
  key: "clickup.stalled:t1",
  layer: 2,
  rule: "clickup.stalled",
  severity: "attention",
  subject: { type: "task", id: "t1", label: "Fix cart" },
  message: "Fix cart is stalled.",
  advisable: true,
  ...over,
});
const present = { clickup: { present: true }, leadership: { present: true } };

/* --------------------------------- time --------------------------------- */

test("working days skip the weekend both ways", () => {
  assert.equal(workingDaysBetween("2026-10-16", "2026-10-19"), 1, "Friday to Monday is one working day");
  assert.equal(workingDaysBetween("2026-10-19", "2026-10-19"), 0);
  assert.equal(workingDaysBetween("2026-10-12", "2026-10-19"), 5);
  assert.equal(addWorkingDays("2026-10-16", 1), "2026-10-19", "Friday plus one is Monday");
  assert.equal(addWorkingDays("2026-10-19", 5), "2026-10-26");
});

/* ------------------------------- annotation ------------------------------- */

test("a flag seen for the first time is new today", () => {
  const { flags, entries } = annotateFlags([flag()], {}, { dateKey: "2026-10-19", sections: present });
  assert.equal(flags[0].isNew, true);
  assert.equal(flags[0].openDays, 0);
  assert.equal(entries["clickup.stalled:t1"].firstSeen, "2026-10-19");
});

test("age is counted from the first sighting, in working days", () => {
  const { flags } = annotateFlags([flag()], { "clickup.stalled:t1": { firstSeen: "2026-10-15", layer: 2 } }, { dateKey: "2026-10-19", sections: present });
  assert.equal(flags[0].isNew, false);
  assert.equal(flags[0].openDays, 2, "Thursday to Monday is two working days");
});

test("an attention flag open a working week escalates to P1, and says so", () => {
  const entries = { "clickup.stalled:t1": { firstSeen: "2026-10-12", layer: 2 } };
  const { flags } = annotateFlags([flag()], entries, { dateKey: "2026-10-19", sections: present, escalateAfterWorkingDays: 5 });
  assert.equal(flags[0].severity, "p1");
  assert.equal(flags[0].escalated, true);
  assert.equal(flags[0].originalSeverity, "attention");

  const younger = annotateFlags([flag()], { "clickup.stalled:t1": { firstSeen: "2026-10-13", layer: 2 } }, { dateKey: "2026-10-19", sections: present, escalateAfterWorkingDays: 5 });
  assert.equal(younger.flags[0].severity, "attention");
});

test("only attention escalates; a hygiene item stays hygiene however old", () => {
  const entries = { "clickup.stalled:t1": { firstSeen: "2026-09-01", layer: 2 } };
  const { flags } = annotateFlags([flag({ severity: "info" })], entries, { dateKey: "2026-10-19", sections: present });
  assert.equal(flags[0].severity, "info");
});

test("triage carries over while in force, and a snooze runs out on its date", () => {
  const entries = { "clickup.stalled:t1": { firstSeen: "2026-10-15", layer: 2, triage: { status: "snoozed", until: "2026-10-20" } } };
  assert.equal(annotateFlags([flag()], entries, { dateKey: "2026-10-19", sections: present }).flags[0].triage.status, "snoozed");
  const after = annotateFlags([flag()], entries, { dateKey: "2026-10-20", sections: present });
  assert.equal(after.flags[0].triage, undefined, "back on the list the day the snooze ends");
  assert.equal(after.entries["clickup.stalled:t1"].triage, undefined);
  assert.equal(activeTriage({ status: "done" }, "2030-01-01").status, "done", "done has no end date");
});

test("a flag that stops being raised takes its triage with it, so a return is new", () => {
  const entries = { "clickup.stalled:t1": { firstSeen: "2026-10-12", layer: 2, triage: { status: "done" } } };
  const cleared = annotateFlags([], entries, { dateKey: "2026-10-19", sections: present });
  assert.deepEqual(cleared.entries, {});
  const back = annotateFlags([flag()], cleared.entries, { dateKey: "2026-10-20", sections: present });
  assert.equal(back.flags[0].isNew, true);
  assert.equal(back.flags[0].triage, undefined);
});

test("a failed collector clears nothing: its silence is not a fix", () => {
  const entries = { "clickup.stalled:t1": { firstSeen: "2026-10-12", lastSeen: "2026-10-16", layer: 2, triage: { status: "done" } } };
  const { entries: next } = annotateFlags([], entries, { dateKey: "2026-10-19", sections: { clickup: { present: false } } });
  assert.deepEqual(next["clickup.stalled:t1"], entries["clickup.stalled:t1"]);
});

test("an old report's flag, with no key, gets the same key from its id", () => {
  assert.equal(flagKey({ id: "2026-10-19:clickup.stalled:t1" }), "clickup.stalled:t1");
  assert.equal(flagKey({ id: "clickup.stale_in_status:t9" }), "clickup.stale_in_status:t9");
});

/* --------------------------------- storage --------------------------------- */

test("the pipeline's save keeps a triage the dashboard wrote while it ran", async () => {
  const b = backend();
  const ledger = new FlagLedger(b);
  const { entries } = annotateFlags([flag()], {}, { dateKey: "2026-10-19", sections: present });
  // The dashboard writes between the pipeline's read and its save.
  await ledger.setTriage("clickup.stalled:t1", { status: "done" }, { today: "2026-10-19" });
  await ledger.saveObservations(entries);
  assert.equal((await ledger.read()).entries["clickup.stalled:t1"].triage.status, "done");
});

test("snooze and waiting are dated in working days, and waiting needs a person", async () => {
  const ledger = new FlagLedger(backend());
  const snoozed = await ledger.setTriage("k", { status: "snoozed", workingDays: 1 }, { today: "2026-10-16" });
  assert.equal(snoozed.triage.until, "2026-10-19");
  const waiting = await ledger.setTriage("k", { status: "waiting", waitingOn: "Blake" }, { today: "2026-10-19", defaultWaitingDays: 2 });
  assert.equal(waiting.triage.until, "2026-10-21");
  await assert.rejects(ledger.setTriage("k", { status: "waiting" }, { today: "2026-10-19" }), /who it is waiting on/);
  await assert.rejects(ledger.setTriage("k", { status: "ignored" }, { today: "2026-10-19" }), /Unknown triage/);
  const cleared = await ledger.setTriage("k", { status: null }, { today: "2026-10-19" });
  assert.equal(cleared.triage, undefined);
});

test("the first run backfills age from consecutive official reports, stopping at a gap", async () => {
  const b = backend();
  const store = { backend: b, prefixes: {} };
  const reportOn = (d, flags) => b.set(`reports/${d}-official-r.json`, { dateKey: d, flags: flags.map((f) => ({ id: `${d}:${f}` })) });
  const raised = ["clickup.stalled:t1"];
  await reportOn("2026-10-13", raised); // Tue
  // Wed the 14th: not raised, which breaks the run.
  await reportOn("2026-10-14", []);
  await reportOn("2026-10-15", raised);
  await reportOn("2026-10-16", raised); // Fri, then the weekend, then today
  const entries = await new FlagLedger(b).backfillFirstSeen(store, [flag()], { dateKey: "2026-10-19" });
  assert.equal(entries["clickup.stalled:t1"].firstSeen, "2026-10-15");
});

/* --------------------------------- readout --------------------------------- */

const emptyDetail = {
  shopify: null,
  leadership: { queue: [], backlog: [], summary: { activeCount: 0, shippedCount: 0, backlogCount: 0, peopleAtCapacity: 0, rosterSize: 0 } },
  crossLayer: null,
  clickup: null,
  intelligems: null,
};
const missing = { present: false, reason: "test" };
const report = (flags) =>
  buildReport({
    runId: "r",
    mode: "official",
    dateKey: "2026-10-19",
    nowIso: "2026-10-19T13:00:00Z",
    flags,
    sections: { shopify: missing, leadership: { present: true }, crossLayer: missing, clickup: missing, intelligems: missing },
    detail: emptyDetail,
    baseline: { describe: "test" },
    config: { system: { slack: {} } },
  });

test("the readout splits new from still open, and keeps handled flags out of the count", () => {
  const r = report([
    flag({ id: "a", key: "a", message: "Brand new.", isNew: true, openDays: 0 }),
    flag({ id: "b", key: "b", message: "Old one.", isNew: false, openDays: 3 }),
    flag({ id: "c", key: "c", message: "Handled.", isNew: false, openDays: 2, triage: { status: "done" } }),
    flag({ id: "d", key: "d", message: "Chased.", isNew: false, openDays: 1, triage: { status: "waiting", waitingOn: "Blake", until: "2026-10-21" } }),
  ]);
  assert.equal(r.summary.attention, 2);
  assert.equal(r.summary.newToday, 1);
  assert.equal(r.summary.parked, 1);
  assert.equal(r.summary.triaged.waiting, 1);
  assert.match(r.text, /NEEDS YOUR ATTENTION\. 2 item\(s\)\. 1 new today, 1 still open\./);
  assert.match(r.text, /NEW TODAY\n.*Brand new\./);
  assert.match(r.text, /STILL OPEN\n.*Old one\. \(open 3 working days\)/);
  assert.match(r.text, /WAITING ON SOMEONE\. 1 item\(s\)[^\n]*\n.*Chased\. - waiting on Blake until 2026-10-21/);
  assert.match(r.text, /PARKED\. 1 done\./);
  assert.ok(!/NEEDS YOUR ATTENTION[\s\S]*Handled\.[\s\S]*WAITING/.test(r.text), "a done flag is not listed as needing attention");
  const slackText = JSON.stringify(r.slackBlocks);
  assert.ok(!slackText.includes("Handled."), "a done flag is not posted to Slack");
  assert.ok(slackText.includes("Waiting on someone"));
});

test("a readout without a ledger reads as it always did", () => {
  const r = report([flag({ id: "a", message: "Plain." })]);
  assert.match(r.text, /NEEDS YOUR ATTENTION\. 1 item\(s\)\.\n  \[ATTENTION\] \[L2\] Plain\./);
  assert.equal(r.summary.newToday, null);
});

/* ---------------------------- triage from Slack ---------------------------- */

test("each flag in the Slack readout carries triage buttons, inside Slack's limits", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    flag({ id: `2026-10-19:intelligems.probability_crossed:${"e".repeat(36)}:group-${i}:conversion_rate_per_session:prob`, key: `intelligems.probability_crossed:${"e".repeat(36)}:group-${i}:conversion_rate_per_session:prob`, isNew: true, openDays: 0 }),
  );
  const r = report(many);
  assert.ok(r.slackBlocks.length <= 50, `Slack allows 50 blocks, got ${r.slackBlocks.length}`);
  const actions = r.slackBlocks.filter((b) => b.type === "actions");
  assert.equal(actions.length, 18);
  for (const block of actions) {
    assert.deepEqual(block.elements.map((e) => e.action_id), ["flag_done", "flag_snooze_1", "flag_snooze_5", "flag_dismiss"]);
    for (const el of block.elements) assert.ok(el.value.length <= 150, "a long key is sent as a short ref");
  }
  assert.equal(actions[0].elements[0].value, flagRef(many[0].key));
  assert.match(JSON.stringify(r.slackBlocks), /12 more item\(s\) in the full readout/);
});

const quiet = { info() {}, warn() {}, error() {} };
const triageConfig = { system: { timezone: "America/Chicago", schedule: { workingWeekdays: [1, 2, 3, 4, 5] } }, people: { alex: { slackUserId: "UALEX" } } };

async function slackClick({ user = "UALEX", actionId = "flag_done", key = "clickup.stalled:t1", raised = true } = {}) {
  const b = backend();
  if (raised) await b.set("flags/ledger.json", { version: 1, entries: { [key]: { firstSeen: "2026-10-15", layer: 2 } } });
  const responses = [];
  const payload = {
    user: { id: user },
    response_url: "https://hooks.slack.test/r",
    message: { text: "readout", blocks: [{ type: "section", block_id: "s1" }, { type: "actions", block_id: "a1" }] },
  };
  const result = await handleTriage({
    payload,
    action: { action_id: actionId, value: flagRef(key), block_id: "a1" },
    config: triageConfig,
    store: { backend: b },
    logger: quiet,
    respondImpl: async (_p, body) => responses.push(body),
  });
  return { result, responses, ledger: await new FlagLedger(b).read() };
}

test("Alex's Done in Slack is saved, and the button row becomes what was done", async () => {
  const { result, responses, ledger } = await slackClick();
  assert.equal(result.ok, true);
  assert.equal(ledger.entries["clickup.stalled:t1"].triage.status, "done");
  assert.equal(ledger.entries["clickup.stalled:t1"].triage.by, "slack:UALEX");
  assert.equal(responses[0].replace_original, true);
  assert.equal(responses[0].blocks[0].type, "section", "the flag's message is left alone");
  assert.match(responses[0].blocks[1].elements[0].text, /Done by <@UALEX>/);
});

test("a snooze from Slack is dated in working days", async () => {
  const { ledger, responses } = await slackClick({ actionId: "flag_snooze_5" });
  const t = ledger.entries["clickup.stalled:t1"].triage;
  assert.equal(t.status, "snoozed");
  assert.match(responses[0].blocks[1].elements[0].text, new RegExp(`Snoozed until ${t.until}`));
});

test("only Alex can triage from Slack, and anyone else gets no reply at all", async () => {
  const { result, responses, ledger } = await slackClick({ user: "UOTHER" });
  assert.equal(result.reason, "not_alex");
  assert.equal(ledger.entries["clickup.stalled:t1"].triage, undefined);
  assert.deepEqual(responses, [], "the system only communicates with Alex");
});

test("the team roster carries no contact details", async () => {
  const { default: people } = await import("../config/people.json", { with: { type: "json" } });
  for (const person of people.team) {
    assert.equal(person.slackUserId, undefined, `${person.name} has a Slack id; the system never contacts the team`);
    assert.equal(person.email, undefined, `${person.name} has an email; the system never contacts the team`);
  }
});

test("a button on a flag that has since cleared says so and writes nothing", async () => {
  const { result, ledger } = await slackClick({ raised: false });
  assert.equal(result.reason, "not_raised");
  assert.deepEqual(ledger.entries, {});
});

// One line per person for the routine sprint checks, and the rule check that says which
// kinds of flag get acted on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByPerson, groupLine, personOf, isRoutine, YOU, NOBODY } from "../public/flag-groups.js";
import { ruleHealth, applyQuietRules } from "../src/delta/rule-health.js";
import { createBackend } from "../src/lib/storage.js";
import { FlagLedger } from "../src/store/flag-ledger.js";

const f = (rule, who, over = {}) => ({
  id: `${rule}:${who}:${over.n ?? 0}`,
  key: `${rule}:${who}:${over.n ?? 0}`,
  layer: 2,
  rule,
  severity: "attention",
  subject: { type: "task", id: `t${over.n ?? 0}`, label: "A ticket" },
  message: `${rule} for ${who}`,
  values: { who },
  ...over,
});

test("routine sprint checks group by person; P1s, tests and replies owed stand alone", () => {
  const flags = [
    f("nextstep.overdue", "Akansha", { n: 1 }),
    { ...f("intelligems.verdict_changed", "x"), layer: 3, severity: "p1" },
    f("nextstep.overdue", "Akansha", { n: 2 }),
    f("nextstep.reply_owed", "Kate", { n: 3 }),
    f("nextstep.carried_over", "Akansha", { n: 4, subject: { type: "person", id: "u1:carried", label: "Akansha Gupta" }, values: { who: "Akansha", tickets: [{ id: "a" }, { id: "b" }] } }),
    f("nextstep.overdue", "Blake", { n: 5 }),
    { ...f("nextstep.overdue", "Akansha", { n: 6 }), severity: "p1", escalated: true },
  ];
  const { items, groups } = groupByPerson(flags);
  assert.equal(groups.length, 1, "Blake has one routine flag, so it stays as it is");
  assert.equal(groups[0].person, "Akansha");
  assert.equal(groups[0].flags.length, 3);
  assert.equal(groups[0].summary, "2 overdue, 2 carried over");
  assert.equal(groupLine(groups[0]), "Akansha · 3 sprint items: 2 overdue, 2 carried over");
  // The group sits where its first flag was; everything else keeps its order.
  assert.deepEqual(items.map((i) => (i.kind === "group" ? `group:${i.person}` : i.flag.rule)), [
    "group:Akansha",
    "intelligems.verdict_changed",
    "nextstep.reply_owed",
    "nextstep.overdue",
    "nextstep.overdue",
  ]);
  assert.ok(!isRoutine(flags[6]), "an escalated P1 is never folded into a group");
});

test("who a flag is about: the named person, the assignee, the ticket, Alex as You, else nobody", () => {
  const tasks = new Map([["t9", { assignees: [{ username: "Robson Lopes" }] }]]);
  assert.equal(personOf(f("nextstep.overdue", "Oleksandr, Blake")), "Oleksandr");
  assert.equal(personOf({ ...f("nextstep.no_assignee", "x"), values: { assignees: ["Blake Tucker"] } }), "Blake");
  assert.equal(personOf({ ...f("clickup.stale_in_status", "x"), values: undefined, subject: { type: "task", id: "t9" } }, { tasks }), "Robson");
  assert.equal(personOf(f("nextstep.due_not_started", "you")), YOU);
  assert.equal(personOf({ ...f("nextstep.no_assignee", "x"), values: { assignees: ["Alex Turney"] } }, { alexName: "Alex Turney" }), YOU);
  assert.equal(personOf({ ...f("clickup.stalled", "x"), values: {} }), NOBODY);
  assert.equal(groupLine({ person: YOU, flags: [1, 2], summary: "2 nobody assigned" }), "Yours · 2 sprint items: 2 nobody assigned");
});

test("the readout lists grouped flags under BY PERSON, and Slack posts one block per person", async () => {
  const { buildReport } = await import("../src/render/report.js");
  const missing = { present: false, reason: "test" };
  const r = buildReport({
    runId: "r",
    mode: "official",
    dateKey: "2026-11-13",
    nowIso: "2026-11-13T14:00:00Z",
    flags: [f("nextstep.overdue", "Akansha", { n: 1 }), f("nextstep.no_assignee", "Akansha", { n: 2 }), f("nextstep.overdue", "Blake", { n: 3 })],
    sections: { shopify: missing, leadership: { present: true }, crossLayer: missing, clickup: missing, intelligems: missing },
    detail: { leadership: { queue: [], backlog: [], summary: { activeCount: 0, shippedCount: 0, backlogCount: 0, peopleAtCapacity: 0, rosterSize: 0 } } },
    baseline: { describe: "test" },
    config: { system: { slack: {} } },
  });
  assert.match(r.text, /NEEDS YOUR ATTENTION\. 3 item\(s\)\. 2 of them grouped by person\./);
  assert.match(r.text, /BY PERSON[^\n]*\n    \[P2\] Akansha · 2 sprint items: 1 overdue, 1 nobody assigned\n      - nextstep\.overdue for Akansha/);
  const slack = r.slackBlocks.map((b) => b.text?.text ?? "").join("\n");
  assert.match(slack, /\*Sprint · Akansha · 2 sprint items: 1 overdue, 1 nobody assigned\*/);
  assert.equal(r.slackBlocks.filter((b) => b.type === "actions").length, 1, "only Blake's single flag carries triage buttons");
  assert.ok(r.slackBlocks.length <= 50);
});

/* -------------------------------- rule check -------------------------------- */

const day = (dateKey, flags) => ({ dateKey, flags });
const rf = (rule, key, over = {}) => ({ rule, key, layer: 2, severity: "attention", ...over });

test("a rule never acted on whose flags sit untouched is suggested for Hygiene, with its numbers", () => {
  const history = [
    day("2026-11-03", [rf("nextstep.no_assignee", "a"), rf("nextstep.no_assignee", "b"), rf("nextstep.overdue", "x")]),
    day("2026-11-04", [rf("nextstep.no_assignee", "a"), rf("nextstep.no_assignee", "b"), rf("nextstep.no_assignee", "c"), rf("nextstep.overdue", "x", { triage: { status: "done" } })]),
  ];
  const today = [
    rf("nextstep.no_assignee", "a", { openDays: 8 }),
    rf("nextstep.no_assignee", "b", { openDays: 7 }),
    rf("nextstep.no_assignee", "c", { openDays: 6, triage: { status: "dismissed" } }),
  ];
  const h = ruleHealth({ history, today, dateKey: "2026-11-13" });
  const owner = h.rules.find((r) => r.rule === "nextstep.no_assignee");
  assert.deepEqual(
    { raised: owner.raised, acted: owner.acted, ignored: owner.ignored, dismissed: owner.dismissed, verdict: owner.verdict, suggest: owner.suggest },
    { raised: 3, acted: 0, ignored: 2, dismissed: 1, verdict: "ignored", suggest: true },
  );
  assert.equal(h.rules[0].rule, "nextstep.no_assignee", "suggestions first");
  assert.equal(h.suggested, 1);
  assert.equal(h.since, "2026-11-03");
  assert.equal(h.readouts, 3);
});

test("flags that clear within two days are shown as clearing themselves, not suggested", () => {
  const history = [
    day("2026-11-03", [rf("clickup.stalled", "a"), rf("clickup.stalled", "b")]),
    day("2026-11-04", [rf("clickup.stalled", "a"), rf("clickup.stalled", "c")]),
  ];
  const h = ruleHealth({ history, today: [], dateKey: "2026-11-05" });
  const stalled = h.rules.find((r) => r.rule === "clickup.stalled");
  assert.equal(stalled.verdict, "clears itself");
  assert.equal(stalled.fast, 3);
  assert.equal(stalled.suggest, false);
});

test("a rule Alex acts on reads Needs you; a P1 rule can never be quieted; context is left out", () => {
  const today = [
    rf("nextstep.reply_owed", "a", { triage: { status: "done" } }),
    rf("nextstep.reply_owed", "b", { triage: { status: "waiting" } }),
    rf("nextstep.reply_owed", "c", { openDays: 9 }),
    rf("intelligems.verdict_changed", "v", { layer: 3, severity: "p1", openDays: 9 }),
    rf("intelligems.control_moved", "m", { severity: "info" }),
  ];
  const h = ruleHealth({ history: [], today, dateKey: "2026-11-13" });
  assert.equal(h.rules.find((r) => r.rule === "nextstep.reply_owed").verdict, "needs you");
  assert.equal(h.rules.find((r) => r.rule === "intelligems.verdict_changed").canQuiet, false);
  assert.ok(!h.rules.some((r) => r.rule === "intelligems.control_moved"));
});

test("a quieted rule's P2s go to Hygiene before escalation; its P1s stay", () => {
  const out = applyQuietRules([rf("nextstep.no_assignee", "a"), rf("nextstep.no_assignee", "b", { severity: "p1" }), rf("nextstep.overdue", "c")], ["nextstep.no_assignee"]);
  assert.deepEqual(out.map((x) => [x.severity, Boolean(x.quieted)]), [["info", true], ["p1", false], ["attention", false]]);
});

test("quiet rules are saved, read back and removed, and a bad name is refused", async () => {
  const ledger = new FlagLedger(await createBackend({ mode: "memory" }));
  await ledger.setQuiet("nextstep.no_assignee", true, { note: "fine for now" });
  assert.deepEqual(Object.keys((await ledger.readQuiet()).rules), ["nextstep.no_assignee"]);
  assert.equal((await ledger.readQuiet()).rules["nextstep.no_assignee"].note, "fine for now");
  await ledger.setQuiet("nextstep.no_assignee", false);
  assert.deepEqual((await ledger.readQuiet()).rules, {});
  await assert.rejects(ledger.setQuiet("not a rule", true), /Which rule/);
});

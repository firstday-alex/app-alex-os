// Next steps: each check has to fire on the case it names, say who to reach, and stay
// quiet otherwise. The sprint-level ones must raise one flag per person, not per ticket.

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextStepFlags } from "../src/delta/next-steps.js";

const DAY = 86_400_000;
const ALEX = { id: "100", username: "Alex Turney" };
const ROBSON = { id: "1", username: "Robson Lopes" };
const BLAKE = { id: "2", username: "Blake Tucker" };
const CRIS = { id: "3", username: "Cristobal Alanis" };

const config = {
  system: { timezone: "America/Chicago" },
  people: {
    alex: { clickupUserId: "100", name: "Alex Turney" },
    team: [
      { clickupUserId: "1", name: "Robson Lopes" },
      { clickupUserId: "2", name: "Blake Tucker" },
      { clickupUserId: "3", name: "Cristobal Alanis" },
    ],
  },
  clickup: {},
};

// Tuesday 2026-10-27, 9 AM Central.
const TUESDAY = "2026-10-27T14:00:00.000Z";
const WEDNESDAY = "2026-10-28T14:00:00.000Z";
const now = new Date(TUESDAY).getTime();

const ticket = (id, over = {}) => ({
  id,
  name: `Ticket ${id}`,
  url: `https://app.clickup.com/t/${id}`,
  status: "in-progress",
  bucket: "inProgress",
  assignees: [ROBSON],
  taskOwners: [ROBSON],
  dateUpdated: now - 3_600_000,
  ...over,
});

const run = (tasks, extra = {}) => nextStepFlags({ tasks, config, dateKey: "2026-10-27", nowIso: TUESDAY, ...extra });
const rules = (flags) => flags.map((f) => f.rule).sort();
// For tests about one ticket check: three tickets in progress for the same person also,
// correctly, trips the work-in-progress check, which has its own test.
const ticketRules = (flags) => rules(flags).filter((r) => r !== "nextstep.too_much_in_progress");

test("someone @mentioning Alex is a reply, and Alex's own comment is not", () => {
  const asked = ticket("a", { lastComment: { userId: "2", user: "Blake Tucker", date: now - DAY, text: "@Alex Turney ok to ship?", mentions: [{ id: "100", username: "Alex Turney" }] } });
  const own = ticket("b", { lastComment: { userId: "100", user: "Alex Turney", date: now - DAY, text: "@Alex Turney note to self", mentions: [{ id: "100", username: "Alex Turney" }] } });
  const flags = run([asked, own]);
  assert.deepEqual(rules(flags), ["nextstep.reply_owed"]);
  assert.equal(flags[0].values.action, "reply");
  assert.match(flags[0].message, /^Reply to Blake on "Ticket a"/);
});

test("a question to someone else is a nudge only once it has gone unanswered", () => {
  const q = (age, updatedAfter) =>
    ticket(`q${age}`, {
      lastComment: { userId: "1", user: "Robson Lopes", date: now - age * DAY, mentions: [{ id: "2", username: "Blake Tucker" }] },
      dateUpdated: now - age * DAY + updatedAfter,
    });
  const flags = run([q(3, 0), q(1, 0), q(4, 2 * DAY)]);
  assert.deepEqual(ticketRules(flags), ["nextstep.question_unanswered"]);
  assert.equal(flags[0].values.who, "Blake");
});

test("Alex owning a ticket in QA or ready for deploy is waiting on Alex", () => {
  const t = ticket("r", { status: "ready for deploy", taskOwners: [ALEX], assignees: [CRIS], statusAge: { days: 2, exact: true } });
  const fresh = ticket("s", { status: "qa", taskOwners: [ALEX], assignees: [CRIS], statusAge: { days: 0, exact: true } });
  const flags = run([t, fresh]);
  assert.deepEqual(rules(flags), ["nextstep.awaiting_you"]);
  assert.match(flags[0].message, /deploy or approve it/);
});

test("a ticket sent back from QA in the last three days asks what failed", () => {
  const statusLedger = {
    entries: {
      back: { status: "in-progress", previousStatus: "qa", exact: true, since: now - DAY, firstObserved: now - DAY },
      old: { status: "in-progress", previousStatus: "qa", exact: true, since: now - 6 * DAY, firstObserved: now - DAY },
      fwd: { status: "in-progress", previousStatus: "to do", exact: true, since: now - DAY, firstObserved: now - DAY },
    },
  };
  const flags = run([ticket("back"), ticket("old"), ticket("fwd")], { statusLedger });
  assert.deepEqual(ticketRules(flags), ["nextstep.bounced_back"]);
  assert.match(flags[0].message, /^Ask Robson what failed/);
});

test("due dates: overdue is a decision, due soon and not started is a nudge", () => {
  const flags = run([
    ticket("late", { dueDate: now - 2 * DAY }),
    ticket("soon", { status: "to do", bucket: "notStarted", dueDate: now + DAY }),
    ticket("later", { status: "to do", bucket: "notStarted", dueDate: now + 6 * DAY }),
    ticket("going", { dueDate: now + DAY }),
  ]);
  assert.deepEqual(rules(flags), ["nextstep.due_not_started", "nextstep.overdue"]);
});

test("in progress with no due date is only flagged once due dates are in use", () => {
  const undated = [ticket("u1"), ticket("u2")];
  assert.equal(run(undated).length, 0);
  const dated = [1, 2, 3].map((i) => ticket(`d${i}`, { dueDate: now + 5 * DAY }));
  assert.deepEqual(ticketRules(run([...undated, ...dated])), ["nextstep.no_due_date", "nextstep.no_due_date"]);
});

test("not started on Wednesday is one decision per owner, and not raised on Tuesday", () => {
  const todo = (id, owner) => ticket(id, { status: "to do", bucket: "notStarted", taskOwners: [owner], assignees: [owner] });
  const tasks = [todo("t1", BLAKE), todo("t2", BLAKE), todo("t3", CRIS), todo("t4", ALEX)];
  assert.equal(run(tasks).filter((f) => f.rule === "nextstep.commitment_at_risk").length, 0);
  const wed = nextStepFlags({ tasks, config, dateKey: "2026-10-28", nowIso: WEDNESDAY }).filter((f) => f.rule === "nextstep.commitment_at_risk");
  assert.deepEqual(wed.map((f) => f.values.who).sort(), ["Blake", "Cristobal"]);
  assert.match(wed.find((f) => f.values.who === "Blake").message, /^It is Wednesday and Blake has 2 tickets not started/);
  // Keyed on the week, so handling it lasts the sprint.
  assert.match(wed[0].key, /:2026-10-26$/);
});

test("carried over: open since before this sprint's Monday, one flag per owner", () => {
  const monday = new Date("2026-10-26T05:00:00.000Z").getTime();
  const statusLedger = { entries: { old: { firstObserved: monday - 3 * DAY }, new: { firstObserved: monday + 3_600_000 } } };
  const flags = run([ticket("old"), ticket("new")], { statusLedger });
  assert.deepEqual(rules(flags), ["nextstep.carried_over"]);
  assert.match(flags[0].message, /Robson carried 1 ticket over/);
});

test("too much at once, and nothing started, are about who is doing the work", () => {
  const wip = [1, 2, 3].map((i) => ticket(`w${i}`, { assignees: [CRIS], taskOwners: [ROBSON] }));
  const idle = ticket("i1", { status: "to do", bucket: "notStarted", assignees: [BLAKE], taskOwners: [BLAKE] });
  const flags = run([...wip, idle]);
  assert.deepEqual(rules(flags), ["nextstep.idle", "nextstep.too_much_in_progress"]);
  assert.equal(flags.find((f) => f.rule === "nextstep.too_much_in_progress").values.who, "Cristobal");
  assert.equal(flags.find((f) => f.rule === "nextstep.idle").values.who, "Blake");
});

test("a rock due this month with nothing in progress is a decision", () => {
  const leadership = {
    queue: [
      { id: "quiz", title: "Quiz", state: "active", targetMonth: "2026-10", clickupBigSwingOptionId: "opt-quiz", owner: { name: "Robson Lopes" } },
      { id: "app", title: "Mobile App", state: "active", targetMonth: "2026-10", clickupBigSwingOptionId: "opt-app" },
      { id: "later", title: "Later", state: "active", targetMonth: "2026-12", clickupBigSwingOptionId: "opt-later" },
    ],
  };
  const tasks = [
    ticket("q", { status: "to do", bucket: "notStarted", bigSwing: { optionId: "opt-quiz", label: "Quiz" } }),
    ticket("a", { bigSwing: { optionId: "opt-app", label: "Mobile App" } }),
  ];
  const flags = run(tasks, { leadership }).filter((f) => f.rule === "nextstep.rock_due_not_moving");
  assert.equal(flags.length, 1);
  assert.match(flags[0].message, /^"Quiz" is due this month and no ticket on it is in progress \(1 still to do\)\. Decide with Robson/);
});

test("nobody assigned is a fix", () => {
  const flags = run([ticket("n", { assignees: [] })]);
  assert.deepEqual(rules(flags), ["nextstep.no_assignee"]);
  assert.equal(flags[0].severity, "info");
});

test("a sprint ticket's nudge goes to whoever is assigned, not the project owner", () => {
  const t = ticket("d", { status: "to do", bucket: "notStarted", assignees: [BLAKE], taskOwners: [ROBSON], dueDate: now + DAY });
  const [flag] = run([t]).filter((f) => f.rule === "nextstep.due_not_started");
  assert.equal(flag.values.who, "Blake");
  assert.match(flag.message, /^Nudge Blake:/);
});

test("with nobody assigned, the nudge falls back to the project owner", () => {
  const t = ticket("e", { status: "to do", bucket: "notStarted", assignees: [], taskOwners: [ROBSON], dueDate: now + DAY });
  const [flag] = run([t]).filter((f) => f.rule === "nextstep.due_not_started");
  assert.equal(flag.values.who, "Robson");
});

test("not started on Wednesday is raised for the assignee, not the Task Owner", () => {
  const t = ticket("a", { status: "to do", bucket: "notStarted", assignees: [BLAKE], taskOwners: [ROBSON] });
  const wed = nextStepFlags({ tasks: [t], config, dateKey: "2026-10-28", nowIso: WEDNESDAY }).filter((f) => f.rule === "nextstep.commitment_at_risk");
  assert.equal(wed.length, 1);
  assert.equal(wed[0].subject.label, "Blake Tucker");
  assert.match(wed[0].message, /Blake has 1 ticket not started/);
});

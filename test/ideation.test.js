// Ideation: the right tickets go in, and only well-formed answers about those tickets come
// out. The model's judgement is not tested here; what it is allowed to say is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanAnswer, sprintTickets, testForIdeation, ticketForIdeation } from "../src/agents/ideation.js";

const ideas = (n) => Array.from({ length: n }, (_, i) => ({ title: `Idea ${i + 1}`, how: "Do it differently." }));

test("the sprint is everything but complete, backlog and archived", () => {
  const tasks = [
    { id: "a", status: "in-progress" },
    { id: "b", status: "done (this sprint)" },
    { id: "c", status: "complete" },
    { id: "d", status: "backlog" },
    { id: "e", status: "to do", archived: true },
    { id: "f", status: "QA" },
  ];
  assert.deepEqual(sprintTickets(tasks).map((t) => t.id), ["a", "b", "f"]);
});

test("a ticket falls back to its last comment when the thread could not be read", () => {
  const task = { id: "a", name: "A", status: "qa", taskOwners: [{ username: "Robson Lopes" }], assignees: [], lastComment: { user: "Blake Tucker", date: 0, text: "looks good" } };
  assert.deepEqual(ticketForIdeation(task).comments, [{ user: "Blake Tucker", date: null, text: "looks good" }]);
  const full = ticketForIdeation(task, { description: "Spec", comments: [{ user: "X", date: null, text: "first" }] });
  assert.equal(full.description, "Spec");
  assert.equal(full.comments[0].text, "first");
  assert.deepEqual(full.owner, ["Robson Lopes"]);
});

test("a test keeps only the decision metrics, and drops ones not configured", () => {
  const t = testForIdeation({
    id: "t1",
    name: "Bundle nav",
    verdict: "not_ready",
    groups: [
      {
        name: "Hide",
        isControl: true,
        orders: 598,
        metrics: {
          conversion_rate: { value: 0.022, upliftPct: null, probBeatControl: null, interval: [0.02, 0.024] },
          gross_profit_per_visitor: { value: null, configured: false },
          avg_units_per_order: { value: 3.4 },
        },
      },
    ],
  });
  assert.deepEqual(Object.keys(t.groups[0].metrics), ["conversion_rate"]);
  assert.deepEqual(t.groups[0].metrics.conversion_rate, { value: 0.022, upliftPct: null, probBeatControl: null });
});

test("answers about unknown tickets, bad verdicts, or fewer than three ideas are dropped and reported missing", () => {
  const tickets = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const { tickets: kept, missing } = cleanAnswer(
    {
      tickets: [
        { id: "a", verdict: "successful", rootCause: "Shipped and confirmed live.", evidence: "Cristobal: Live", ideas: ideas(4) },
        { id: "a", verdict: "unsuccessful", rootCause: "duplicate", evidence: "", ideas: ideas(3) },
        { id: "b", verdict: "maybe", rootCause: "x", evidence: "", ideas: ideas(3) },
        { id: "c", verdict: "too_early", rootCause: "Not started.", evidence: "", ideas: ideas(2) },
        { id: "zzz", verdict: "successful", rootCause: "x", evidence: "", ideas: ideas(3) },
      ],
    },
    tickets,
  );
  assert.deepEqual(kept.map((t) => [t.id, t.verdict, t.ideas.length]), [["a", "successful", 3]]);
  assert.deepEqual(missing, ["b", "c", "d"]);
});

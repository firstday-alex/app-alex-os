// My stand-up: facts from Alex's own work only, Slack searched only for Alex's messages
// with no id kept, and every drafted line traced to a fact.

import { test } from "node:test";
import assert from "node:assert/strict";
import { standupFacts, checkDraft, alexSlack, standupText, morningStandup } from "../src/agents/my-standup.js";

const config = {
  system: { timezone: "America/Chicago", schedule: { workingWeekdays: [1, 2, 3, 4, 5] }, http: { maxAttempts: 1 } },
  people: { alex: { name: "Alex Turney", clickupUserId: "7", slackUserId: "UALEX" }, team: [{ name: "Sam Rivera", clickupUserId: "42" }] },
};
const now = new Date("2026-11-17T14:30:00Z"); // Tue 08:30 Central
const alex = [{ id: "7", username: "Alex Turney" }];
const sam = [{ id: "42", username: "Sam Rivera" }];

test("facts: Alex's last plan, Alex's ClickUp moves and open tickets, notes, waiting; nobody else's work", () => {
  const report = {
    detail: {
      clickup: {
        changes: {
          statusChanges: [
            { id: "a", name: "[DEV] Toddler Sesame Street SKU Setup", assignees: alex, taskOwners: [], from: "in-progress", to: "vqa" },
            { id: "b", name: "Sam's ticket", assignees: sam, taskOwners: [], from: "to do", to: "in-progress" },
          ],
          closed: [{ id: "c", name: "Sesame Street feedback", assignees: [], taskOwners: alex }],
        },
        tasks: [
          { id: "d", name: "All-in-1 Core Bundle", assignees: alex, taskOwners: [], bucket: "inProgress", status: "in-progress", dueDate: Date.parse("2026-11-17T18:00:00Z") },
          { id: "e", name: "Commented one", assignees: sam, taskOwners: [], bucket: "notStarted", status: "to do", lastComment: { userId: "7", date: Date.parse("2026-11-16T16:00:00Z"), text: "Looks good, ship it" } },
        ],
      },
    },
    flags: [],
  };
  const standups = { days: [{ dateKey: "2026-11-16", posts: [{ name: "Alex Turney", yesterday: "planning", today: "sesame street feedback + planning", blockers: "none" }] }] };
  const out = standupFacts({
    config,
    now,
    report,
    standups,
    slack: { messages: [{ day: "2026-11-16", where: "#marketing", text: "sent the ss feedback doc" }] },
    notes: [{ dateKey: "2026-11-16", text: "Ops wants SKU list" }],
    waiting: [{ waitingOn: "Robson", at: "2026-11-16T15:00:00Z", what: "Quiz copy" }],
    plan: { items: [{ week: "2026-11-16", text: "QA bundle builder", done: false }] },
  });
  const text = out.facts.map((f) => `[${f.id}] ${f.text}`).join("\n");
  assert.match(text, /\[p1\] On 2026-11-16 Alex said Today: sesame street feedback \+ planning/);
  assert.match(text, /Closed: "Sesame Street feedback"/);
  assert.match(text, /Moved in-progress → vqa: "\[DEV\] Toddler Sesame Street SKU Setup"/);
  assert.match(text, /Open, in-progress, due 2026-11-17 \(today\): "All-in-1 Core Bundle"/);
  assert.match(text, /Alex commented on "Commented one": Looks good, ship it/);
  assert.match(text, /\[s1\] 2026-11-16 in #marketing: sent the ss feedback doc/);
  assert.match(text, /Waiting on Robson \(since 2026-11-16\): Quiz copy/);
  assert.match(text, /Planned this week: QA bundle builder/);
  assert.doesNotMatch(text, /Sam's ticket/);
  assert.equal(out.style.length, 1);
});

test("a drafted line keeps only real sources; a line citing nothing is flagged; Blockers none needs none", () => {
  const facts = [{ id: "c1" }, { id: "s1" }];
  const d = checkDraft(
    {
      yesterday: { text: "Yesterday: sesame street feedback + planning", sources: ["c1", "zz9"] },
      today: { text: "qa + All-in-1 Core Bundle next steps", sources: [] },
      blockers: { text: "none", sources: [] },
    },
    facts,
  );
  assert.deepEqual(d.yesterday, { text: "sesame street feedback + planning", sources: ["c1"] });
  assert.deepEqual(d.unsupported, ["today"]);
  assert.equal(standupText(d), "Yesterday: sesame street feedback + planning\nToday: qa + All-in-1 Core Bundle next steps\nBlockers: none");
  assert.equal(checkDraft({ yesterday: { text: "x", sources: [] } }, facts), null);
});

test("Slack is searched for Alex's own messages only, mentions become names, DMs are just 'a DM', no id is kept", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const u = new URL(url);
    const body = u.pathname.endsWith("search.messages")
      ? {
          ok: true,
          messages: {
            paging: { pages: 1 },
            matches: [
              { ts: String(Date.parse("2026-11-16T15:00:00Z") / 1000), text: "<@USAM> can you send the quiz copy?", channel: { id: "D1", is_im: true }, permalink: "https://x/p1" },
              { ts: String(Date.parse("2026-11-16T16:00:00Z") / 1000), text: "reviewed ss feedback", channel: { id: "C1", name: "web" } },
              { ts: String(Date.parse("2026-11-12T16:00:00Z") / 1000), text: "too old", channel: { id: "C1", name: "web" } },
            ],
          },
        }
      : { ok: true, user: { real_name: "Sam Rivera" } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const out = await alexSlack({ config, env: { SLACK_USER_TOKEN: "xoxp", SLACK_BOT_TOKEN: "xoxb" }, fetchImpl, since: new Date("2026-11-16T06:00:00Z") });
  assert.equal(new URL(urls[0]).searchParams.get("query"), "from:<@UALEX> after:2026-11-15");
  assert.deepEqual(out.messages.map((m) => [m.where, m.text]), [
    ["a DM", "@Sam Rivera can you send the quiz copy?"],
    ["#web", "reviewed ss feedback"],
  ]);
  assert.ok(!JSON.stringify(out).match(/U(SAM|ALEX)|D1|C1/), "no Slack id kept");
  assert.equal(await alexSlack({ config, env: {}, since: new Date() }), null, "no user token: not read, and the page says how to add one");
});

test("the morning draft is written once a day and never over today's", async () => {
  const store = { backend: { get: async () => ({ dateKey: "2026-11-17" }) } };
  const out = await morningStandup({ store, config, env: { ANTHROPIC_API_KEY: "k" }, now, write: async () => assert.fail("should not write") });
  assert.deepEqual(out, { written: false, reason: "already written today" });
  const fresh = { backend: { get: async () => ({ dateKey: "2026-11-16" }) } };
  assert.deepEqual(await morningStandup({ store: fresh, config, env: { ANTHROPIC_API_KEY: "k" }, now, write: async () => ({ text: "x" }) }), { written: true });
});

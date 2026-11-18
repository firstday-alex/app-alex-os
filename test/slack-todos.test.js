// Slack to-dos for Today's moves: mentions of Alex (not from Alex) as asks, his open
// reminders and saved messages; a missing scope empties one list with a note; done items
// stay hidden; no Slack id is in what the page gets except the reminder id it needs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { slackTodos, completeReminder, todoKey } from "../src/collectors/slack-todos.js";

const config = { system: { http: { maxAttempts: 1 } } };
const now = new Date("2026-11-18T15:00:00Z"); // a Wednesday
const ts = (iso) => String(Date.parse(iso) / 1000);

function slack({ starsScope = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const method = u.pathname.split("/").pop();
    calls.push({ method, params: Object.fromEntries(u.searchParams), body: init.body ? JSON.parse(init.body) : null });
    const reply = {
      "auth.test": { ok: true, user_id: "UALEX", user: "alex" },
      "users.info": { ok: true, user: { real_name: u.searchParams.get("user") === "UBLAKE" ? "Blake Tucker" : "Alex Turney" } },
      "search.messages": { ok: true, messages: { matches: [
        { ts: ts("2026-11-17T16:00:00Z"), user: "UBLAKE", text: "<@UALEX> can you sign off the shipping test options?", channel: { id: "C1", name: "ecomm-team" }, permalink: "https://x/p1" },
        { ts: ts("2026-11-10T16:00:00Z"), user: "UBLAKE", text: "<@UALEX> old one", channel: { id: "C1", name: "ecomm-team" }, permalink: "https://x/p0" },
      ] } },
      "reminders.list": { ok: true, reminders: [
        { id: "Rm1", user: "UALEX", text: "Send TapCart proposal to Drew", time: Number(ts("2026-11-18T17:00:00Z")), complete_ts: 0 },
        { id: "Rm2", user: "UALEX", text: "Done already", time: 1, complete_ts: 5 },
      ] },
      "stars.list": starsScope ? { ok: true, items: [{ type: "message", channel: "C2", date_create: Number(ts("2026-11-16T12:00:00Z")), message: { user: "UBLAKE", text: "PDP copy draft", ts: "1", permalink: "https://x/p2" } }] } : { ok: false, error: "missing_scope" },
      "reminders.complete": { ok: true },
      "slackLists.items.list": { ok: true, list: { title: "Alex to-dos" }, items: [
        { id: "Rec1", date_created: 1, fields: [{ column_id: "Col1", text: "Draft Q1 rock list" }, { column_id: "Col2", checkbox: [false] }, { column_id: "Col3", date: ["2026-11-20"] }, { column_id: "Col4", user: ["UBLAKE"] }] },
        { id: "Rec2", date_created: 1, fields: [{ column_id: "Col1", text: "Already ticked" }, { column_id: "Col2", checkbox: [true] }] },
      ] },
    }[method];
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

test("asks from the last two working days, open reminders and saved messages, as plain text with names", async () => {
  const { fetchImpl, calls } = slack();
  const out = await slackTodos({ config, env: { SLACK_USER_TOKEN: "xoxp-1" }, fetchImpl, now });
  assert.deepEqual(out.asks.map((a) => [a.from, a.where, a.text]), [["Blake Tucker", "#ecomm-team", "@Alex Turney can you sign off the shipping test options?"]]);
  assert.deepEqual(out.reminders.map((r) => [r.text, r.reminderId]), [["Send TapCart proposal to Drew", "Rm1"]]);
  assert.deepEqual(out.saved.map((s) => [s.from, s.text]), [["Blake Tucker", "PDP copy draft"]]);
  assert.match(calls.find((c) => c.method === "search.messages").params.query, /^<@UALEX> -from:<@UALEX> after:/);
  const page = JSON.stringify({ asks: out.asks, saved: out.saved });
  assert.ok(!/UALEX|UBLAKE|C1|C2/.test(page), "no Slack id in asks or saved");
});

test("a missing scope empties one list with a note; done items stay hidden; Done completes a reminder", async () => {
  const { fetchImpl } = slack({ starsScope: false });
  const done = new Set([todoKey("reminder", "Rm1")]);
  const out = await slackTodos({ config, env: { SLACK_USER_TOKEN: "xoxp-1" }, fetchImpl, now, done });
  assert.equal(out.saved.length, 0);
  assert.equal(out.reminders.length, 0, "marked done here");
  assert.equal(out.asks.length, 1, "the other lists still read");
  assert.match(out.notes.join(" "), /stars:read/);
  await assert.rejects(slackTodos({ config, env: { SLACK_USER_TOKEN: "xoxb-bot" }, fetchImpl, now }), /xoxp-/);
  const s = slack();
  assert.deepEqual(await completeReminder({ config, env: { SLACK_USER_TOKEN: "xoxp-1" }, fetchImpl: s.fetchImpl, reminderId: "Rm1" }), { completed: true });
  assert.deepEqual(s.calls[0], { method: "reminders.complete", params: {}, body: { reminder: "Rm1" } });
});

test("a Slack List named in config: open rows with title, due date and owner; ticked rows left out", async () => {
  const { fetchImpl, calls } = slack();
  const out = await slackTodos({ config: { ...config, system: { ...config.system, slack: { todoLists: ["F0LIST1"] } } }, env: { SLACK_USER_TOKEN: "xoxp-1" }, fetchImpl, now });
  assert.deepEqual(out.lists.map((l) => [l.list, l.text, l.due, l.owner]), [["Alex to-dos", "Draft Q1 rock list", "2026-11-20", "Blake Tucker"]]);
  assert.equal(calls.find((c) => c.method === "slackLists.items.list").params.list_id, "F0LIST1");
});

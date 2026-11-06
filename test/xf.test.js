// Cross-functional mentions: only people outside the team, only when aimed at the team,
// and no Slack id ever reaches the output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchXf, namedText, xfFromClickUp, xfFromMessages, xfSince } from "../src/collectors/xf.js";

const config = {
  system: { timezone: "America/Chicago", schedule: { workingWeekdays: [1, 2, 3, 4, 5] }, http: { maxAttempts: 1 }, slack: { standup: { channelId: "CSTAND" }, xf: {} } },
  people: {
    alex: { name: "Alex Turney", clickupUserId: "1", slackUserId: "UALEX" },
    team: [
      { name: "Robson Lopes", clickupUserId: "2" },
      { name: "Blake Tucker", clickupUserId: "3" },
    ],
  },
};

test("the window starts at local midnight of the previous working day", () => {
  assert.equal(xfSince(new Date("2026-11-06T14:00:00Z"), config).toISOString(), "2026-11-05T06:00:00.000Z");
  assert.equal(xfSince(new Date("2026-11-09T14:00:00Z"), config).toISOString(), "2026-11-06T06:00:00.000Z", "Monday reaches back to Friday");
});

test("mentions become names, never ids", () => {
  const text = namedText("<@UROB> can you check <@UX|old name>?", (id) => ({ UROB: "Robson Lopes" })[id]);
  assert.equal(text, "@Robson Lopes can you check @someone?");
});

test("a Slack message counts only from outside the team, aimed at the team", () => {
  const teamIds = new Map([["UALEX", "Alex Turney"], ["UROB", "Robson Lopes"]]);
  const names = { UALEX: "Alex Turney", UROB: "Robson Lopes", USAM: "Sam Rivera", UPAT: "Pat Kim" };
  const nameOfId = (id) => names[id] ?? null;
  const messages = [
    { ts: "1762430000.000100", user: "USAM", text: "<@UROB> can the bundle page carry the holiday offer?" },
    { ts: "1762430001.000100", user: "UROB", text: "<@UALEX> done" },
    { ts: "1762430002.000100", user: "UPAT", text: "lunch?" },
    { ts: "1762430003.000100", user: "UPAT", text: "great work <!subteam^SWEB>" },
    { ts: "1762430004.000100", user: "UPAT", thread_ts: "1762420000.000000", text: "this looks great" },
    { ts: "1762430005.000100", bot_id: "B1", user: "UBOT", text: "<@UROB> reminder" },
  ];
  const parents = new Map([["1762420000.000000", "UALEX"]]);
  const out = xfFromMessages(messages, {
    channel: { id: "C1", name: "marketing" },
    teamIds,
    teamGroupIds: ["SWEB"],
    nameOfId,
    parents,
    permalink: (c, ts) => `https://x.slack.com/archives/${c}/p${ts.replace(".", "")}`,
  });
  assert.deepEqual(out.map((i) => [i.from, i.to, i.how]), [
    ["Sam Rivera", ["Robson Lopes"], "mentioned"],
    ["Pat Kim", ["the team"], "mentioned the team"],
    ["Pat Kim", ["Alex Turney"], "replied in thread"],
  ]);
  assert.equal(out[0].where, "#marketing");
  assert.equal(out[0].url, "https://x.slack.com/archives/C1/p1762430000000100");
  assert.ok(!JSON.stringify(out).match(/U(SAM|ROB|ALEX|PAT)\b/), "no Slack id in the output");
});

test("a ClickUp comment counts when someone off the roster left it in the window", () => {
  const since = new Date("2026-11-05T06:00:00Z");
  const roster = [config.people.alex, ...config.people.team];
  const at = Date.parse("2026-11-05T15:00:00Z");
  const tasks = [
    { id: "a", name: "Fix cart", url: "https://app.clickup.com/t/a", assignees: [{ username: "Blake Tucker" }], lastComment: { user: "Sam Rivera", userId: "99", date: at, text: "Can we ship Friday?" } },
    { id: "b", name: "Teammate", lastComment: { user: "Robson Lopes", userId: "2", date: at, text: "on it" } },
    { id: "c", name: "Old", lastComment: { user: "Sam Rivera", userId: "99", date: Date.parse("2026-11-01T00:00:00Z"), text: "old" } },
  ];
  const out = xfFromClickUp(tasks, { roster, since });
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].from, out[0].to, out[0].where, out[0].url], ["Sam Rivera", ["Blake Tucker"], "ClickUp: Fix cart", "https://app.clickup.com/t/a"]);
});

test("without the scope to list channels, Slack is skipped with how to fix it, and ClickUp still reads", async () => {
  const fetchImpl = async (url) => {
    const method = new URL(url).pathname.split("/").pop();
    const body = method === "auth.test" ? { ok: true, url: "https://x.slack.com/" } : { ok: false, error: "missing_scope" };
    return { status: 200, headers: new Headers(), text: async () => JSON.stringify(body) };
  };
  const report = { detail: { clickup: { tasks: [{ id: "a", name: "Fix cart", lastComment: { user: "Sam Rivera", userId: "99", date: Date.parse("2026-11-05T15:00:00Z"), text: "?" } }] } } };
  const out = await fetchXf({ config, token: "xoxb-test", fetchImpl, now: new Date("2026-11-06T14:00:00Z"), report });
  assert.equal(out.items.length, 1);
  assert.match(out.notes[0], /channels:read and groups:read/);
});

test("with no Slack token, the note says so", async () => {
  const out = await fetchXf({ config, token: undefined, now: new Date("2026-11-06T14:00:00Z") });
  assert.deepEqual(out.items, []);
  assert.match(out.notes[0], /SLACK_BOT_TOKEN/);
});

// Stand-ups: both of the channel's spellings parse, the reminder template is not a post,
// a poster is matched to the roster by name, and no Slack id comes out the other end.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStandups, matchPerson, parseStandup, slackToText } from "../src/collectors/standup.js";

const roster = [{ name: "Alex Turney" }, { name: "Akansha Gupta" }, { name: "Cristobal Alanis" }, { name: "Robson Lopes" }];

test("colon inside or outside the backticks, items split on pipes, an empty blocker is none", () => {
  const a = parseStandup("`Yesterday:` Checkout card fix live | FBB V4 demo with <@U09KFSKDCPQ|Robson Lopes>\n`Today:` Checkout workshop | Ship the tag fix\n`Blockers:`");
  assert.deepEqual(a, { yesterday: ["Checkout card fix live", "FBB V4 demo with @Robson Lopes"], today: ["Checkout workshop", "Ship the tag fix"], blockers: [] });
  const b = parseStandup("`Yesterday`: family box builder\n`Today`:  wraped up family box builder + home hero cta\n`Blockers`: none");
  assert.deepEqual(b, { yesterday: ["family box builder"], today: ["wraped up family box builder + home hero cta"], blockers: [] });
});

test("bullet lines under a heading are items, and a real blocker is kept", () => {
  const p = parseStandup("Yesterday:\n• shipped the PDP\n• fixed QA notes\nToday: deploy\nBlockers: waiting on Clarity admin access");
  assert.deepEqual(p.yesterday, ["shipped the PDP", "fixed QA notes"]);
  assert.deepEqual(p.blockers, ["waiting on Clarity admin access"]);
});

test("the reminder template and ordinary messages are not stand-ups", () => {
  assert.equal(parseStandup("Reminder to post daily standup.\n`Yesterday`:\n`Today`:\n`Blockers`:"), null);
  assert.equal(parseStandup("FYI looks like workshop meeting got moved to today"), null);
  assert.equal(parseStandup("today we should talk about the agenda"), null);
});

test("links and entities come out as text", () => {
  assert.equal(slackToText("see <https://x.com/a|the doc> &amp; <https://y.com>"), "see the doc & https://y.com");
});

test("a poster matches by first name, nickname or handle, never ambiguously", () => {
  assert.equal(matchPerson(["Akansha (Akky)"], roster).name, "Akansha Gupta");
  assert.equal(matchPerson(["alex.turney"], roster).name, "Alex Turney");
  assert.equal(matchPerson(["Cristobal"], roster).name, "Cristobal Alanis");
  assert.equal(matchPerson(["Alex Smith"], [...roster, { name: "Alex Smith" }]).name, "Alex Smith");
  assert.equal(matchPerson(["Alex"], [...roster, { name: "Alex Smith" }]), null);
});

test("posts group by day in the readout's timezone, latest per person, bots skipped, no ids kept", () => {
  const ts = (iso) => String(new Date(iso).getTime() / 1000);
  const messages = [
    { user: "U1", user_profile: { real_name: "Cristobal" }, ts: ts("2026-10-28T14:24:00Z"), text: "`Yesterday:` a\n`Today:` b\n`Blockers:`" },
    { user: "U1", user_profile: { real_name: "Cristobal" }, ts: ts("2026-10-28T13:00:00Z"), text: "`Yesterday:` old\n`Today:` old" },
    { user: "U2", user_profile: { real_name: "Robson Lopes" }, ts: ts("2026-10-28T03:00:00Z"), text: "`Yesterday:` late night\n`Today:` x" },
    { bot_id: "B1", ts: ts("2026-10-28T13:30:00Z"), text: "`Yesterday:` filled by a bot\n`Today:` y" },
  ];
  const nameOf = (m) => [m.user_profile?.real_name];
  const days = buildStandups(messages, { roster, timeZone: "America/Chicago", nameOf });
  assert.deepEqual(days.map((d) => d.dateKey), ["2026-10-28", "2026-10-27"]);
  assert.deepEqual(days[0].posts.map((p) => [p.name, p.yesterday[0]]), [["Cristobal Alanis", "a"]]);
  assert.equal(days[1].posts[0].name, "Robson Lopes");
  assert.ok(!JSON.stringify(days).includes("U1"));
});

test("posters with no name stay separate, labelled without their id", () => {
  const ts = String(new Date("2026-10-28T14:00:00Z").getTime() / 1000);
  const messages = [
    { user: "UA", ts, text: "`Yesterday:` a\n`Today:` b" },
    { user: "UB", ts, text: "`Yesterday:` c\n`Today:` d" },
  ];
  const [day] = buildStandups(messages, { roster, timeZone: "America/Chicago", nameOf: () => [] });
  assert.deepEqual(day.posts.map((p) => p.name).sort(), ["Unnamed poster 1", "Unnamed poster 2"]);
  assert.ok(!JSON.stringify(day).includes("UA"));
});

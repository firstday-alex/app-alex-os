// A drafted nudge scheduled as a DM from Alex: only to someone on the roster, found by
// name at send time, with the "Drafted with Claude" line, and no Slack id kept.

import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleNudge, cancelNudge, DRAFTED_LINE } from "../src/send/slack-schedule.js";

const config = { system: { http: { maxAttempts: 1 } }, people: { alex: { name: "Alex Turney" }, team: [{ name: "Akansha Gupta" }, { name: "Blake Tucker" }] } };
const now = new Date("2026-11-17T20:00:00Z");

function slack(calls) {
  return async (url, init) => {
    const u = new URL(url);
    const method = u.pathname.split("/").pop();
    calls.push({ method, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : Object.fromEntries(u.searchParams) });
    const reply = {
      "auth.test": { ok: true, user: "alex.turney" },
      "chat.scheduledMessages.list": { ok: true, scheduled_messages: [{ id: "Q123", channel_id: "DAKA", post_at: 1795100400, text: `Quick check?\n\n${DRAFTED_LINE}` }] },
      "conversations.info": { ok: true, channel: { id: "DAKA", user: "UAKA" } },
      "users.info": { ok: true, user: { real_name: "Akansha Gupta" } },
      "users.list": { ok: true, members: [{ id: "UAKA", real_name: "Akansha Gupta", profile: {} }, { id: "UBOT", is_bot: true, real_name: "Akansha Gupta" }] },
      "conversations.open": { ok: true, channel: { id: "DAKA" } },
      "chat.scheduleMessage": { ok: true, scheduled_message_id: "Q123", channel: "DAKA" },
      "chat.deleteScheduledMessage": { ok: true },
    }[method];
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("schedules as Alex, to a roster person found by name, with the Claude line, keeping no Slack id", async () => {
  const calls = [];
  const saved = [];
  const store = { backend: { set: async (k, v) => saved.push([k, v]) } };
  const out = await scheduleNudge({ config, store, token: "xoxp-1", to: "Akansha Gupta", text: "Quick check on the bundle page?", postAt: "2026-11-18T15:00:00Z", fetchImpl: slack(calls), now });
  assert.deepEqual(calls.map((c) => c.method), ["auth.test", "users.list", "conversations.open", "chat.scheduleMessage"]);
  assert.ok(calls.every((c) => c.auth === "Bearer xoxp-1"), "sent with Alex's user token");
  const sched = calls[3].body;
  assert.equal(sched.channel, "DAKA");
  assert.equal(sched.post_at, Date.parse("2026-11-18T15:00:00Z") / 1000);
  assert.equal(sched.text, `Quick check on the bundle page?\n\n${DRAFTED_LINE}`);
  assert.deepEqual(out, { to: "Akansha Gupta", from: "alex.turney", postAt: "2026-11-18T15:00:00.000Z", scheduledId: "Q123", channel: "DAKA" });
  assert.equal(saved.length, 1);
  assert.ok(!JSON.stringify(saved).match(/UAKA|DAKA|Q123/), "the record keeps no Slack id");
});

test("refuses someone off the roster, a past time, and an empty message", async () => {
  const store = { backend: { set: async () => {} } };
  const base = { config, store, token: "xoxp-1", fetchImpl: slack([]), now };
  await assert.rejects(scheduleNudge({ ...base, to: "Someone Else", text: "x", postAt: "2026-11-18T15:00:00Z" }), /roster/);
  await assert.rejects(scheduleNudge({ ...base, to: "Akansha Gupta", text: "x", postAt: "2026-11-17T19:00:00Z" }), /already passed/);
  await assert.rejects(scheduleNudge({ ...base, to: "Akansha Gupta", text: "  ", postAt: "2026-11-18T15:00:00Z" }), /Write the message/);
  await assert.rejects(scheduleNudge({ ...base, token: "", to: "Akansha Gupta", text: "x", postAt: "2026-11-18T15:00:00Z" }), /not set/);
  await assert.rejects(scheduleNudge({ ...base, token: "xoxb-bot", to: "Akansha Gupta", text: "x", postAt: "2026-11-18T15:00:00Z" }), /xoxp-/, "a bot token would send from the bot, not from Alex");
  const calls = [];
  assert.deepEqual(await cancelNudge({ config, token: "xoxp-1", channel: "DAKA", scheduledId: "Q123", fetchImpl: slack(calls) }), { cancelled: true });
  assert.equal(calls[0].method, "chat.deleteScheduledMessage");
});

test("the scheduled list comes from Slack, names the recipient, and drops the Claude line from the preview", async () => {
  const { listScheduled } = await import("../src/send/slack-schedule.js");
  const out = await listScheduled({ config, token: "xoxp-1", fetchImpl: slack([]) });
  assert.equal(out.from, "alex.turney");
  assert.deepEqual(out.items.map((i) => [i.to, i.text, i.scheduledId]), [["Akansha Gupta", "Quick check?", "Q123"]]);
});

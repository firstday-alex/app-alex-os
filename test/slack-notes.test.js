// Saving to the daily notes from Slack: Alex only, anyone else gets silence, the reply
// says it is Claude, and no Slack id is stored.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createBackend } from "../src/lib/storage.js";
import { notesForSpeech } from "../src/store/day-notes.js";
import { handleNoteCommand, handleSaveShortcut, messageLink } from "../src/send/slack-notes.js";

const config = {
  system: { timezone: "America/Chicago", schedule: { workingWeekdays: [1, 2, 3, 4, 5] }, http: { maxAttempts: 1 } },
  people: { alex: { name: "Alex Turney", slackUserId: "UALEX" } },
};
const now = new Date("2026-11-06T15:00:00Z");

const shortcut = (user) => ({
  type: "message_action",
  callback_id: "save_day_note",
  user: { id: user },
  team: { domain: "firstday" },
  channel: { id: "C123", name: "marketing" },
  message: { ts: "1762441000.000200", user: "USAM", user_profile: { real_name: "Sam Rivera" }, text: "<@UROB|robson> can bundles carry the holiday offer?" },
  response_url: "https://hooks.slack.com/x",
});

test("the shortcut saves who said what, where, with a link, and replies as Claude", async () => {
  const backend = await createBackend({ mode: "memory" });
  const body = await handleSaveShortcut({ payload: shortcut("UALEX"), config, backend, now });
  assert.equal(body.response_type, "ephemeral");
  assert.match(body.text, /^Posted by Claude/);
  const [note] = await notesForSpeech(backend, { now, config });
  assert.equal(note.text, 'Sam Rivera in #marketing: "@robson can bundles carry the holiday offer?"');
  assert.equal(note.source.link, "https://firstday.slack.com/archives/C123/p1762441000000200");
  assert.ok(!JSON.stringify(note).match(/U(SAM|ROB|ALEX)\b/), "no Slack id stored");
});

test("anyone but Alex gets no reply and nothing is saved", async () => {
  const backend = await createBackend({ mode: "memory" });
  assert.equal(await handleSaveShortcut({ payload: shortcut("UOTHER"), config, backend, now }), null);
  const params = new URLSearchParams({ command: "/note", user_id: "UOTHER", text: "hi" });
  assert.equal(await handleNoteCommand({ params, config, backend, now }), null);
  assert.equal((await notesForSpeech(backend, { now, config })).length, 0);
});

test("/note saves the text; an empty one explains how to use it", async () => {
  const backend = await createBackend({ mode: "memory" });
  const empty = await handleNoteCommand({ params: new URLSearchParams({ user_id: "UALEX", text: " " }), config, backend, now });
  assert.match(empty.text, /\/tpnote Sam asked/);
  await handleNoteCommand({ params: new URLSearchParams({ user_id: "UALEX", text: "Ops wants the bundle SKU list by Tue", channel_name: "directmessage" }), config, backend, now });
  const [note] = await notesForSpeech(backend, { now, config });
  assert.equal(note.text, "Ops wants the bundle SKU list by Tue");
  assert.deepEqual(note.source, { via: "slack-command", channel: null });
});

test("a thread reply links into its thread", () => {
  const p = shortcut("UALEX");
  p.message.thread_ts = "1762440000.000100";
  assert.equal(messageLink(p), "https://firstday.slack.com/archives/C123/p1762441000000200?thread_ts=1762440000.000100&cid=C123");
});

test("the log says whether it was Alex and why not, never the id", async () => {
  const { whoFields } = await import("../src/send/slack-notes.js");
  const cfg = { people: { alex: { slackUserId: "UALEX" } } };
  assert.deepEqual(whoFields("UALEX", cfg), { isAlex: true, alexIdSet: true, userIdKind: "U", enterprise: false });
  assert.deepEqual(whoFields("W123", cfg, "E1"), { isAlex: false, alexIdSet: true, userIdKind: "W", enterprise: true });
  assert.ok(!JSON.stringify(whoFields("W123", cfg)).includes("W123"));
});

test("a bare mention is saved as the person's name, looked up once, never as an id", async () => {
  const backend = await createBackend({ mode: "memory" });
  const lookups = [];
  const fetchImpl = async (url) => {
    const user = new URL(url).searchParams.get("user");
    lookups.push(user);
    const body = user === "UGONE" ? { ok: false, error: "user_not_found" } : { ok: true, user: { real_name: { UAND: "Andrew Smith", USAM: "Sam Rivera" }[user] } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const payload = shortcut("UALEX");
  payload.message = { ...payload.message, user_profile: undefined, text: "<@UAND> and <@UAND> can you help? cc <@UGONE>" };
  await handleSaveShortcut({ payload, config, backend, token: "xoxb-test", fetchImpl, now });
  const [note] = await notesForSpeech(backend, { now, config });
  assert.equal(note.text, 'Sam Rivera in #marketing: "@Andrew Smith and @Andrew Smith can you help? cc @someone"');
  assert.deepEqual(lookups.filter((u) => u === "UAND").length, 1, "each person looked up once");
  assert.ok(!JSON.stringify(note).match(/U(AND|GONE|SAM)\b/), "no Slack id stored");
});

// "Create ClickUp ticket" from a Slack thread: the thread, its files and the draft checked
// against the list's live fields before anything is written.

import { test } from "node:test";
import assert from "node:assert/strict";
import { threadOf, checkDraft, memberByName, descriptionOf, ticketFromThread, threadKey } from "../src/send/clickup-ticket.js";

const FIELDS = [
  { id: "f-type", name: "Type of Request", type: "drop_down", type_config: { options: [{ id: "o-content", name: "Content Update" }, { id: "o-ab", name: "A/B Test Idea" }] } },
  { id: "f-cat", name: "Task Category", type: "drop_down", type_config: { options: [{ id: "o-design", name: "Design" }] } },
  { id: "f-rock", name: "ROCK", type: "drop_down", type_config: { options: [{ id: "o-bau", name: "BAU" }] } },
  { id: "f-tactic", name: "TACTIC", type: "drop_down", type_config: { options: [{ id: "o-tbau", name: "BAU" }] } },
  { id: "f-ready", name: "Ready to Start?", type: "drop_down", type_config: { options: [{ id: "o-new", name: "New Request" }, { id: "o-ready", name: "Ready" }] } },
  { id: "f-req", name: "Requestor", type: "users" },
  { id: "f-url", name: "Design Reference URL", type: "url" },
  { id: "f-target", name: "🧪 Test Targeting", type: "short_text" },
];
const ctx = { list: { id: "L1", name: "Site Backlog", statuses: ["backlog", "qa"] }, fields: FIELDS, members: [{ id: "11", name: "Tom Murphy" }, { id: "12", name: "Alex Turney" }], tags: ["outside-request", "bug"] };

test("the thread is the parent of a reply, or the message itself", () => {
  assert.deepEqual(threadOf({ channel: { id: "C1" }, message: { ts: "2.0", thread_ts: "1.0" } }), { channel: "C1", ts: "1.0" });
  assert.deepEqual(threadOf({ channel: { id: "C1" }, message: { ts: "2.0" } }), { channel: "C1", ts: "2.0" });
  assert.equal(threadKey("C1", "1.0").length, 16);
});

test("people are matched by full name, or a first name only one member has", () => {
  assert.equal(memberByName(ctx.members, "tom murphy").id, "11");
  assert.equal(memberByName(ctx.members, "Tom").id, "11");
  assert.equal(memberByName(ctx.members, "Tom Hanks"), null);
});

test("the draft is checked against the list: only real options, members, tags and links from the thread; Ready to Start? is always New Request", () => {
  const draft = {
    name: "  Update   badging ",
    fields: {
      typeOfRequest: "content update", taskCategory: "Design", rock: "BAU", tactic: "BAU", experimentType: "Made Up",
      experimentHypothesis: null, testingRequirements: null, deploymentNotes: null, testTargeting: "Homepage",
      designReferenceUrl: "https://figma.com/file/invented", requestor: "Tom Murphy", collaborators: ["Nobody Here"],
      priority: "high", tags: ["outside-request", "brand-new-tag"], dueDate: "2020-01-01",
    },
  };
  const c = checkDraft(draft, ctx, { threadText: "please update the badge", today: "2026-11-19" });
  assert.equal(c.name, "Update badging");
  const by = Object.fromEntries(c.set.map((s) => [s.name, s.value]));
  assert.equal(by["Type of Request"], "o-content");
  assert.equal(by["Ready to Start?"], "o-new");
  assert.equal(by["🧪 Test Targeting"], "Homepage");
  assert.deepEqual(by.Requestor, { add: [11], rem: [] });
  assert.equal(by["Design Reference URL"], undefined, "a link not in the thread is dropped");
  assert.deepEqual(c.tags, ["outside-request"]);
  assert.equal(c.priority, 2);
  assert.equal(c.dueDate, null);
  for (const why of [/Experiment Type/, /Design Reference URL/, /Nobody Here/, /brand-new-tag/, /Due date/]) assert.ok(c.dropped.some((d) => why.test(d)), String(why));
});

test("the description says Claude made it, links the thread and shows the files", () => {
  const d = descriptionOf({ description: "## Request\nUpdate it.", openQuestions: ["Which pages?"] }, {
    people: ["Tom Murphy"], date: "Nov 18", link: "https://x.slack.com/archives/C1/p1",
    files: [{ name: "a.png", mimetype: "image/png", uploaded: { url: "https://cu/a.png" } }, { name: "big.mov", mimetype: "video/quicktime", skipped: "over 25 MB" }],
  });
  assert.match(d, /^_Created by Claude from a Slack thread with Tom Murphy \(Nov 18\)/);
  assert.match(d, /## Open questions before starting\n- Which pages\?/);
  assert.match(d, /\[The Slack thread\]\(https:\/\/x\.slack\.com/);
  assert.match(d, /!\[a\.png\]\(https:\/\/cu\/a\.png\)/);
  assert.match(d, /big\.mov \(not copied: over 25 MB\)/);
});

test("end to end: reads the thread, copies its files, creates the task, sets each field, and a second run finds it", async () => {
  const calls = [];
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    calls.push(`${opts.method ?? "GET"} ${u.replace(/\?.*/, "")}`);
    if (u.includes("conversations.replies")) return json({ ok: true, messages: [
      { ts: "1700000000.0001", user: "U1", text: "Can we update the 1,000,000 badge to 1,500,000?", files: [{ name: "badge.png", mimetype: "image/png", size: 4, url_private_download: "https://files.slack.com/badge.png" }] },
      { ts: "1700000100.0001", user: "U2", text: "<@U1> yes, BAU" },
    ] });
    if (u.includes("users.info")) return json({ ok: true, user: { real_name: u.includes("U1") ? "Tom Murphy" : "Alex Turney" } });
    if (u.startsWith("https://files.slack.com")) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "image/png" } });
    if (u.endsWith("/list/L1")) return json({ id: "L1", name: "Site Backlog", space: { id: "S1" }, statuses: [{ status: "backlog" }] });
    if (u.endsWith("/list/L1/field")) return json({ fields: FIELDS });
    if (u.endsWith("/list/L1/member")) return json({ members: [{ id: 11, username: "Tom Murphy" }] });
    if (u.endsWith("/space/S1/tag")) return json({ tags: [{ name: "outside-request" }] });
    if (u.endsWith("/list/L1/task")) return json({ id: "T9", url: "https://app.clickup.com/t/T9" });
    if (u.includes("/attachment")) return json({ url: "https://cu/badge.png" });
    return json({});
  };
  const mem = new Map();
  const store = { backend: { get: async (k) => mem.get(k) ?? null, set: async (k, v) => mem.set(k, v) } };
  const config = { system: { timezone: "America/Chicago", http: { maxAttempts: 1 } }, clickup: { apiBase: "https://api.clickup.com/api/v2", backlogListId: "L1" } };
  let sawImage = false;
  const askImpl = async ({ messages }) => {
    sawImage = messages[0].content.some((b) => b.type === "image");
    return { refused: false, parsed: { name: "Update 1,000,000 badging to 1,500,000", description: "## Request\nUpdate the badge.", openQuestions: ["Where is the original file?"], fields: { typeOfRequest: "Content Update", taskCategory: "Design", rock: "BAU", tactic: "BAU", experimentType: null, experimentHypothesis: null, testingRequirements: null, deploymentNotes: null, testTargeting: null, designReferenceUrl: null, requestor: "Tom Murphy", collaborators: [], priority: null, tags: ["outside-request"], dueDate: null } } };
  };
  const env = { CLICKUP_TOKEN: "pk", SLACK_USER_TOKEN: "xoxp-1" };
  const out = await ticketFromThread({ channel: "C1", ts: "1700000000.0001", link: "https://x.slack.com/archives/C1/p1", config, env, store, fetchImpl, askImpl, now: new Date("2026-11-19T15:00:00Z") });
  assert.ok(sawImage, "the screenshot goes to Claude");
  assert.match(out.text, /Made <https:\/\/app\.clickup\.com\/t\/T9\|Update 1,000,000 badging to 1,500,000> in Site Backlog/);
  assert.match(out.text, /Ready to Start\?: New Request/);
  assert.match(out.text, /Requestor: Tom Murphy/);
  assert.match(out.text, /1 of 1 attached/);
  assert.ok(calls.includes("POST https://api.clickup.com/api/v2/task/T9/attachment"));
  assert.ok(calls.includes("PUT https://api.clickup.com/api/v2/task/T9"), "the images go into the description");
  assert.equal(calls.filter((c) => c.startsWith("PUT")).length, 1, "only the new task is ever edited");
  assert.ok([...mem.keys()].some((k) => k.startsWith("clickup/writes/")));
  assert.ok(![...JSON.stringify([...mem.values()])].join("").includes("U1"), "no Slack id is stored");

  const again = await ticketFromThread({ channel: "C1", ts: "1700000000.0001", config, env, store, fetchImpl, askImpl });
  assert.match(again.text, /already a ticket/);
});

test("/ticket takes a pasted message link: the thread's root, from a reply's thread_ts too", async () => {
  const { threadFromLink } = await import("../src/send/clickup-ticket.js");
  assert.deepEqual(threadFromLink("<https://firstday.slack.com/archives/C0123ABC/p1763500000123456>"), { channel: "C0123ABC", ts: "1763500000.123456", link: "https://firstday.slack.com/archives/C0123ABC/p1763500000123456" });
  assert.equal(threadFromLink("https://firstday.slack.com/archives/C0123ABC/p1763500999000001?thread_ts=1763500000.123456&cid=C0123ABC").ts, "1763500000.123456");
  assert.equal(threadFromLink("make a ticket"), null);
  assert.equal(threadFromLink("https://evil.example.com/archives/C1/p1763500000123456"), null);
});

test("/ticket is Alex's alone, explains itself without a link, and hands off with one", async () => {
  const { handleTicketCommand } = await import("../netlify/functions/slack-command.mjs");
  const config = { people: { alex: { slackUserId: "UALEX" } } };
  const handed = [];
  const handOff = async (b) => handed.push(b);
  const p = (o) => new URLSearchParams({ command: "/ticket", ...o });
  assert.equal(await handleTicketCommand({ params: p({ user_id: "UOTHER", text: "https://x.slack.com/archives/C1/p1763500000123456" }), config, handOff }), null);
  assert.match((await handleTicketCommand({ params: p({ user_id: "UALEX", text: "" }), config, handOff })).text, /Copy link/);
  const ok = await handleTicketCommand({ params: p({ user_id: "UALEX", text: "https://x.slack.com/archives/C1/p1763500000123456", response_url: "https://hooks.slack.com/r" }), config, handOff });
  assert.match(ok.text, /Reading the thread/);
  assert.deepEqual(handed, [{ channel: "C1", ts: "1763500000.123456", link: "https://x.slack.com/archives/C1/p1763500000123456", responseUrl: "https://hooks.slack.com/r" }]);
});

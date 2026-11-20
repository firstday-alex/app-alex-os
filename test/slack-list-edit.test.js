// Quick actions on an ECOM Slack List row: the row found again by its key, the cell by its
// column name, dates from today on, assignee from the roster, complete ticks it; no Slack id recorded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { editListItem, columnsOf } from "../src/send/slack-list-edit.js";
import { todoKey } from "../src/collectors/slack-todos.js";

const config = { system: { timezone: "America/Chicago", http: { maxAttempts: 1 }, slack: { todoLists: ["F0LIST"] } }, people: { alex: { name: "Alex Turney" }, team: [{ name: "Robson Lopes" }] } };
const now = new Date("2026-11-20T18:00:00Z");
const schema = [{ id: "ColName", name: "Name", type: "text" }, { id: "ColDone", key: "todo_completed", type: "todo_completed" }, { id: "ColCheck", name: "Check-In Date", type: "date" }, { id: "ColWho", name: "Assignee", type: "user" }, { id: "ColDue", name: "Due Date", type: "date" }];
const key = todoKey("list", "F0LIST:Rec1");

function slack(calls, { scope = true } = {}) {
  return async (url, init) => {
    const u = new URL(url);
    const method = u.pathname.split("/").pop();
    const body = init.body ? JSON.parse(init.body) : Object.fromEntries(u.searchParams);
    calls.push({ method, body });
    const reply = {
      "slackLists.items.list": { ok: true, list: { title: "ECOM", list_metadata: { schema } }, items: [{ id: "Rec1", fields: [] }] },
      "users.list": { ok: true, members: [{ id: "UROB", real_name: "Robson Lopes" }] },
      "slackLists.items.update": scope ? { ok: true } : { ok: false, error: "missing_scope" },
    }[method];
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("columns by name and type: Due Date and Check-In Date apart, the person column, the done tick", () => {
  const c = columnsOf(schema);
  assert.deepEqual([c.due.id, c.checkIn.id, c.assignee.id, c.complete.id], ["ColDue", "ColCheck", "ColWho", "ColDone"]);
});

test("each quick action writes one cell on the right row; the record keeps no Slack id", async () => {
  const saved = [];
  const store = { backend: { set: async (k, v) => saved.push(v) } };
  const env = { SLACK_USER_TOKEN: "xoxp-1" };
  const run = async (action, value) => {
    const calls = [];
    await editListItem({ config, env, store, key, action, value, fetchImpl: slack(calls), now });
    return calls.find((c) => c.method === "slackLists.items.update").body;
  };
  assert.deepEqual(await run("due", "2026-11-25"), { list_id: "F0LIST", cells: [{ row_id: "Rec1", column_id: "ColDue", date: ["2026-11-25"] }] });
  assert.deepEqual((await run("checkIn", "2026-11-21")).cells[0], { row_id: "Rec1", column_id: "ColCheck", date: ["2026-11-21"] });
  assert.deepEqual((await run("assignee", "Robson Lopes")).cells[0], { row_id: "Rec1", column_id: "ColWho", user: ["UROB"] });
  assert.deepEqual((await run("complete")).cells[0], { row_id: "Rec1", column_id: "ColDone", checkbox: true });
  assert.equal(saved.length, 4);
  assert.ok(!/UROB|Rec1|F0LIST/.test(JSON.stringify(saved)));
});

test("refuses a past date, someone off the roster, an unknown row, and says which scope is missing", async () => {
  const base = { config, env: { SLACK_USER_TOKEN: "xoxp-1" }, now };
  await assert.rejects(editListItem({ ...base, key, action: "due", value: "2026-11-19", fetchImpl: slack([]) }), /from today/);
  await assert.rejects(editListItem({ ...base, key, action: "assignee", value: "Someone Else", fetchImpl: slack([]) }), /roster/);
  await assert.rejects(editListItem({ ...base, key: todoKey("list", "F0LIST:Gone"), action: "complete", fetchImpl: slack([]) }), /no longer on the list/);
  await assert.rejects(editListItem({ ...base, key, action: "complete", fetchImpl: slack([], { scope: false }) }), /lists:write/);
});

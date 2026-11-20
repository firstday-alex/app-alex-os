// Quick actions on a row of Alex's ECOM Slack List, from From Slack in Today's moves.
// Alex, 2026-11-20: "can you read the fields and give me quick actions for nudge, change
// date, change check-in date, or assignee?" and "differentiate between remove from list and
// dismiss". Only when Alex presses the button, only on lists named in
// system.slack.todoLists, only these cells:
//
//   due       the column named "Due…"            a date, today or later
//   checkIn   the column named "Check-In…"       a date, today or later
//   assignee  the first person column            someone on the roster, found in Slack by name
//   complete  ticks the row done in Slack, so it leaves the open list (it is not deleted)
//
// Written with Alex's user token (SLACK_USER_TOKEN, scope lists:write). The row is found again
// by its key (a hash), so the page never holds a Slack id; nothing but the key, the action and
// the value (a date or a roster name) is recorded, under slack/list-writes/.

import { call, todoKey, SlackTodoError } from "../collectors/slack-todos.js";

const norm = (s) => String(s ?? "").trim().toLowerCase();
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The columns that matter, by name and type, from the list's schema. */
export function columnsOf(schema = []) {
  const name = (c) => String(c.name ?? "");
  const type = (c) => String(c.type ?? "").toLowerCase();
  const isDate = (c) => type(c) === "date" || /date/i.test(name(c));
  return {
    due: schema.find((c) => isDate(c) && /due/i.test(name(c))) ?? null,
    checkIn: schema.find((c) => isDate(c) && /check.?in/i.test(name(c))) ?? null,
    assignee: schema.find((c) => type(c) === "user") ?? schema.find((c) => /assignee|owner/i.test(name(c))) ?? null,
    complete: schema.find((c) => type(c) === "todo_completed" || c.key === "todo_completed") ?? schema.find((c) => type(c) === "checkbox") ?? null,
  };
}

async function slackIdOf(name, ctx) {
  let cursor = "";
  const members = [];
  for (let page = 0; page < 10; page++) {
    const body = await call("users.list", { limit: "200", ...(cursor ? { cursor } : {}) }, ctx);
    members.push(...(body.members ?? []).filter((m) => !m.deleted && !m.is_bot));
    cursor = body.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  const names = (m) => [m.real_name, m.profile?.real_name, m.profile?.display_name, m.name].map(norm).filter(Boolean);
  const hits = members.filter((m) => names(m).includes(norm(name)));
  if (hits.length !== 1) throw new SlackTodoError(hits.length ? `More than one Slack member is called ${name}.` : `No Slack member is called ${name}.`, 404);
  return hits[0].id;
}

export async function editListItem({ config, env = process.env, logger, fetchImpl, store, key, action, value, now = new Date() }) {
  const token = env.SLACK_USER_TOKEN;
  if (!token || !String(token).startsWith("xoxp-")) throw new SlackTodoError("SLACK_USER_TOKEN must be your User OAuth Token (xoxp-).", 500);
  if (!/^list:[0-9a-f]{16}$/.test(String(key ?? ""))) throw new SlackTodoError("Which row?");
  if (!["due", "checkIn", "assignee", "complete"].includes(action)) throw new SlackTodoError("Which change?");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: config.system?.timezone ?? "UTC" }).format(now);
  if ((action === "due" || action === "checkIn") && (!DAY.test(String(value)) || value < today)) throw new SlackTodoError("Pick a date from today on.");
  const roster = [...(config.people?.team ?? []), ...(config.people?.alex ? [config.people.alex] : [])];
  const person = action === "assignee" ? roster.find((p) => norm(p.name) === norm(value)) : null;
  if (action === "assignee" && !person) throw new SlackTodoError("Pick someone on the team roster.");

  const ctx = { token, config, logger, fetchImpl };
  for (const listId of (config.system?.slack?.todoLists ?? []).filter((x) => /^[A-Z0-9]+$/.test(String(x)))) {
    const body = await call("slackLists.items.list", { list_id: listId, include_list: "true", limit: "200" }, ctx);
    const row = (body.items ?? []).find((it) => todoKey("list", `${listId}:${it.id}`) === key);
    if (!row) continue;
    const col = columnsOf(body.list?.list_metadata?.schema ?? body.list?.schema ?? [])[action];
    if (!col) throw new SlackTodoError(`The list has no ${{ due: "Due Date", checkIn: "Check-In Date", assignee: "person", complete: "done" }[action]} column.`, 409);
    const cell = { row_id: row.id, column_id: col.id ?? col.key };
    if (action === "due" || action === "checkIn") cell.date = [value];
    else if (action === "assignee") cell.user = [await slackIdOf(person.name, ctx)];
    else cell.checkbox = true;
    try {
      await call("slackLists.items.update", { list_id: listId, cells: [cell] }, { ...ctx, post: true });
    } catch (err) {
      if (err.slackError === "missing_scope") throw new SlackTodoError("Add the lists:write user scope to change your Slack List from here, reinstall the app, and update SLACK_USER_TOKEN.", 502);
      throw err;
    }
    const record = { at: now.toISOString(), key, action, value: action === "assignee" ? person.name : action === "complete" ? true : value };
    try {
      await store?.backend?.set(`slack/list-writes/${record.at}.json`, record);
    } catch (err) {
      logger?.warn?.("slack_list.record_failed", { err });
    }
    logger?.info?.("slack_list.edited", { action });
    return { ok: true, action, value: record.value };
  }
  throw new SlackTodoError("That row is no longer on the list. Reload From Slack.", 404);
}

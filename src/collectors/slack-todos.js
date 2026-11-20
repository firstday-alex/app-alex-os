// Alex's to-dos from Slack, for Today's moves. Read with Alex's user token, live, each time
// the page asks; nothing from Slack is stored except a hash of the items Alex marked done.
//
// Only what Alex chose to come back to: no @mentions or missed conversations (Alex,
// 2026-11-19: "it should only be things I reminded myself or made into a to do").
//   reminders  Alex's own open Slack reminders (/remind, "Remind me about this").
//              Needs reminders:read; Done completes one in Slack and needs reminders:write.
//   saved      messages Alex saved for later. Needs stars:read. Slack has moved saving to
//              "Later", and the API may return nothing for it; then the page says so.
//   lists      rows of the Slack Lists named in system.slack.todoLists (slackLists.items.list,
//              lists:read): Alex's ECOM list. A row's title is its first text cell, its due
//              date the column named Due, its check-in the column named Check-In, its owner
//              its first person cell; a ticked checkbox means done.
// Slack's To-dos tab cannot be read by an app (Slack refuses app tokens), so it is not tried.
//
// Each source fails on its own: a missing scope empties that list with a note, never the rest.
// No Slack id is kept; names come from users.info at read time.

import { createHash } from "node:crypto";
import { httpJson } from "../lib/http.js";

const SLACK_API = "https://slack.com/api";

export class SlackTodoError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const SCOPE_HINT = {
  reminders: "reminders:read",
  saved: "stars:read",
  lists: "lists:read",
};

export async function call(method, params, { token, config, logger, fetchImpl, post = false }) {
  const http = config.system?.http ?? {};
  const url = post ? `${SLACK_API}/${method}` : `${SLACK_API}/${method}?${new URLSearchParams(params)}`;
  const { body } = await httpJson(url, {
    method: post ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}` },
    ...(post ? { body: params } : {}),
    logger,
    label: `slack.${method}`,
    fetchImpl,
    timeoutMs: http.timeoutMs,
    maxAttempts: Math.min(http.maxAttempts ?? 3, 3),
    backoffMsSchedule: http.backoffMsSchedule,
  });
  if (body?.ok === false) {
    const err = new SlackTodoError(`Slack said ${body.error}.`, 502);
    err.slackError = body.error;
    err.provided = body.provided ?? null; // on missing_scope Slack lists the scopes the token has
    throw err;
  }
  return body;
}

/** A stable key for an item, without keeping its Slack ids. */
export const todoKey = (kind, raw) => `${kind}:${createHash("sha1").update(String(raw)).digest("hex").slice(0, 16)}`;

/** Mentions become names; links and formatting become plain text. */
function plainText(text, nameOf) {
  return String(text ?? "")
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g, (_, id) => `@${nameOf(id) ?? "someone"}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

export async function slackTodos({ config, env = process.env, logger, fetchImpl, now = new Date(), done = new Set() }) {
  const token = env.SLACK_USER_TOKEN;
  if (!token) throw new SlackTodoError("SLACK_USER_TOKEN is not set.", 500);
  if (!String(token).startsWith("xoxp-")) throw new SlackTodoError("SLACK_USER_TOKEN must be your User OAuth Token (xoxp-).", 500);
  const ctx = { token, config, logger, fetchImpl };
  const me = await call("auth.test", {}, ctx);
  const myId = me.user_id;

  const names = new Map();
  const nameOf = (id) => names.get(id) ?? null;
  const learn = async (ids) => {
    for (const id of ids) {
      if (!id || names.has(id)) continue;
      try {
        const u = await call("users.info", { user: id }, ctx);
        names.set(id, u.user?.real_name || u.user?.profile?.real_name || u.user?.name || null);
      } catch {
        names.set(id, null);
      }
    }
  };
  const mentionIds = (text) => [...String(text ?? "").matchAll(/<@([UW][A-Z0-9]+)/g)].map((m) => m[1]);
  const notes = [];
  let scopesShown = false;
  const missing = (kind, err) => {
    if (err.slackError === "missing_scope") {
      notes.push(`Add the ${SCOPE_HINT[kind]} user scope to read ${kind === "saved" ? "saved messages" : "Slack reminders"}.`);
      // What the token in Netlify can actually do, once: tells a stale token from a missing scope.
      if (err.provided && !scopesShown) {
        scopesShown = true;
        notes.push(`The token Ecom OS is using (signed in as ${me.user ?? "unknown"}) has: ${err.provided}. If you added scopes, reinstall the app, copy the User OAuth Token again into SLACK_USER_TOKEN, and redeploy.`);
      }
    } else notes.push(`Could not read ${kind}: ${err.message}`);
    return [];
  };

  // Reminders: Alex's own, not completed.
  const reminders = await (async () => {
    const body = await call("reminders.list", {}, ctx);
    const open = (body.reminders ?? []).filter((r) => !r.complete_ts && (!r.user || r.user === myId));
    await learn([...new Set(open.flatMap((r) => mentionIds(r.text)))]);
    return open
      .map((r) => ({
        key: todoKey("reminder", r.id),
        kind: "reminder",
        reminderId: r.id, // handed to the page so Done can complete it; never stored
        text: plainText(r.text, nameOf),
        at: r.time ? new Date(r.time * 1000).toISOString() : null,
        recurring: Boolean(r.recurring),
        url: null,
      }))
      .sort((a, b) => String(a.at ?? "9").localeCompare(String(b.at ?? "9")));
  })().catch((err) => missing("reminders", err));

  // Slack To-dos (the sidebar tab) are not read: Slack refuses app tokens
  // (not_allowed_token_type, seen live 2026-11-20), so Alex keeps to-dos in his ECOM Slack
  // List instead and the call was removed. `todos` stays in the answer, always empty.
  const todos = [];

  // Saved for later.
  const saved = await (async () => {
    const body = await call("stars.list", { limit: "50" }, ctx);
    const items = (body.items ?? []).filter((i) => i.type === "message" && i.message);
    await learn([...new Set(items.flatMap((i) => [i.message.user, ...mentionIds(i.message.text)]))]);
    return items.map((i) => ({
      key: todoKey("saved", i.message.permalink ?? `${i.channel}:${i.message.ts}`),
      kind: "saved",
      from: nameOf(i.message.user) ?? "Someone",
      text: plainText(i.message.text, nameOf),
      at: i.date_create ? new Date(i.date_create * 1000).toISOString() : null,
      url: i.message.permalink ?? null,
    }));
  })().catch((err) => missing("saved", err));

  // Slack Lists Alex named in config: the open rows.
  const lists = [];
  for (const listId of (config.system?.slack?.todoLists ?? []).filter((x) => /^[A-Z0-9]+$/.test(String(x)))) {
    try {
      const body = await call("slackLists.items.list", { list_id: listId, include_list: "true", limit: "200" }, ctx);
      const title = body.list?.title ?? body.list?.name ?? "Slack list";
      // Column names, so "Due Date" is the due date and "Check-In Date" is not (Alex's ECOM
      // list has both, 2026-11-20).
      const schema = body.list?.list_metadata?.schema ?? body.list?.schema ?? [];
      const colName = new Map(schema.map((c) => [c.id ?? c.key, String(c.name ?? "")]));
      const nameOfField = (f) => colName.get(f.column_id) ?? colName.get(f.key) ?? "";
      const dateIn = (fields, test) => fields.find((f) => Array.isArray(f.date) && f.date[0] && test(nameOfField(f)))?.date[0] ?? null;
      const ticked = (f) => f.checkbox === true || (Array.isArray(f.checkbox) && f.checkbox[0] === true);
      const rows = (body.items ?? []).filter((it) => !(it.fields ?? []).some(ticked));
      // People in person cells, and anyone @mentioned in a row's text, so "<@U…>" reads as their name.
      await learn([...new Set(rows.flatMap((it) => (it.fields ?? []).flatMap((f) => [...(f.user ?? []), ...mentionIds(f.text)])))]);
      for (const it of rows) {
        const fields = it.fields ?? [];
        const textField = fields.find((f) => typeof f.text === "string" && f.text.trim() && !f.checkbox && !f.date && !f.user);
        if (!textField) continue;
        const due = dateIn(fields, (n) => /due/i.test(n)) ?? dateIn(fields, (n) => !/check/i.test(n));
        const checkIn = dateIn(fields, (n) => /check.?in/i.test(n));
        const who = fields.find((f) => Array.isArray(f.user) && f.user[0])?.user[0] ?? null;
        lists.push({
          key: todoKey("list", `${listId}:${it.id}`),
          kind: "list",
          list: String(title).slice(0, 60),
          text: plainText(textField.text, nameOf),
          due,
          checkIn,
          owner: who ? nameOf(who) : null,
          at: it.date_created ? new Date(it.date_created * 1000).toISOString() : null,
          url: null,
        });
      }
    } catch (err) {
      if (err.slackError === "missing_scope") notes.push("Add the lists:read user scope to read your Slack Lists.");
      else if (err.slackError === "list_not_found") notes.push(`A Slack List in system.slack.todoLists was not found (${listId}). Check its ID.`);
      else notes.push(`Could not read a Slack List: ${err.message}`);
    }
  }
  lists.sort((a, b) => String(a.due ?? "9999").localeCompare(String(b.due ?? "9999")));

  const keep = (list) => list.filter((i) => !done.has(i.key));
  return { todos: keep(todos), reminders: keep(reminders), saved: keep(saved), lists: keep(lists), notes, readAt: now.toISOString() };
}

/** Completes one of Alex's Slack reminders. */
export async function completeReminder({ config, env = process.env, logger, fetchImpl, reminderId }) {
  const token = env.SLACK_USER_TOKEN;
  if (!token || !String(token).startsWith("xoxp-")) throw new SlackTodoError("SLACK_USER_TOKEN must be your User OAuth Token (xoxp-).", 500);
  if (!/^[A-Z0-9]+$/i.test(String(reminderId ?? ""))) throw new SlackTodoError("Which reminder?");
  try {
    await call("reminders.complete", { reminder: reminderId }, { token, config, logger, fetchImpl, post: true });
  } catch (err) {
    if (err.slackError === "missing_scope") throw new SlackTodoError("Add the reminders:write user scope to complete Slack reminders from here.", 502);
    throw err;
  }
  return { completed: true };
}

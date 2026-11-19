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
//              lists:read). A row's title is its first text cell, its due date its first date
//              cell, its owner its first person cell; a ticked checkbox means done.
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

async function call(method, params, { token, config, logger, fetchImpl, post = false }) {
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

  // Slack To-dos (the sidebar tab that replaced Later). Slack has no public API for them;
  // this tries saved.list, the undocumented method Slack's own web app uses (Alex asked to
  // try it, 2026-11-19). Read-only. Slack may refuse a user token (not_allowed_token_type)
  // or change it without notice; then the list is empty with a note and the rest still loads.
  // Field names follow slackcli's reading of it (todo_state: saved | to_do | completed).
  const todos = await (async () => {
    const body = await call("saved.list", { filter: "todo_with_completed", limit: "50" }, ctx);
    const items = (body.saved_items ?? body.items ?? []).filter((i) => i && i.todo_state !== "completed" && (i.todo_state ?? "to_do") !== "saved");
    await learn([...new Set(items.flatMap((i) => (i.message ? [i.message.user, ...mentionIds(i.message.text)] : [])))]);
    const out = [];
    for (const i of items) {
      const channel = i.channel_id ?? i.item_id ?? i.channel ?? null;
      const ts = i.message?.ts ?? i.ts ?? null;
      let url = i.message?.permalink ?? null;
      if (!url && channel && ts) url = await call("chat.getPermalink", { channel, message_ts: ts }, ctx).then((b) => b.permalink ?? null).catch(() => null);
      const text = i.message?.text ? plainText(i.message.text, nameOf) : i.file?.title ?? i.file?.name ?? "A Slack message";
      const due = Number(i.date_due) > 0 ? new Date(Number(i.date_due) * 1000).toISOString() : null;
      out.push({
        key: todoKey("todo", `${channel}:${ts}:${i.date_created ?? i.date_saved ?? ""}`),
        kind: "todo",
        from: i.message?.user ? nameOf(i.message.user) : null,
        text,
        due,
        at: i.date_saved ?? i.date_created ? new Date(Number(i.date_saved ?? i.date_created) * 1000).toISOString() : null,
        url,
      });
    }
    return out.sort((a, b) => String(a.due ?? "9999").localeCompare(String(b.due ?? "9999")));
  })().catch((err) => {
    if (err.slackError === "not_allowed_token_type" || err.slackError === "unsupported_auth_type") notes.push("Slack does not let an app token read your To-dos (it said " + err.slackError + "); only Slack's own app can. Use a Slack reminder, or a Slack List, for to-dos you want here.");
    else if (err.slackError === "unknown_method") notes.push("Slack has no saved.list for app tokens, so your To-dos can't be read here.");
    else notes.push(`Could not read your Slack To-dos: ${err.message}`);
    return [];
  });

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
      const rows = (body.items ?? []).filter((it) => !(it.fields ?? []).some((f) => Array.isArray(f.checkbox) && f.checkbox[0] === true));
      await learn([...new Set(rows.flatMap((it) => (it.fields ?? []).flatMap((f) => f.user ?? [])))]);
      for (const it of rows) {
        const fields = it.fields ?? [];
        const textField = fields.find((f) => typeof f.text === "string" && f.text.trim() && !f.checkbox && !f.date && !f.user);
        if (!textField) continue;
        const due = fields.find((f) => Array.isArray(f.date) && f.date[0])?.date[0] ?? null;
        const who = fields.find((f) => Array.isArray(f.user) && f.user[0])?.user[0] ?? null;
        lists.push({
          key: todoKey("list", `${listId}:${it.id}`),
          kind: "list",
          list: String(title).slice(0, 60),
          text: plainText(textField.text, nameOf),
          due,
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

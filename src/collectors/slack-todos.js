// Alex's to-dos from Slack, for Today's moves. Read with Alex's user token, live, each time
// the page asks; nothing from Slack is stored except a hash of the items Alex marked done.
//
//   asks       messages that @mention Alex in the last two working days, not from Alex:
//              someone is waiting on him (Unblock others). Needs search:read.
//   reminders  Alex's own open Slack reminders (/remind, "Remind me about this").
//              Needs reminders:read; Done completes one in Slack and needs reminders:write.
//   saved      messages Alex saved for later. Needs stars:read. Slack has moved saving to
//              "Later", and the API may return nothing for it; then the page says so.
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
  asks: "search:read",
  reminders: "reminders:read",
  saved: "stars:read",
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

/** The start of the working day two working days back, in the dashboard's zone (as a Date). */
function twoWorkingDaysAgo(now) {
  const d = new Date(now);
  let n = 0;
  while (n < 2) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) n++;
  }
  d.setUTCHours(6, 0, 0, 0);
  return d;
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
  const missing = (kind, err) => {
    if (err.slackError === "missing_scope") notes.push(`Add the ${SCOPE_HINT[kind]} user scope to read ${kind === "asks" ? "Slack mentions" : kind === "saved" ? "saved messages" : "Slack reminders"}.`);
    else notes.push(`Could not read ${kind}: ${err.message}`);
    return [];
  };

  // Asks: messages mentioning Alex, not from Alex, since two working days ago.
  const asks = await (async () => {
    const since = twoWorkingDaysAgo(now);
    const after = new Date(since.getTime() - 86_400_000).toISOString().slice(0, 10);
    const body = await call("search.messages", { query: `<@${myId}> -from:<@${myId}> after:${after}`, sort: "timestamp", sort_dir: "desc", count: "50" }, ctx);
    const matches = (body.messages?.matches ?? []).filter((m) => Number(m.ts) * 1000 >= since.getTime());
    await learn([...new Set(matches.flatMap((m) => [m.user, ...mentionIds(m.text)]))]);
    return matches.map((m) => ({
      key: todoKey("ask", m.permalink ?? `${m.channel?.id}:${m.ts}`),
      kind: "ask",
      from: nameOf(m.user) ?? m.username ?? "Someone",
      where: m.channel?.is_im || m.channel?.is_mpim ? "a DM" : m.channel?.name ? `#${m.channel.name}` : "Slack",
      text: plainText(m.text, nameOf),
      at: new Date(Number(m.ts) * 1000).toISOString(),
      url: m.permalink ?? null,
    }));
  })().catch((err) => missing("asks", err));

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

  const keep = (list) => list.filter((i) => !done.has(i.key));
  return { asks: keep(asks), reminders: keep(reminders), saved: keep(saved), notes, readAt: now.toISOString() };
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

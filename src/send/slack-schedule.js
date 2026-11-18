// Schedules a nudge Alex drafted as a Slack DM from Alex's own account, at a time Alex
// picks. Alex chose this on 2026-11-17 ("Schedule as a DM from you"): it is the one way
// this app sends anything to a teammate, and only when Alex presses Schedule on a draft.
//
//   - Sent with Alex's user token (SLACK_USER_TOKEN), so it reads as Alex and replies go
//     to Alex. Needs the user scopes users:read, im:write and chat:write.
//   - Only to someone on the team roster (config/people.json), found in Slack by name at
//     the moment of scheduling. No Slack id is stored: the record keeps the name, the
//     time and the text. The ids go back to the page only so it can offer Cancel.
//   - Every message ends with a line saying Claude drafted it (the org rule that anything
//     Claude puts in Slack identifies itself).

import { httpJson } from "../lib/http.js";

const SLACK_API = "https://slack.com/api";
export const DRAFTED_LINE = "_Drafted with Claude_";
const MAX_DAYS_AHEAD = 120; // Slack allows up to 120 days

export class ScheduleError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const HINTS = {
  missing_scope: "Your Slack user token needs the scopes users:read, im:write and chat:write. Add them to the app's User Token Scopes, reinstall, and update SLACK_USER_TOKEN.",
  invalid_auth: "SLACK_USER_TOKEN is wrong or revoked. It is the User OAuth Token and starts with xoxp-.",
  not_authed: "SLACK_USER_TOKEN is not set.",
  not_user_token: "SLACK_USER_TOKEN is not your User OAuth Token. It must start with xoxp- (the bot token starts with xoxb-, and would send from the bot, not from you). Copy the User OAuth Token from the Slack app's OAuth & Permissions page into Netlify, then redeploy.",
  time_in_past: "That time has already passed. Pick a later one.",
  time_too_far: "Slack only schedules up to 120 days ahead.",
};

async function call(method, payload, { token, config, logger, fetchImpl, get = false }) {
  const http = config.system?.http ?? {};
  const url = get ? `${SLACK_API}/${method}?${new URLSearchParams(payload)}` : `${SLACK_API}/${method}`;
  const { body } = await httpJson(url, {
    method: get ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}` },
    ...(get ? {} : { body: payload }),
    logger,
    label: `slack.${method}`,
    fetchImpl,
    timeoutMs: http.timeoutMs,
    maxAttempts: Math.min(http.maxAttempts ?? 3, 3),
    backoffMsSchedule: http.backoffMsSchedule,
  });
  if (body?.ok === false) throw new ScheduleError(HINTS[body.error] ?? `Slack said ${body.error}.`, 502);
  return body;
}

const norm = (s) => String(s ?? "").trim().toLowerCase();

/** The Slack member whose name matches a roster name: full name first, then a unique first name. */
async function findMember(name, ctx) {
  const members = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const body = await call("users.list", { limit: "200", ...(cursor ? { cursor } : {}) }, { ...ctx, get: true });
    members.push(...(body.members ?? []).filter((m) => !m.deleted && !m.is_bot && m.id !== "USLACKBOT"));
    cursor = body.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  const names = (m) => [m.real_name, m.profile?.real_name, m.profile?.display_name, m.name].map(norm).filter(Boolean);
  const full = members.filter((m) => names(m).includes(norm(name)));
  if (full.length === 1) return full[0];
  const first = norm(name).split(/\s+/)[0];
  const byFirst = members.filter((m) => names(m).some((n) => n.split(/\s+/)[0] === first));
  if (byFirst.length === 1) return byFirst[0];
  throw new ScheduleError(full.length || byFirst.length > 1 ? `More than one Slack member matches ${name}.` : `No Slack member matches ${name}.`, 404);
}

/**
 * @returns {{ to, postAt, scheduledId, channel }}
 */
/** Only a user token sends as Alex; a bot token would send from the bot. */
function checkUserToken(token) {
  if (!token) throw new ScheduleError(HINTS.not_authed, 500);
  if (!String(token).startsWith("xoxp-")) throw new ScheduleError(HINTS.not_user_token, 500);
}

export async function scheduleNudge({ config, store, logger, token, to, text, postAt, fetchImpl, now = new Date() }) {
  checkUserToken(token);
  const roster = [...(config.people?.team ?? []), ...(config.people?.alex ? [config.people.alex] : [])];
  const person = roster.find((p) => norm(p.name) === norm(to)) ?? roster.find((p) => norm(p.name).split(/\s+/)[0] === norm(to).split(/\s+/)[0]);
  if (!person) throw new ScheduleError("Pick someone on the team roster.");
  const body = String(text ?? "").trim();
  if (!body) throw new ScheduleError("Write the message first.");
  if (body.length > 3000) throw new ScheduleError("Keep it under 3,000 characters.");
  const at = new Date(postAt);
  if (Number.isNaN(at.getTime())) throw new ScheduleError("When should it go?");
  if (at.getTime() < now.getTime() + 60_000) throw new ScheduleError(HINTS.time_in_past);
  if (at.getTime() > now.getTime() + MAX_DAYS_AHEAD * 86_400_000) throw new ScheduleError(HINTS.time_too_far);

  const ctx = { token, config, logger, fetchImpl };
  const me = await call("auth.test", {}, ctx);
  const member = await findMember(person.name, ctx);
  const dm = await call("conversations.open", { users: member.id }, ctx);
  const sent = await call("chat.scheduleMessage", { channel: dm.channel.id, text: `${body}\n\n${DRAFTED_LINE}`, post_at: Math.floor(at.getTime() / 1000) }, ctx);

  const record = { at: now.toISOString(), to: person.name, postAt: at.toISOString(), text: body };
  try {
    await store.backend.set(`slack/scheduled/${record.at}.json`, record);
  } catch (err) {
    logger?.warn?.("slack_schedule.record_failed", { err });
  }
  logger?.info?.("slack_schedule.scheduled", { postAt: record.postAt });
  return { to: person.name, from: me.user ?? null, postAt: record.postAt, scheduledId: sent.scheduled_message_id, channel: sent.channel ?? dm.channel.id };
}

/**
 * What Alex has scheduled in Slack right now, as Slack holds it: when, to whom (by name)
 * and the start of the text. Names are looked up each time; nothing is stored. The ids go
 * back to the page only so it can offer Cancel.
 */
export async function listScheduled({ config, logger, token, fetchImpl }) {
  checkUserToken(token);
  const ctx = { token, config, logger, fetchImpl };
  const me = await call("auth.test", {}, ctx);
  const body = await call("chat.scheduledMessages.list", { limit: 100 }, ctx);
  const names = new Map();
  const nameOf = async (channel) => {
    if (names.has(channel)) return names.get(channel);
    let name = null;
    try {
      const info = await call("conversations.info", { channel }, { ...ctx, get: true });
      const user = info.channel?.user;
      if (user) {
        const u = await call("users.info", { user }, { ...ctx, get: true });
        name = u.user?.real_name || u.user?.profile?.real_name || u.user?.name || null;
      } else name = info.channel?.name ? `#${info.channel.name}` : null;
    } catch {
      name = null;
    }
    names.set(channel, name);
    return name;
  };
  const items = [];
  for (const m of (body.scheduled_messages ?? []).sort((a, b) => a.post_at - b.post_at)) {
    items.push({
      to: (await nameOf(m.channel_id)) ?? "someone",
      postAt: new Date(m.post_at * 1000).toISOString(),
      text: String(m.text ?? "").replace(`\n\n${DRAFTED_LINE}`, "").slice(0, 160),
      scheduledId: m.id,
      channel: m.channel_id,
    });
  }
  return { from: me.user ?? null, items };
}

/** Cancels a scheduled nudge, by the ids the page was handed when it was scheduled. */
export async function cancelNudge({ config, logger, token, channel, scheduledId, fetchImpl }) {
  checkUserToken(token);
  if (!/^[A-Z0-9]+$/i.test(String(channel ?? "")) || !/^[A-Z0-9]+$/i.test(String(scheduledId ?? ""))) throw new ScheduleError("Which message?");
  await call("chat.deleteScheduledMessage", { channel, scheduled_message_id: scheduledId }, { token, config, logger, fetchImpl });
  return { cancelled: true };
}

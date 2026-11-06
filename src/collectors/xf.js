// Cross-functional (XF): what people outside the team said to Alex or the team since the
// start of the previous working day. Read for the Daily Speech, because what other teams
// ask for, praise or flag is the part of a team meeting people lean in for.
//
// Deterministic and read only. Two sources:
//
//   Slack    every channel the bot is in (or system.slack.xf.channelIds), except the
//            stand-up channel. A message counts when its author is not on the roster and
//            it @mentions Alex or a teammate, @mentions a team user group, or replies in a
//            thread a teammate started. Needs channels:history and groups:history (the bot
//            has both), plus channels:read and groups:read to list its channels and
//            users:read for names. Without the read scopes, set channelIds by hand.
//   ClickUp  the last comment on each sprint ticket, from the readout, when it was left in
//            the window by someone not on the roster.
//
// Slack user ids are used to match people and build links, held in memory for the call,
// and never stored or returned: only names leave this module.

import { slackGet, slackToText, rosterOf, matchPerson, SETUP_HINTS } from "./standup.js";
import { dateKey, previousWorkingDayKey } from "../lib/time.js";

const DAY_MS = 86_400_000;
const TEXT_CHARS = 400;
const MAX_ITEMS = 40;

const utcOfKey = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

/** The start of the window: local midnight starting the previous working day, so Monday covers Friday and the weekend. */
export function xfSince(now, config) {
  const tz = config.system.timezone;
  const today = dateKey(now, tz);
  const prev = previousWorkingDayKey(today, config.system.schedule?.workingWeekdays);
  const days = Math.round((utcOfKey(today) - utcOfKey(prev)) / DAY_MS);
  return new Date(now.getTime() - msSinceLocalMidnight(now, tz) - days * DAY_MS);
}

function msSinceLocalMidnight(now, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return ((Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000;
}

/** Slack text with every <@U...> turned into @Name, so nothing downstream sees an id. */
export function namedText(text, nameOfId) {
  return slackToText(String(text ?? "").replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `<@${id}|${nameOfId(id) ?? "someone"}>`)).slice(0, TEXT_CHARS);
}

const mentionedIds = (text) => [...String(text ?? "").matchAll(/<@([A-Z0-9]+)/g)].map((m) => m[1]);
const mentionedGroups = (text) => [...String(text ?? "").matchAll(/<!subteam\^([A-Z0-9]+)/g)].map((m) => m[1]);

/**
 * The XF items in one channel's messages. Pure. `teamIds` maps a teammate's Slack id to
 * their roster name; `parents` maps a thread's ts to its starter's id.
 */
export function xfFromMessages(messages, { channel, teamIds, teamGroupIds = [], nameOfId, parents = new Map(), permalink }) {
  const out = [];
  for (const m of messages) {
    if (m.bot_id || !m.user || (m.subtype && m.subtype !== "thread_broadcast")) continue;
    if (teamIds.has(m.user)) continue;
    const to = new Set(mentionedIds(m.text).filter((id) => teamIds.has(id)).map((id) => teamIds.get(id)));
    const toGroup = mentionedGroups(m.text).some((g) => teamGroupIds.includes(g));
    const parent = m.thread_ts && m.thread_ts !== m.ts ? parents.get(m.thread_ts) : null;
    const inTeamThread = parent && teamIds.has(parent);
    if (!to.size && !toGroup && !inTeamThread) continue;
    if (!to.size && inTeamThread) to.add(teamIds.get(parent));
    out.push({
      source: "slack",
      where: channel.name ? `#${channel.name}` : "Slack",
      from: nameOfId(m.user) ?? "Someone outside the team",
      to: to.size ? [...to] : ["the team"],
      how: to.size && !inTeamThread ? "mentioned" : inTeamThread ? "replied in thread" : "mentioned the team",
      text: namedText(m.text, nameOfId),
      at: new Date(Math.round(Number(m.ts) * 1000)).toISOString(),
      url: permalink ? permalink(channel.id, m.ts, m.thread_ts) : null,
    });
  }
  return out;
}

/** Sprint ticket comments left in the window by someone not on the roster. Pure. */
export function xfFromClickUp(tasks = [], { roster, since }) {
  const teamIds = new Set(roster.map((p) => String(p.clickupUserId ?? "")).filter(Boolean));
  const out = [];
  for (const t of tasks) {
    const c = t.lastComment;
    if (t.archived || !c?.date || c.date < since.getTime()) continue;
    if (c.userId ? teamIds.has(String(c.userId)) : matchPerson([c.user], roster)) continue;
    const who = (t.assignees?.length ? t.assignees : t.taskOwners ?? []).map((u) => u.username).filter(Boolean);
    out.push({
      source: "clickup",
      where: `ClickUp: ${t.plainName ?? t.name}`,
      from: c.user ?? "Someone outside the team",
      to: who.length ? who : ["the team"],
      how: "commented",
      text: String(c.text ?? "").slice(0, TEXT_CHARS),
      at: new Date(c.date).toISOString(),
      url: t.url ?? null,
    });
  }
  return out;
}

async function pages(method, params, ctx, key, max = 5) {
  const out = [];
  let cursor;
  for (let i = 0; i < max; i++) {
    const body = await slackGet(method, { ...params, ...(cursor ? { cursor } : {}) }, ctx);
    out.push(...(body[key] ?? []));
    cursor = body.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/**
 * Everything XF since the start of the previous working day, newest first. Never throws:
 * a source that cannot be read is skipped and named in `notes` with how to fix it.
 */
export async function fetchXf({ config, token, logger, fetchImpl, now = new Date(), report = null }) {
  const cfg = config.system.slack?.xf ?? {};
  const since = xfSince(now, config);
  const roster = rosterOf(config);
  const notes = [];
  const items = [];
  const channelsRead = [];

  items.push(...xfFromClickUp(report?.detail?.clickup?.tasks ?? [], { roster, since }));

  // Off unless system.slack.xf.enabled is true: reading Slack this way needs the bot in
  // every channel worth reading. Alex's notes from the day cover it instead.
  if (cfg.enabled !== true) {
    // Nothing to say: off by choice is not a problem to flag.
  } else if (!token) notes.push(SETUP_HINTS.not_authed);
  else {
    const ctx = { token, config, logger, fetchImpl };
    try {
      const auth = await slackGet("auth.test", {}, ctx);
      const base = String(auth.url ?? "").replace(/\/$/, "");
      const permalink = base
        ? (channel, ts, threadTs) => `${base}/archives/${channel}/p${String(ts).replace(".", "")}${threadTs && threadTs !== ts ? `?thread_ts=${threadTs}&cid=${channel}` : ""}`
        : null;

      const skip = new Set([config.system.slack?.standup?.channelId, ...(cfg.excludeChannelIds ?? [])].filter(Boolean));
      let channels;
      if (cfg.channelIds?.length) channels = cfg.channelIds.map((id) => ({ id, name: null }));
      else {
        try {
          channels = await pages("users.conversations", { types: "public_channel,private_channel", exclude_archived: "true", limit: "200" }, ctx, "channels");
        } catch (err) {
          if (err.slackError !== "missing_scope") throw err;
          notes.push("Slack XF was skipped: the bot cannot list its channels. Add the channels:read and groups:read scopes to the Slack app and reinstall it, or list the channels under system.slack.xf.channelIds.");
          channels = [];
        }
      }
      channels = channels.filter((c) => !skip.has(c.id));

      const oldest = String(Math.floor(since.getTime() / 1000));
      const byChannel = [];
      let threadBudget = cfg.maxThreads ?? 40;
      for (const channel of channels) {
        try {
          const top = await pages("conversations.history", { channel: channel.id, oldest, limit: "200" }, ctx, "messages", 3);
          const parents = new Map(top.map((m) => [m.ts, m.user]));
          const replies = [];
          for (const m of top) {
            if (!m.reply_count || Number(m.latest_reply ?? 0) < Number(oldest) || threadBudget <= 0) continue;
            threadBudget -= 1;
            const thread = await pages("conversations.replies", { channel: channel.id, ts: m.ts, oldest, limit: "200" }, ctx, "messages", 2);
            replies.push(...thread.filter((r) => r.ts !== m.ts && Number(r.ts) >= Number(oldest)));
          }
          byChannel.push({ channel, messages: [...top, ...replies], parents });
          channelsRead.push(channel.name ? `#${channel.name}` : channel.id);
        } catch (err) {
          logger?.warn?.("xf.channel_unreadable", { err: err.slackError ?? err.message });
        }
      }

      // Names for everyone who posted or was mentioned. Held in memory for this call.
      const ids = new Set(byChannel.flatMap(({ messages }) => messages.flatMap((m) => [m.user, ...mentionedIds(m.text)])).filter(Boolean));
      const names = new Map();
      for (const m of byChannel.flatMap((c) => c.messages)) {
        if (m.user && m.user_profile) names.set(m.user, [m.user_profile.real_name, m.user_profile.display_name]);
      }
      for (const id of ids) {
        if (names.has(id)) continue;
        try {
          const body = await slackGet("users.info", { user: id }, ctx);
          if (body.user?.is_bot) names.set(id, null);
          else names.set(id, [body.user?.real_name, body.user?.profile?.display_name, body.user?.name]);
        } catch (err) {
          if (err.slackError === "missing_scope") {
            notes.push("Slack is not giving the bot people's names, so teammates cannot be recognized in Slack. Add the users:read scope to the Slack app and reinstall it.");
            break;
          }
        }
      }
      const nameOfId = (id) => names.get(id)?.find(Boolean) ?? null;
      const teamIds = new Map();
      for (const [id, n] of names) {
        const person = n && matchPerson(n, roster);
        if (person) teamIds.set(id, person.name);
      }
      const alex = config.people?.alex;
      if (alex?.slackUserId) teamIds.set(alex.slackUserId, alex.name);

      for (const { channel, messages, parents } of byChannel) {
        items.push(...xfFromMessages(messages, { channel, teamIds, teamGroupIds: cfg.teamGroupIds ?? [], nameOfId, parents, permalink }));
      }
    } catch (err) {
      logger?.warn?.("xf.slack_failed", { err: err.slackError ?? err.message });
      notes.push(`Slack XF could not be read. ${err.message}`);
    }
  }

  items.sort((a, b) => b.at.localeCompare(a.at));
  return { since: since.toISOString(), channelsRead, items: items.slice(0, MAX_ITEMS), notes: [...new Set(notes)] };
}


// The team's daily stand-ups, read from the Slack channel they are posted in.
//
// Deterministic and read only. One endpoint:
//   GET conversations.history?channel=...&oldest=...
// The bot needs channels:history or groups:history (it has both) and has to be a member
// of the channel: a private channel answers channel_not_found to a bot that is not in it.
//
// Read live when the Stand-up tab opens rather than in the 8 AM run, because most people
// post between 8 and 10. Nothing is stored, and no Slack user id leaves this module: a
// post is matched to a roster person by the name on it, and only the name is returned.
//
// A post is any message with a Yesterday, Today or Blockers line, in the shape the
// channel's reminder asks for:
//   `Yesterday:` Checkout card fix live | FBB V4 demo with Robson
//   `Today:` Checkout workshop | Ship the subscription tag fix
//   `Blockers:`

import { httpJson } from "../lib/http.js";
import { zonedParts } from "../lib/time.js";

const SLACK_API = "https://slack.com/api";
const SECTION = /^[\s`*_>•-]*(yesterday|today|blockers?)[\s`*_]*:[\s`*_]*(.*)$/i;
const NOTHING = /^(none|nope|no|n\/?a|nothing|-+|—|no blockers?\.?|none\.?)$/i;

export const SETUP_HINTS = {
  channel_not_found: "The bot is not in the stand-up channel. In Slack, open the channel and run /invite @turnpups_mos_claude.",
  not_in_channel: "The bot is not in the stand-up channel. In Slack, open the channel and run /invite @turnpups_mos_claude.",
  missing_scope: "The bot token lacks channels:history or groups:history. Add it in the Slack app settings and reinstall.",
  invalid_auth: "SLACK_BOT_TOKEN is wrong or revoked.",
  not_authed: "SLACK_BOT_TOKEN is not set.",
};

/** Slack markup to plain text: <@U1|Name> to @Name, <url|label> to label, entities decoded. */
export function slackToText(text) {
  return String(text ?? "")
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, "@$1")
    .replace(/<@[A-Z0-9]+>/g, "@someone")
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<([^>|]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** One section's text as a list. Items are split on " | " and on bullet lines. */
function items(lines) {
  return lines
    .flatMap((l) => l.split(/\s+\|\s+|\s*\|\s*$|^\s*\|\s*/))
    .map((s) => s.replace(/^[\s•*\-–]+/, "").replace(/[`*_]+/g, "").trim())
    .filter((s) => s && !NOTHING.test(s));
}

/**
 * The Yesterday, Today and Blockers of one message, or null when it is not a stand-up or
 * every section is empty (the reminder bot's template is exactly that).
 */
export function parseStandup(rawText) {
  const text = slackToText(rawText);
  const sections = { yesterday: [], today: [], blockers: [] };
  let current = null;
  let found = false;
  for (const line of text.split("\n")) {
    const m = line.match(SECTION);
    if (m) {
      const key = m[1].toLowerCase().startsWith("blocker") ? "blockers" : m[1].toLowerCase();
      current = key;
      found = true;
      if (m[2]) sections[key].push(m[2]);
    } else if (current && line.trim()) {
      sections[current].push(line);
    }
  }
  if (!found) return null;
  const out = { yesterday: items(sections.yesterday), today: items(sections.today), blockers: items(sections.blockers) };
  if (!out.yesterday.length && !out.today.length && !out.blockers.length) return null;
  return out;
}

const words = (s) => String(s ?? "").toLowerCase().split(/[^a-z]+/).filter(Boolean);

/**
 * The roster person a post belongs to, by the poster's real or display name. A first name
 * match is enough ("Akansha (Akky)" is Akansha Gupta, "alex.turney" is Alex Turney); the
 * full name wins when two people share a first name.
 */
export function matchPerson(names, roster) {
  const given = names.flatMap(words);
  if (!given.length) return null;
  const full = roster.filter((p) => {
    const w = words(p.name);
    return w.length > 1 && w.every((x) => given.includes(x));
  });
  if (full.length === 1) return full[0];
  const first = roster.filter((p) => given.includes(words(p.name)[0]));
  return first.length === 1 ? first[0] : null;
}

/** The roster, Alex first, each person once. */
export function rosterOf(config) {
  const seen = new Set();
  return [config.people?.alex, ...(config.people?.team ?? [])].filter((p) => {
    if (!p?.name || seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });
}

/**
 * Turns channel messages into stand-ups, grouped by day (in the readout's timezone),
 * newest day first, each person's latest post that day. `nameOf(message)` gives the
 * poster's names.
 */
export function buildStandups(messages, { roster, timeZone, nameOf }) {
  const byDay = new Map();
  // Posters with no name to go on stay apart from each other, numbered in the order they
  // first appear. The Slack id is only the key here; it never reaches the output.
  const unnamed = new Map();
  const unnamedLabel = (id) => {
    if (!unnamed.has(id)) unnamed.set(id, `Unnamed poster ${unnamed.size + 1}`);
    return unnamed.get(id);
  };
  for (const m of messages) {
    if (m.bot_id || (m.subtype && m.subtype !== "thread_broadcast")) continue;
    const parsed = parseStandup(m.text);
    if (!parsed) continue;
    const at = Math.round(Number(m.ts) * 1000);
    const names = nameOf(m);
    const person = matchPerson(names, roster);
    const name = person?.name ?? names.find(Boolean) ?? unnamedLabel(m.user ?? "?");
    const day = zonedParts(new Date(at), timeZone).dateKey;
    if (!byDay.has(day)) byDay.set(day, new Map());
    const posts = byDay.get(day);
    const prior = posts.get(name);
    if (!prior || prior.postedAt < at) posts.set(name, { name, onRoster: Boolean(person), postedAt: at, edited: Boolean(m.edited), ...parsed });
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([dateKey, posts]) => ({ dateKey, posts: [...posts.values()].sort((a, b) => a.postedAt - b.postedAt) }));
}

async function slackGet(method, params, { token, config, logger, fetchImpl }) {
  const http = config.system.http ?? {};
  const qs = new URLSearchParams(params).toString();
  const { body } = await httpJson(`${SLACK_API}/${method}?${qs}`, {
    headers: { authorization: `Bearer ${token}` },
    logger,
    label: `slack.${method}`,
    fetchImpl,
    timeoutMs: http.timeoutMs,
    maxAttempts: http.maxAttempts,
    backoffMsSchedule: http.backoffMsSchedule,
  });
  if (body?.ok === false) {
    const err = new Error(SETUP_HINTS[body.error] ?? `Slack said ${body.error}.`);
    err.slackError = body.error;
    throw err;
  }
  return body;
}

/**
 * The stand-ups posted in the last `days` days. Messages carry the poster's profile, so
 * names come from there; when one does not, users.info is tried once per poster, which
 * needs users:read and is skipped quietly without it.
 */
export async function fetchStandups({ config, token, logger, fetchImpl, now = new Date(), days }) {
  const cfg = config.system.slack?.standup ?? {};
  if (!cfg.channelId) throw new Error("No stand-up channel is configured (system.slack.standup.channelId).");
  if (!token) throw new Error(SETUP_HINTS.not_authed);
  const lookback = days ?? cfg.lookbackDays ?? 14;
  const oldest = String(Math.floor(now.getTime() / 1000 - lookback * 86400));

  const messages = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const body = await slackGet(
      "conversations.history",
      { channel: cfg.channelId, oldest, limit: "200", ...(cursor ? { cursor } : {}) },
      { token, config, logger, fetchImpl },
    );
    messages.push(...(body.messages ?? []));
    cursor = body.response_metadata?.next_cursor;
    if (!body.has_more || !cursor) break;
  }

  // Only for posters whose message came without a profile. Held in memory for this call.
  const looked = new Map();
  let nameScopeMissing = false;
  for (const m of messages) {
    if (m.user_profile || !m.user || looked.has(m.user) || !parseStandup(m.text)) continue;
    try {
      const body = await slackGet("users.info", { user: m.user }, { token, config, logger, fetchImpl });
      looked.set(m.user, [body.user?.real_name, body.user?.profile?.display_name, body.user?.name]);
    } catch (err) {
      logger?.warn?.("standup.name_unavailable", { err: err.slackError ?? err.message });
      looked.set(m.user, []);
      // Without users:read every lookup fails the same way. Stop asking.
      if (err.slackError === "missing_scope") {
        nameScopeMissing = true;
        break;
      }
    }
  }
  const nameOf = (m) =>
    m.user_profile ? [m.user_profile.real_name, m.user_profile.display_name, m.user_profile.name] : looked.get(m.user) ?? [];

  const roster = rosterOf(config);
  const standups = buildStandups(messages, { roster, timeZone: config.system.timezone, nameOf });
  // Who to expect: everyone on the roster who has posted at least once in the window.
  // Someone who never posts stand-ups is not "missing" one.
  const posters = new Set(standups.flatMap((d) => d.posts.filter((p) => p.onRoster).map((p) => p.name)));
  return {
    fetchedAt: now.toISOString(),
    lookbackDays: lookback,
    today: zonedParts(now, config.system.timezone).dateKey,
    expected: roster.map((p) => p.name).filter((n) => posters.has(n)),
    namesNote: nameScopeMissing
      ? "Slack is not giving the bot posters' names. Add the users:read scope to the Slack app (OAuth & Permissions, Bot Token Scopes) and reinstall it."
      : null,
    days: standups,
  };
}

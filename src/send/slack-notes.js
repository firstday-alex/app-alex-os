// Saving to the Daily Speech's notes from Slack. Two ways in, both Alex's alone:
//
//   "Save to daily notes"  a message shortcut (⋯ on any message). Saves what was said,
//                          who said it, where, and a link. Works in any channel Alex can
//                          see; the bot does not need to be a member.
//   /tpnote <text>         a slash command, for anything typed. (/tpnote in this
//                          workspace, since /note is taken; any name works.)
//
// Anyone else gets no reply at all: the system only communicates with Alex. Every reply
// says it came from Claude. Slack user ids are used to check who is asking and to look up
// a name, and are never stored.

import { addNote } from "../store/day-notes.js";
import { slackGet, slackToText } from "../collectors/standup.js";
import { IDENTITY_LINE } from "./slack.js";

export const SAVE_NOTE_CALLBACK = "save_day_note";
const SAVED = "Saved to today's notes for the Daily Speech.";

const reply = (text) => ({ response_type: "ephemeral", text: `${IDENTITY_LINE} ${text}` });
const isAlex = (config, userId) => Boolean(config.people?.alex?.slackUserId) && userId === config.people.alex.slackUserId;

/**
 * For the log: was it Alex, and if not, why it may not have matched. Never the id itself,
 * only its first letter (U for a workspace user, W for an Enterprise Grid one, which
 * would mean config/people.json holds the wrong kind of id).
 */
export function whoFields(userId, config, enterpriseId) {
  return {
    isAlex: isAlex(config, userId),
    alexIdSet: Boolean(config.people?.alex?.slackUserId),
    userIdKind: userId ? String(userId)[0] : null,
    enterprise: Boolean(enterpriseId),
  };
}

/** A link to a message, from the workspace domain Slack sends with every payload. */
export function messageLink(payload) {
  const domain = payload.team?.domain;
  const channel = payload.channel?.id;
  const ts = payload.message?.ts;
  if (!domain || !channel || !ts) return null;
  const thread = payload.message.thread_ts && payload.message.thread_ts !== ts ? `?thread_ts=${payload.message.thread_ts}&cid=${channel}` : "";
  return `https://${domain}.slack.com/archives/${channel}/p${String(ts).replace(".", "")}${thread}`;
}

/** Who wrote a message: the profile Slack sends with it, else users.info, else null. */
async function authorName(message, { token, config, logger, fetchImpl }) {
  const p = message.user_profile;
  if (p) return p.real_name || p.display_name || p.name || null;
  if (!message.user || !token) return message.username ?? null;
  try {
    const body = await slackGet("users.info", { user: message.user }, { token, config, logger, fetchImpl });
    return body.user?.real_name || body.user?.profile?.display_name || body.user?.name || null;
  } catch (err) {
    logger?.warn?.("notes.author_unavailable", { err: err.slackError ?? err.message });
    return null;
  }
}

/** Slack markup to plain text. A mention Slack sent without a name becomes @someone, never an id. */
const plainText = (text) => slackToText(String(text ?? ""));

const MAX_MENTION_LOOKUPS = 10;

/**
 * A message's bare mentions, <@U123>, given their names: "<@U123|Andrew Smith>", so the
 * note reads "@Andrew Smith" rather than "@someone". Names come from users.info (the
 * bot's users:read scope), at most ten per message; one that cannot be looked up stays
 * @someone. The ids are used for the lookup only and never reach the note.
 */
export async function nameMentions(text, { token, config, logger, fetchImpl }) {
  const raw = String(text ?? "");
  const ids = [...new Set([...raw.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]))].slice(0, MAX_MENTION_LOOKUPS);
  if (!ids.length || !token) return raw;
  const names = new Map();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const body = await slackGet("users.info", { user: id }, { token, config, logger, fetchImpl });
        const name = body.user?.real_name || body.user?.profile?.real_name || body.user?.profile?.display_name || body.user?.name;
        if (name) names.set(id, name.replace(/[<>|]/g, ""));
      } catch (err) {
        logger?.warn?.("notes.mention_unavailable", { err: err.slackError ?? err.message });
      }
    }),
  );
  return raw.replace(/<@([A-Z0-9]+)>/g, (whole, id) => (names.has(id) ? `<@${id}|${names.get(id)}>` : whole));
}

/** The message shortcut. Returns the body to send to the response_url, or null for no reply. */
export async function handleSaveShortcut({ payload, config, backend, token, logger, fetchImpl, now = new Date() }) {
  if (!isAlex(config, payload.user?.id)) {
    logger?.info?.("notes.shortcut_ignored", {});
    return null;
  }
  const message = payload.message ?? {};
  if (!plainText(message.text).trim()) return reply("That message has no text to save.");
  const [named, who] = await Promise.all([
    nameMentions(message.text, { token, config, logger, fetchImpl }),
    authorName(message, { token, config, logger, fetchImpl }),
  ]);
  const text = plainText(named).trim();
  const where = payload.channel?.name && payload.channel.name !== "directmessage" ? `#${payload.channel.name}` : "a direct message";
  const note = await addNote(backend, {
    text: `${who ?? "Someone"} in ${where}: "${text}"`.slice(0, 3990),
    source: { via: "slack-shortcut", link: messageLink(payload) },
    now,
    config,
  });
  logger?.info?.("notes.saved_from_slack", { via: "shortcut", dateKey: note.dateKey });
  return reply(SAVED);
}

/** The /note command. Returns the immediate reply, or null for no reply. */
export async function handleNoteCommand({ params, config, backend, logger, now = new Date() }) {
  if (!isAlex(config, params.get("user_id"))) {
    logger?.info?.("notes.command_ignored", {});
    return null;
  }
  const text = String(params.get("text") ?? "").trim();
  if (!text) return reply(`Add what to save after the command, like: ${params.get("command") || "/tpnote"} Sam asked for the holiday offer on bundles`);
  const channel = params.get("channel_name");
  const note = await addNote(backend, {
    text: plainText(text),
    source: { via: "slack-command", channel: channel && channel !== "directmessage" ? `#${channel}` : null },
    now,
    config,
  });
  logger?.info?.("notes.saved_from_slack", { via: "command", dateKey: note.dateKey });
  return reply(SAVED);
}

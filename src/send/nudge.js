// Nudge owner. One message to the person a flag is about, tagged, in a channel where
// Alex can read the reply.
//
// Not a direct message on purpose: replies to a bot's DM reach nobody, so the answer to
// the nudge would be lost. It goes to SLACK_NUDGE_CHANNEL (falling back to the readout
// channel), and the thread is recorded so the learning skill never mistakes a teammate's
// reply for Alex's feedback.
//
// The text is the one Alex saw and edited on the dashboard. No model writes it.

import { postMessage } from "./slack.js";

export class NudgeError extends Error {
  constructor(message) {
    super(message);
    this.name = "NudgeError";
  }
}

/** The roster a nudge can go to: the team, plus Alex. */
export function nudgeRoster(config) {
  const people = [...(config.people?.team ?? []), ...(config.people?.alex ? [config.people.alex] : [])];
  const seen = new Set();
  return people
    .filter((p) => p?.name && !seen.has(p.name) && seen.add(p.name))
    .map((p) => ({
      name: p.name,
      clickupUserId: p.clickupUserId == null ? null : String(p.clickupUserId),
      slackUserId: p.slackUserId ?? null,
    }));
}

/**
 * Matches a name as the dashboard shows it. ClickUp usernames and roster names are not
 * always spelled the same ("Robson" against "Robson Lopes"), so a unique first-name match
 * is accepted; anything ambiguous is refused rather than guessed.
 */
export function resolveRecipient(roster, who) {
  const want = String(who ?? "").trim().toLowerCase();
  if (!want) return null;
  const exact = roster.filter((p) => p.name.toLowerCase() === want || p.clickupUserId === want);
  if (exact.length === 1) return exact[0];
  const first = roster.filter((p) => p.name.toLowerCase().split(/\s+/)[0] === want.split(/\s+/)[0]);
  return first.length === 1 ? first[0] : null;
}

export const nudgeThreadKey = (channel, ts) => `nudges/threads/${channel}-${ts}.json`;

export function nudgeChannel(config, env) {
  const name = config.system.slack?.nudges?.channelEnv ?? "SLACK_NUDGE_CHANNEL";
  return env[name] || env.SLACK_READOUT_CHANNEL || null;
}

export async function sendNudge({ config, env, store, logger, to, text, flagKey, fetchImpl }) {
  const roster = nudgeRoster(config);
  const person = resolveRecipient(roster, to);
  if (!person) throw new NudgeError(`"${to}" is not on the roster in config/people.json, or matches more than one person.`);
  if (!person.slackUserId) {
    throw new NudgeError(`There is no Slack member ID for ${person.name}. Add slackUserId for them in config/people.json, or copy the message instead.`);
  }
  const channel = nudgeChannel(config, env);
  if (!channel) throw new NudgeError("Set SLACK_NUDGE_CHANNEL (or SLACK_READOUT_CHANNEL) to the channel nudges should go to.");
  const body = String(text ?? "").trim();
  if (!body) throw new NudgeError("The message is empty.");

  const posted = await postMessage({
    channel,
    text: `<@${person.slackUserId}> ${body}`.slice(0, 2800),
    token: env.SLACK_BOT_TOKEN,
    logger,
    fetchImpl,
    config,
  });

  await store.backend.set(nudgeThreadKey(posted.channel ?? channel, posted.ts), { flagKey, to: person.name, at: new Date().toISOString() });
  logger?.info?.("nudge.sent", { flagKey, to: person.name, channel: posted.channel ?? channel });
  return { to: person.name, channel: posted.channel ?? channel, ts: posted.ts };
}

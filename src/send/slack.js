// Slack. Posting the readout, and verifying anything that comes back.
//
// Two rules that are not negotiable in this file:
//   1. Idempotence. The official readout is keyed on the run date and checked before
//      sending, so a Netlify background-function retry cannot double post.
//   2. Identity. Every message this system posts says it came from Claude. The
//      organization requires the bot to identify itself, every time, without exception.

import crypto from "node:crypto";
import { httpJson } from "../lib/http.js";

const SLACK_API = "https://slack.com/api";

/** Prepended to every outbound message. Non-optional. */
export const IDENTITY_LINE = "Posted by Claude, the Turnpups MOS bot. Automated readout.";

export function identityBlock() {
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text: `:robot_face: _${IDENTITY_LINE}_` }],
  };
}

async function slackCall(method, payload, { token, logger, fetchImpl, sleep, config }) {
  const http = config?.system?.http ?? {};
  const { body } = await httpJson(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: payload,
    logger,
    label: `slack.${method}`,
    fetchImpl,
    timeoutMs: http.timeoutMs ?? 30000,
    maxAttempts: http.maxAttempts ?? 5,
    backoffMsSchedule: http.backoffMsSchedule ?? [1000, 2000, 4000, 8000],
    sleep,
  });
  // Slack answers 200 with ok:false for application errors. Surface them, and translate
  // the handful that only ever happen during setup into something actionable. A bare
  // "channel_not_found" at 8 AM is accurate and useless.
  if (body && body.ok === false) {
    const err = new Error(`slack.${method} failed: ${body.error}. ${SETUP_HINTS[body.error] ?? ""}`.trim());
    err.slackError = body.error;
    throw err;
  }
  return body;
}

const SETUP_HINTS = {
  channel_not_found:
    "SLACK_READOUT_CHANNEL must be the channel ID (starts with C), not the #name. Find it in Slack: right-click the channel > View channel details > the ID is at the bottom.",
  not_in_channel:
    "The bot is not a member of that channel. Run /invite @Turnpups MOS in it, or add the chat:write.public scope for public channels.",
  is_archived: "That channel is archived. Point SLACK_READOUT_CHANNEL at a live one.",
  invalid_auth: "SLACK_BOT_TOKEN is wrong or revoked. It is the Bot User OAuth Token and starts with xoxb-.",
  not_authed: "SLACK_BOT_TOKEN is not set.",
  missing_scope: "The bot token lacks a required scope. Reinstall the app after adding it; scope changes need a reinstall.",
  invalid_blocks: "Slack rejected the rendered blocks. The readout is still in storage and on the dashboard.",
};

export async function postMessage({ channel, text, blocks, threadTs, token, logger, fetchImpl, sleep, config }) {
  const withIdentity = blocks ? [identityBlock(), ...blocks] : undefined;
  return slackCall(
    "chat.postMessage",
    {
      channel,
      text: `${IDENTITY_LINE}\n\n${text}`.slice(0, 3000),
      ...(withIdentity ? { blocks: withIdentity } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
      unfurl_links: false,
    },
    { token, logger, fetchImpl, sleep, config },
  );
}

/**
 * Sends the official readout at most once per day.
 *
 * If Slack is down after the retries are exhausted, the report is already in storage and
 * shows on the dashboard. The report is not lost. That is the spec's requirement and the
 * reason this function reports a failure instead of throwing it upward.
 */
export async function sendReadout({ report, store, config, token, channel, logger, fetchImpl, sleep, force = false }) {
  if (!token || !channel) {
    logger?.warn?.("slack.not_configured", { hasToken: Boolean(token), hasChannel: Boolean(channel) });
    return { sent: false, reason: "Slack is not configured" };
  }

  if (report.mode === "official" && !force) {
    const already = await store.wasSent(report.dateKey);
    if (already) {
      logger?.info?.("slack.already_sent", { dateKey: report.dateKey, previousRunId: already.runId, ts: already.ts });
      return { sent: false, reason: "already sent for this date", previous: already };
    }
  }

  try {
    const result = await postMessage({
      channel,
      text: report.text,
      blocks: report.slackBlocks,
      token,
      logger,
      fetchImpl,
      sleep,
      config,
    });
    const receipt = { runId: report.runId, ts: result.ts, channel: result.channel, sentAt: new Date().toISOString() };
    if (report.mode === "official") await store.markSent(report.dateKey, receipt);
    logger?.info?.("slack.sent", receipt);
    return { sent: true, ...receipt };
  } catch (err) {
    logger?.error?.("slack.send_failed", { err, dateKey: report.dateKey });
    return { sent: false, reason: `Slack send failed: ${err.message}`, reportInStorage: true };
  }
}

/**
 * Verifies an inbound Slack request. v0 HMAC over `v0:timestamp:body`, timing-safe
 * compare, and a five minute replay window.
 */
export function verifySlackSignature({ signingSecret, signature, timestamp, rawBody, now = Date.now() }) {
  if (!signingSecret) return { ok: false, reason: "SLACK_SIGNING_SECRET is not set" };
  if (!signature || !timestamp) return { ok: false, reason: "missing signature headers" };

  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return { ok: false, reason: "timestamp outside the five minute window" };

  const expected = `v0=${crypto
    .createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return { ok: false, reason: "signature mismatch" };
  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

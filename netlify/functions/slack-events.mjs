// Slack's Events endpoint. Replies to a readout land here and drive the Learning Skill.
//
// Only Alex's replies are acted on. Anyone else's reply in the thread is read and ignored,
// because the learning loop is Alex's feedback loop. Bot messages are never acted on,
// because a bot reacting to its own posts would loop.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { verifySlackSignature } from "../../src/send/slack.js";

export default async (req) => {
  const config = loadConfig();
  const logger = createLogger({ base: { fn: "slack-events" } });
  const rawBody = await req.text();

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("bad body", { status: 400 });
  }

  // Slack's one-time URL verification handshake.
  if (body.type === "url_verification") {
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const verified = verifySlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    signature: req.headers.get("x-slack-signature"),
    timestamp: req.headers.get("x-slack-request-timestamp"),
    rawBody,
  });
  if (!verified.ok) {
    logger.warn("slack.signature_rejected", { reason: verified.reason });
    return new Response("forbidden", { status: 403 });
  }

  const event = body.event ?? {};

  if (event.bot_id || event.subtype === "bot_message") return new Response("", { status: 200 });
  if (event.type !== "message" || !event.thread_ts) return new Response("", { status: 200 });

  const alexSlackId = config.people?.alex?.slackUserId ?? null;
  if (alexSlackId && event.user !== alexSlackId) {
    logger.info("learning.ignored_other_user", { user: event.user });
    return new Response("", { status: 200 });
  }
  if (!alexSlackId) {
    logger.warn("learning.alex_slack_id_unset", {
      note: "config.people.alex.slackUserId is not set, so any human reply in the thread drives the learning skill",
    });
  }

  // Slack retries an event it believes was not acknowledged. Do the work once.
  const store = await Store.open({ config, logger });
  const dedupeKey = `learning/seen/${event.client_msg_id ?? `${event.channel}-${event.ts}`}.json`;
  if (await store.backend.get(dedupeKey)) {
    logger.info("learning.duplicate_event", { ts: event.ts });
    return new Response("", { status: 200 });
  }
  await store.backend.set(dedupeKey, { at: new Date().toISOString() });

  const feedback = {
    text: event.text ?? "",
    user: event.user ?? null,
    channel: event.channel ?? null,
    ts: event.ts ?? null,
    threadTs: event.thread_ts ?? null,
  };

  const base = process.env.URL ?? process.env.DEPLOY_PRIME_URL ?? "http://localhost:8888";
  try {
    const response = await fetch(`${base}/.netlify/functions/learning-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mos-internal": process.env.DASHBOARD_COOKIE_SECRET ?? "" },
      body: JSON.stringify({ feedback }),
      signal: AbortSignal.timeout(5000),
    });
    logger.info("learning.handed_off", { status: response.status, ts: event.ts });
  } catch (err) {
    logger.error("learning.handoff_failed", { err });
  }

  return new Response("", { status: 200 });
};

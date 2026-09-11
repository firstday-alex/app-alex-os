// Slack's interactivity endpoint. The "Ask for recommendation" button lands here.
//
// Slack expects an acknowledgement within three seconds and an Anthropic call takes
// longer, so this verifies the signature, hands off to the background function, and
// acknowledges. The answer arrives in the thread when it is ready.

import { createLogger } from "../../src/lib/logger.js";
import { verifySlackSignature, IDENTITY_LINE } from "../../src/send/slack.js";

async function handOff(payload, logger) {
  const base = process.env.URL ?? process.env.DEPLOY_PRIME_URL ?? "http://localhost:8888";
  const response = await fetch(`${base}/.netlify/functions/advisor-background`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mos-internal": process.env.DASHBOARD_COOKIE_SECRET ?? "" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  logger.info("advisor.handed_off", { status: response.status, flagId: payload.flagId });
}

export default async (req) => {
  const logger = createLogger({ base: { fn: "slack-interactive" } });
  const rawBody = await req.text();

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

  let payload;
  try {
    payload = JSON.parse(new URLSearchParams(rawBody).get("payload") ?? "{}");
  } catch {
    return new Response("bad payload", { status: 400 });
  }

  const action = (payload.actions ?? [])[0];
  if (payload.type !== "block_actions" || action?.action_id !== "ask_advisor") {
    return new Response("", { status: 200 });
  }

  logger.info("advisor.button_clicked", { flagId: action.value, clickedBy: payload.user?.id ?? null });

  try {
    await handOff(
      {
        flagId: action.value,
        channel: payload.channel?.id ?? null,
        threadTs: payload.message?.thread_ts ?? payload.message?.ts ?? null,
        clickedBy: payload.user?.id ?? null,
      },
      logger,
    );
  } catch (err) {
    logger.error("advisor.handoff_failed", { err });
    return new Response(
      JSON.stringify({ response_type: "ephemeral", text: `${IDENTITY_LINE} I could not start that recommendation: ${err.message}` }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({
      response_type: "ephemeral",
      text: `${IDENTITY_LINE} Working on that recommendation. It will land in this thread.`,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

// Slack slash commands. One: /note <text>, which saves to the Daily Speech's notes. Any
// command pointed at this URL is treated as /note, so a command renamed in the Slack app
// (because /note was taken in the workspace, say) still saves instead of going silent.
// Verified by Slack's signature like every other inbound Slack request; Alex only, and
// anyone else gets no reply (src/send/slack-notes.js).

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { verifySlackSignature, IDENTITY_LINE } from "../../src/send/slack.js";
import { handleNoteCommand, whoFields } from "../../src/send/slack-notes.js";

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

export default async (req) => {
  const logger = createLogger({ base: { fn: "slack-command" } });
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

  const params = new URLSearchParams(rawBody);
  const config = loadConfig();
  logger.info("slack.command_received", { command: params.get("command"), ...whoFields(params.get("user_id"), config, params.get("enterprise_id")) });
  try {
    const store = await Store.open({ config, logger });
    const body = await handleNoteCommand({ params, config, backend: store.backend, logger });
    return body ? json(body) : new Response("", { status: 200 });
  } catch (err) {
    logger.error("notes.command_failed", { err });
    if (params.get("user_id") === config.people?.alex?.slackUserId) {
      return json({ response_type: "ephemeral", text: `${IDENTITY_LINE} I could not save that: ${err.message}` });
    }
    return new Response("", { status: 200 });
  }
};

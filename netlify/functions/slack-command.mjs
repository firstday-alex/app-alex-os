// Slack slash commands. Two:
//   /ticket <message link>  turns that message's thread into a Site Backlog ticket, like the
//                           "Create ClickUp ticket" shortcut (src/send/clickup-ticket.js).
//                           Any command with "ticket" in its name. Slack does not tell a
//                           command which thread it was typed in, so it takes the link.
//   /note <text>            saves to the Daily Speech's notes. Any other command pointed at
//                           this URL is treated as /note, so a command renamed in the Slack app
// (because /note was taken in the workspace, say) still saves instead of going silent.
// Verified by Slack's signature like every other inbound Slack request; Alex only, and
// anyone else gets no reply (src/send/slack-notes.js).

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { verifySlackSignature, IDENTITY_LINE } from "../../src/send/slack.js";
import { handleNoteCommand, whoFields } from "../../src/send/slack-notes.js";
import { threadFromLink, handOffTicket } from "../../src/send/clickup-ticket.js";

const say = (text) => ({ response_type: "ephemeral", text: `${IDENTITY_LINE} ${text}` });

/** /ticket <link>. Alex only; anyone else gets no reply. Returns the reply, or null. */
export async function handleTicketCommand({ params, config, logger, handOff = handOffTicket }) {
  const alex = config.people?.alex?.slackUserId;
  if (!alex || params.get("user_id") !== alex) {
    logger?.info?.("ticket.command_ignored", {});
    return null;
  }
  const thread = threadFromLink(params.get("text"));
  if (!thread) return say(`Paste the thread's link after the command: on any message in the thread, ⋯ → Copy link, then ${params.get("command") || "/ticket"} <link>. Or use ⋯ → Create ClickUp ticket on the message itself.`);
  await handOff({ ...thread, responseUrl: params.get("response_url") ?? null }, { logger });
  return say("Reading the thread and its files to make a Site Backlog ticket. I'll reply here with the link in a minute.");
}

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
  if (/ticket/i.test(params.get("command") ?? "")) {
    try {
      const body = await handleTicketCommand({ params, config, logger });
      return body ? json(body) : new Response("", { status: 200 });
    } catch (err) {
      logger.error("ticket.command_failed", { err });
      return params.get("user_id") === config.people?.alex?.slackUserId ? json(say(`I could not start that ticket: ${err.message}`)) : new Response("", { status: 200 });
    }
  }
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

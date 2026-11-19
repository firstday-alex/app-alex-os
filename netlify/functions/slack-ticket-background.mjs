// Makes the ClickUp ticket for the "Create ClickUp ticket" message shortcut and tells Alex.
// A background function, because reading the thread, copying its files and the Claude call
// take longer than the three seconds Slack allows. See src/send/clickup-ticket.js.
//
// The reply goes to Slack's response_url as an ephemeral message: only Alex sees it, and
// nothing is posted in the thread.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { isInternalCall } from "../../src/lib/dashboard-auth.js";
import { IDENTITY_LINE } from "../../src/send/slack.js";
import { ticketFromThread } from "../../src/send/clickup-ticket.js";

async function tell(responseUrl, text, logger) {
  if (!responseUrl) return;
  await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text: `${IDENTITY_LINE} ${text}` }),
    signal: AbortSignal.timeout(5000),
  }).catch((err) => logger.warn("ticket.reply_failed", { err }));
}

export default async (req) => {
  const config = loadConfig();
  const logger = createLogger({ base: { fn: "slack-ticket-background" } });
  if (!isInternalCall(req)) {
    logger.warn("ticket.unauthorized_invoke", {});
    return new Response("forbidden", { status: 403 });
  }
  const { channel, ts, link, responseUrl } = await req.json().catch(() => ({}));
  if (!channel || !ts) return new Response("thread required", { status: 400 });

  try {
    const store = await Store.open({ config, logger });
    const out = await ticketFromThread({ channel, ts, link, config, store, logger });
    await tell(responseUrl, out.text, logger);
  } catch (err) {
    logger.error("ticket.failed", { err });
    await tell(responseUrl, `I could not make that ticket: ${err.message}`, logger);
  }
  return new Response("accepted", { status: 202 });
};

// Runs the Strategic Advisor and posts the answer into the Slack thread.
//
// Split out from slack-interactive because Slack expects an acknowledgement within three
// seconds and an Anthropic call takes longer. A serverless function's invocation ends when
// it returns, so post-response work has to happen in a background function, not in a
// dangling promise.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { advise } from "../../src/agents/strategic-advisor.js";
import { postMessage } from "../../src/send/slack.js";
import { isInternalCall } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const config = loadConfig();
  const logger = createLogger({ base: { fn: "advisor-background" } });

  if (!isInternalCall(req)) {
    logger.warn("advisor.unauthorized_invoke", {});
    return new Response("forbidden", { status: 403 });
  }

  const { flagId, channel, threadTs, clickedBy } = await req.json().catch(() => ({}));
  if (!flagId) return new Response("flagId required", { status: 400 });

  const store = await Store.open({ config, logger });
  logger.info("advisor.working", { flagId, clickedBy });

  let text;
  try {
    const advice = await advise({ flagId, store, config, logger });
    text = advice.error
      ? `I could not produce a recommendation for that item. ${advice.error}`
      : `*Recommendation.*${advice.cached ? " (already worked out earlier today)" : ""}\n\n${advice.text}`;
  } catch (err) {
    logger.error("advisor.failed", { err, flagId });
    text = `I hit an error working on that recommendation: ${err.message}`;
  }

  if (channel && process.env.SLACK_BOT_TOKEN) {
    await postMessage({ channel, threadTs, text, token: process.env.SLACK_BOT_TOKEN, logger, config }).catch((err) =>
      logger.error("advisor.slack_reply_failed", { err, flagId }),
    );
  }

  return new Response("accepted", { status: 202 });
};

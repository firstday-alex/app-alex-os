// The Stand-up tab's API.
//
//   GET /standup   the stand-ups posted in the channel over the lookback, by day
//
// Read live from Slack on each call, read only. Nothing is stored.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { fetchStandups } from "../../src/collectors/standup.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "standup" } });
  try {
    return json(await fetchStandups({ config, token: process.env.SLACK_BOT_TOKEN, logger }));
  } catch (err) {
    logger.warn("standup.failed", { err: err.slackError ?? err.message });
    return json({ error: err.message, slackError: err.slackError ?? null }, 502);
  }
};

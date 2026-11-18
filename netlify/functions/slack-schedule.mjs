// Schedules a drafted nudge as a Slack DM from Alex's own account. See src/send/slack-schedule.js.
//
//   POST /slack-schedule   { to: "<roster name>", text, postAt: "<ISO time>" }
//   POST /slack-schedule   { cancel: { channel, scheduledId } }
//   GET  /slack-schedule   what is scheduled now, from Slack (when, to whom, the text)

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";
import { scheduleNudge, cancelNudge, listScheduled } from "../../src/send/slack-schedule.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  const config = loadConfig();
  const logger = createLogger({ base: { fn: "slack-schedule" } });
  const token = process.env.SLACK_USER_TOKEN;
  if (req.method === "GET") {
    try {
      return json(await listScheduled({ config, logger, token }));
    } catch (err) {
      return json({ error: err.message }, err.status ?? 500);
    }
  }
  if (req.method !== "POST") return json({ error: "GET or POST." }, 405);
  const body = await req.json().catch(() => ({}));

  try {
    if (body.cancel) return json(await cancelNudge({ config, logger, token, ...body.cancel }));
    const store = await Store.open({ config, logger });
    return json(await scheduleNudge({ config, store, logger, token, to: body.to, text: body.text, postAt: body.postAt }));
  } catch (err) {
    logger.warn("slack_schedule.refused", { err });
    return json({ error: err.message }, err.status ?? 500);
  }
};

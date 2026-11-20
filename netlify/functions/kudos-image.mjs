// The newest image attached to a ClickUp ticket, for the kudos page's hover screenshots.
//
//   GET /kudos-image?task=<id>   200 with the image, or 204 when the ticket has none
//
// Read only; behind the dashboard login like every other dashboard call.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";
import { ticketImage } from "../../src/send/kudos-image.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  const logger = createLogger({ base: { fn: "kudos-image" } });
  try {
    const got = await ticketImage({ taskId: new URL(req.url).searchParams.get("task"), config: loadConfig(), token: process.env.CLICKUP_TOKEN, logger });
    if (!got) return new Response(null, { status: 204 });
    return new Response(got.bytes, { status: 200, headers: { "content-type": got.type, "cache-control": "private, max-age=600" } });
  } catch (err) {
    logger.warn("kudos_image.failed", { err });
    return json({ error: err.message }, err.status ?? 500);
  }
};

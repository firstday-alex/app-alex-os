// The newest image attached to a ClickUp ticket, for the kudos page's hover screenshots.
//
//   GET  /kudos-image?task=<id>          200 with the image, or 204 when the ticket has none
//   GET  /kudos-image?url=<ClickUp link>  that image (a saved version keeps links, not copies)
//   POST /kudos-image { task, photo }    attach the photo (a data URL) to the ticket → { url }
//
// Behind the dashboard login like every other dashboard call.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";
import { ticketImage, attachImage, clickupImage } from "../../src/send/kudos-image.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  const logger = createLogger({ base: { fn: "kudos-image" } });
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const out = await attachImage({ taskId: body.task, dataUrl: body.photo, config: loadConfig(), token: process.env.CLICKUP_TOKEN });
      logger.info("kudos_image.attached", { task: body.task });
      return json(out);
    }
    const q = new URL(req.url).searchParams;
    if (q.get("url")) {
      const img = await clickupImage({ url: q.get("url"), token: process.env.CLICKUP_TOKEN });
      if (!img) return new Response(null, { status: 204 });
      return new Response(img.bytes, { status: 200, headers: { "content-type": img.type, "cache-control": "private, max-age=86400" } });
    }
    const got = await ticketImage({ taskId: new URL(req.url).searchParams.get("task"), config: loadConfig(), token: process.env.CLICKUP_TOKEN, logger });
    if (!got) return new Response(null, { status: 204 });
    // x-image-url: the attachment's own link, which a saved version keeps instead of a copy.
    const headers = { "content-type": got.type, "cache-control": "private, max-age=600" };
    if (got.url && got.url.length <= 1000) headers["x-image-url"] = got.url;
    return new Response(got.bytes, { status: 200, headers });
  } catch (err) {
    logger.warn("kudos_image.failed", { err });
    return json({ error: err.message }, err.status ?? 500);
  }
};

// Takes the hourly ClickUp snapshot the dashboard's 24 hour and today views compare
// against. Reads ClickUp, writes only to this system's own store.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { isInternalCall } from "../../src/lib/dashboard-auth.js";
import { takeHourlySnapshot } from "../../src/hourly-snapshot.js";

export default async (req) => {
  const config = loadConfig();
  const logger = createLogger({ base: { fn: "snapshot-hourly-background" } });
  if (!isInternalCall(req)) {
    logger.warn("hourly.unauthorized_invoke", {});
    return new Response("forbidden", { status: 403 });
  }
  if (config.system.storage?.hourlySnapshots === false) {
    logger.info("hourly.disabled", {});
    return new Response("disabled", { status: 202 });
  }

  const store = await Store.open({ config, logger });
  try {
    await takeHourlySnapshot({ config, store, token: process.env.CLICKUP_TOKEN, logger });
  } catch (err) {
    logger.error("hourly.failed", { err });
    throw err;
  }
  return new Response("accepted", { status: 202 });
};

// The hourly trigger. Like the 8 AM one, it only hands off: a ClickUp crawl with retries
// can outlast a scheduled function's short limit, and a background function cannot.

import { createLogger } from "../../src/lib/logger.js";
import { json } from "../../src/lib/dashboard-auth.js";

export default async () => {
  const logger = createLogger({ base: { fn: "snapshot-hourly" } });
  const base = process.env.URL ?? process.env.DEPLOY_PRIME_URL ?? "http://localhost:8888";
  try {
    const response = await fetch(`${base}/.netlify/functions/snapshot-hourly-background`, {
      method: "POST",
      headers: { "x-mos-internal": process.env.DASHBOARD_COOKIE_SECRET ?? "" },
      signal: AbortSignal.timeout(10000),
    });
    logger.info("hourly.handed_off", { status: response.status });
    return json({ ran: true, handoffStatus: response.status });
  } catch (err) {
    logger.error("hourly.handoff_failed", { err });
    return json({ ran: false, reason: err.message }, 500);
  }
};

export const config = {
  // Five past, so it never lands on the same minute as the 8 AM readout's crawl.
  schedule: "5 * * * *",
};

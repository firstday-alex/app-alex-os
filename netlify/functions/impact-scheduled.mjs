// The daily Alex's Impact trigger: 9 AM Central on working days, an hour after the 8 AM
// readout, so the pass reads that morning's fresh report. Like scheduled-readout, the cron
// fires at two UTC hours and the Central hour decides, so DST is not chased in the cron.

import { loadConfig } from "../../src/config.js";
import { zonedParts } from "../../src/lib/time.js";
import { createLogger } from "../../src/lib/logger.js";
import { json } from "../../src/lib/dashboard-auth.js";

export default async () => {
  const config = loadConfig();
  const logger = createLogger({ base: { fn: "impact-scheduled" } });
  const parts = zonedParts(new Date(), config.system.timezone);
  const targetHour = config.system.impact?.hourCentral ?? 9;
  const weekdays = config.system.schedule?.workingWeekdays ?? [1, 2, 3, 4, 5];
  if (!weekdays.includes(parts.weekday) || parts.hour !== targetHour) {
    return json({ ran: false, reason: `Central ${parts.weekdayName} ${parts.hour}:00, target ${targetHour}:00 on a working day` });
  }

  const base = process.env.URL ?? process.env.DEPLOY_PRIME_URL ?? "http://localhost:8888";
  try {
    const response = await fetch(`${base}/.netlify/functions/impact-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mos-internal": process.env.DASHBOARD_COOKIE_SECRET ?? "" },
      body: JSON.stringify({ startedAt: new Date().toISOString() }),
      signal: AbortSignal.timeout(10000),
    });
    logger.info("impact.handed_off", { status: response.status });
    return json({ ran: true, handoffStatus: response.status });
  } catch (err) {
    logger.error("impact.handoff_failed", { err });
    return json({ ran: false, reason: err.message }, 500);
  }
};

export const config = {
  // 14:00 and 15:00 UTC. Exactly one of them is 9 AM Central on any given day.
  schedule: "0 14,15 * * 1-5",
};

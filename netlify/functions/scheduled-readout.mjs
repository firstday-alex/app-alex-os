// The 8 AM trigger. Scheduled functions have a short execution limit, so this one does
// exactly one thing: decide whether now is 8 AM Central on a working day, invoke the
// background function, and exit.
//
// Cron runs in UTC and Central shifts with daylight saving, so this fires at both 13:00
// and 14:00 UTC and the function checks the Central hour. DST is not chased in the cron
// string. Weekends are skipped the same way.
//
// Scheduled functions receive no payload and cannot be called with POST data. Every
// parameter comes from config.

import { loadConfig } from "../../src/config.js";
import { shouldRunScheduled } from "../../src/lib/time.js";
import { createLogger, newRunId } from "../../src/lib/logger.js";
import { json } from "../../src/lib/dashboard-auth.js";

export default async () => {
  const config = loadConfig();
  const now = new Date();
  const runId = newRunId(now);
  const logger = createLogger({ runId, base: { fn: "scheduled-readout" } });

  const decision = shouldRunScheduled(now, config);
  if (!decision.run) {
    logger.info("scheduled.skipped", {
      reason: decision.reason,
      centralHour: decision.parts.hour,
      weekday: decision.parts.weekdayName,
    });
    return json({ ran: false, reason: decision.reason });
  }

  logger.info("scheduled.firing", { reason: decision.reason, runId });

  const base = process.env.URL ?? process.env.DEPLOY_PRIME_URL ?? "http://localhost:8888";
  let handoffStatus = null;
  try {
    const response = await fetch(`${base}/.netlify/functions/run-pipeline-background`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mos-internal": process.env.DASHBOARD_COOKIE_SECRET ?? "",
      },
      body: JSON.stringify({ mode: "official", runId }),
      signal: AbortSignal.timeout(10000),
    });
    handoffStatus = response.status;
  } catch (err) {
    logger.error("scheduled.handoff_failed", { err });
    return json({ ran: false, reason: `handoff failed: ${err.message}`, runId }, 500);
  }

  // Background functions return 202 immediately. The caller cannot wait for the result
  // and does not try to.
  logger.info("scheduled.handed_off", { handoffStatus, runId });
  return json({ ran: true, handoffStatus, runId });
};

export const config = {
  // 13:00 and 14:00 UTC. Exactly one of them is 8 AM Central on any given day.
  schedule: "0 13,14 * * 1-5",
};

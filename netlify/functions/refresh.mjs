// The dashboard's on demand refresh. Re-pulls the system now.
//
// Available anytime. The baseline stays pinned to the previous working day's 8 AM
// snapshot, so mid day this is a live preview of what tomorrow's 8 AM readout would say
// if nothing else changed. The scheduled 8 AM send remains the official daily readout.
//
// Background functions return 202 immediately and the caller cannot wait for the result,
// so this hands back a runId and the dashboard polls the report endpoint for it.

import { loadConfig } from "../../src/config.js";
import { createLogger, newRunId } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const config = loadConfig();
  const now = new Date();
  const runId = newRunId(now);
  const logger = createLogger({ runId, base: { fn: "refresh" } });
  const store = await Store.open({ config, logger });

  // Cheap throttle so a held-down refresh button cannot hammer either API.
  const minInterval = config.system.dashboard?.refreshMinIntervalSeconds ?? 60;
  const last = await store.backend.get("refresh/last.json");
  if (last && now.getTime() - new Date(last.at).getTime() < minInterval * 1000) {
    const waitSeconds = Math.ceil((minInterval * 1000 - (now.getTime() - new Date(last.at).getTime())) / 1000);
    return json({ started: false, reason: `A refresh ran ${Math.round((now - new Date(last.at)) / 1000)}s ago. Try again in ${waitSeconds}s.`, runId: last.runId }, 429);
  }
  await store.backend.set("refresh/last.json", { at: now.toISOString(), runId });

  const base = process.env.URL ?? process.env.DEPLOY_PRIME_URL ?? "http://localhost:8888";
  try {
    const response = await fetch(`${base}/.netlify/functions/run-pipeline-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mos-internal": process.env.DASHBOARD_COOKIE_SECRET ?? "" },
      body: JSON.stringify({ mode: "refresh", runId }),
      signal: AbortSignal.timeout(10000),
    });
    logger.info("refresh.handed_off", { status: response.status, runId });
    return json({ started: true, runId, poll: "/.netlify/functions/report" }, 202);
  } catch (err) {
    logger.error("refresh.handoff_failed", { err });
    return json({ started: false, reason: err.message, runId }, 500);
  }
};

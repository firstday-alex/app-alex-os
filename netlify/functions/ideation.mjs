// The Ideation tab's API.
//
//   GET  /ideation   the last analysis, and whether one is running
//   POST /ideation   start a new one
//
// The analysis is one Anthropic call over the whole sprint, longer than a normal function
// may run, so POST hands it to ideation-background and the tab polls GET until the
// stored result is newer than the start.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { IDEATION_KEY } from "../../src/agents/ideation.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";

const IDEATION_STATUS_KEY = "ideation/status.json";
// A run that has not finished in this long has died. Let the button work again.
const RUNNING_FOR_AT_MOST_MS = 10 * 60 * 1000;

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "ideation" } });
  const store = await Store.open({ config, logger });
  const [latest, status] = await Promise.all([store.backend.get(IDEATION_KEY), store.backend.get(IDEATION_STATUS_KEY)]);
  const running = status?.state === "running" && Date.now() - new Date(status.startedAt).getTime() < RUNNING_FOR_AT_MOST_MS;

  if (req.method === "GET") return json({ latest: latest ?? null, status: status ? { ...status, running } : null });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  if (running) return json({ started: false, reason: "An analysis is already running.", status }, 409);

  const startedAt = new Date().toISOString();
  await store.backend.set(IDEATION_STATUS_KEY, { state: "running", startedAt });
  const base = process.env.URL ?? process.env.DEPLOY_PRIME_URL ?? "http://localhost:8888";
  try {
    const response = await fetch(`${base}/.netlify/functions/ideation-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mos-internal": process.env.DASHBOARD_COOKIE_SECRET ?? "" },
      body: JSON.stringify({ startedAt }),
      signal: AbortSignal.timeout(10000),
    });
    logger.info("ideation.handed_off", { status: response.status });
    return json({ started: true, startedAt }, 202);
  } catch (err) {
    logger.error("ideation.handoff_failed", { err });
    await store.backend.set(IDEATION_STATUS_KEY, { state: "failed", startedAt, error: err.message });
    return json({ started: false, reason: err.message }, 500);
  }
};

// The Alex's Impact tab's API.
//
//   GET  /impact   the ledger (items and themes), and whether a pass is running
//   POST /impact   start a pass now: harvest, then regroup
//
// A pass is one Anthropic call over the whole record, longer than a normal function may
// run, so POST hands it to impact-background and the tab polls GET.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { LEDGER_KEY, STATUS_KEY } from "../../src/impact/ledger.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";

// A pass that has not finished in this long has died. Let the button work again.
const RUNNING_FOR_AT_MOST_MS = 10 * 60 * 1000;

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "impact" } });
  const store = await Store.open({ config, logger });
  const [ledger, status] = await Promise.all([store.backend.get(LEDGER_KEY), store.backend.get(STATUS_KEY)]);
  const running = status?.state === "running" && Date.now() - new Date(status.startedAt).getTime() < RUNNING_FOR_AT_MOST_MS;

  if (req.method === "GET") return json({ ledger: ledger ?? null, status: status ? { ...status, running } : null });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (running) return json({ started: false, reason: "A pass is already running.", status }, 409);

  const startedAt = new Date().toISOString();
  await store.backend.set(STATUS_KEY, { state: "running", startedAt, trigger: "button" });
  const base = process.env.URL ?? process.env.DEPLOY_PRIME_URL ?? "http://localhost:8888";
  try {
    await fetch(`${base}/.netlify/functions/impact-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mos-internal": process.env.DASHBOARD_COOKIE_SECRET ?? "" },
      body: JSON.stringify({ startedAt }),
      signal: AbortSignal.timeout(10000),
    });
    return json({ started: true, startedAt }, 202);
  } catch (err) {
    logger.error("impact.handoff_failed", { err });
    await store.backend.set(STATUS_KEY, { state: "failed", startedAt, error: err.message });
    return json({ started: false, reason: err.message }, 500);
  }
};

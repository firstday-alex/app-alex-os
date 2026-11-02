// Runs the daily Alex's Impact pass. A background function, so the one Anthropic call
// over the whole record has its 15 minute budget. Started by impact-scheduled each working
// morning and by /impact when Alex presses "Reorganize now".

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { massageImpact } from "../../src/agents/impact.js";
import { STATUS_KEY } from "../../src/impact/ledger.js";
import { isInternalCall } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const config = loadConfig();
  const logger = createLogger({ base: { fn: "impact-background" } });
  if (!isInternalCall(req)) {
    logger.warn("impact.unauthorized_invoke", {});
    return new Response("forbidden", { status: 403 });
  }

  const { startedAt = new Date().toISOString() } = await req.json().catch(() => ({}));
  const store = await Store.open({ config, logger });
  await store.backend.set(STATUS_KEY, { state: "running", startedAt });
  try {
    const { run } = await massageImpact({ store, config, logger });
    await store.backend.set(STATUS_KEY, { state: "done", startedAt, finishedAt: run.at, added: run.added, reorganized: run.reorganized, error: run.error });
  } catch (err) {
    logger.error("impact.failed", { err });
    await store.backend.set(STATUS_KEY, { state: "failed", startedAt, error: err.message });
  }
  return new Response("accepted", { status: 202 });
};

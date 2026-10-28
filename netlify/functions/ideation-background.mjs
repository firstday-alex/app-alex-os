// Runs the Ideation analysis. A background function, so the one long Anthropic call over
// the whole sprint has its 15 minute budget. Started only by /ideation, on Alex's click.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { ideate } from "../../src/agents/ideation.js";
import { isInternalCall } from "../../src/lib/dashboard-auth.js";

const STATUS_KEY = "ideation/status.json";

export default async (req) => {
  const config = loadConfig();
  const logger = createLogger({ base: { fn: "ideation-background" } });

  if (!isInternalCall(req)) {
    logger.warn("ideation.unauthorized_invoke", {});
    return new Response("forbidden", { status: 403 });
  }

  const { startedAt } = await req.json().catch(() => ({}));
  const store = await Store.open({ config, logger });
  try {
    const result = await ideate({ store, config, logger });
    await store.backend.set(
      STATUS_KEY,
      result.error ? { state: "failed", startedAt, error: result.error } : { state: "done", startedAt, finishedAt: result.generatedAt },
    );
  } catch (err) {
    logger.error("ideation.failed", { err });
    await store.backend.set(STATUS_KEY, { state: "failed", startedAt, error: err.message });
  }
  return new Response("accepted", { status: 202 });
};

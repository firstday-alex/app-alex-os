// The Strategic Advisor button, from the dashboard.
//
// Agentic. One Anthropic call per click. Nothing runs without the click.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { advise } from "../../src/agents/strategic-advisor.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "advisor" } });
  const store = await Store.open({ config, logger });

  const { flagId, fresh } = await req.json().catch(() => ({}));
  if (!flagId) return json({ error: "flagId is required" }, 400);

  try {
    const advice = await advise({ flagId, store, config, logger, reuseCached: !fresh });
    if (advice.error) return json(advice, 422);
    return json(advice);
  } catch (err) {
    logger.error("advisor.failed", { err, flagId });
    return json({ error: err.message }, 500);
  }
};

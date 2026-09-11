// The pipeline. A background function, so it gets a 15 minute budget rather than the
// scheduled function's short one. Three collectors and a render fit inside that easily.
//
// Netlify retries a failed background function once after a minute and again after two.
// That free retry is exactly why idempotence matters here: the Slack post is keyed on the
// run date and checked before sending, so a retry cannot double post.

import { runPipeline } from "../../src/pipeline.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { isInternalCall } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const config = loadConfig();
  const logger = createLogger({ base: { fn: "run-pipeline-background" } });

  if (!isInternalCall(req)) {
    logger.warn("pipeline.unauthorized_invoke", {});
    return new Response("forbidden", { status: 403 });
  }

  const payload = await req.json().catch(() => ({}));
  const mode = payload.mode === "official" ? "official" : "refresh";

  try {
    const result = await runPipeline({ config, mode, runId: payload.runId, logger });
    logger.info("pipeline.done", {
      runId: result.runId,
      outcome: result.outcome,
      flags: result.report.flags.length,
      delivered: result.delivery.sent,
    });
  } catch (err) {
    // Throwing is what tells Netlify to use its retry. Log first so the reason survives.
    logger.error("pipeline.crashed", { err });
    throw err;
  }

  return new Response("accepted", { status: 202 });
};

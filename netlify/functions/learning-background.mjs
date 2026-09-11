// Runs the Learning Skill on one piece of Slack feedback: propose the edit, open the
// pull request, and say back in the thread exactly what would change and where.
//
// Split out from slack-events for the same reason as the advisor: Slack wants a fast
// acknowledgement, and this does a model call plus three GitHub calls.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { handleFeedback } from "../../src/agents/learning-skill.js";
import { isInternalCall } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const config = loadConfig();
  const logger = createLogger({ base: { fn: "learning-background" } });

  if (!isInternalCall(req)) {
    logger.warn("learning.unauthorized_invoke", {});
    return new Response("forbidden", { status: 403 });
  }

  const { feedback } = await req.json().catch(() => ({}));
  if (!feedback?.text) return new Response("feedback required", { status: 400 });

  const store = await Store.open({ config, logger });
  const report = await store.getLatestReport();

  try {
    const result = await handleFeedback({
      feedback,
      reportContext: report
        ? {
            runId: report.runId,
            dateKey: report.dateKey,
            summary: report.summary,
            flags: (report.flags ?? []).map((f) => ({ id: f.id, rule: f.rule, message: f.message })),
          }
        : null,
      config,
      logger,
      store,
    });
    logger.info("learning.handled", { proposed: result.proposed, pr: result.pr?.number ?? null });
  } catch (err) {
    logger.error("learning.failed", { err });
  }

  return new Response("accepted", { status: 202 });
};

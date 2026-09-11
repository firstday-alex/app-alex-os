// Skill 5. Strategic Advisor. Agentic. On demand only. Never runs on its own.
//
// Triggered when Alex clicks the button on an item the dashboard or the Slack readout has
// already flagged as needing attention. Nothing else invokes it. It gets the flagged item
// plus its stored context, and returns a recommendation with the reasoning and the trade
// offs it weighed.
//
// The business context lives in skills/strategic-advisor/SKILL.md. That file is the one
// piece of this system expected to keep changing, and the Learning Skill can edit it with
// Alex's approval, same as the manager skills.

import { ask, readSkill } from "./anthropic.js";

/**
 * Assembles everything known about one flagged item. The advisor sees no more and no less
 * than this, which is what makes its answers reproducible enough to argue with.
 */
export function gatherContext({ flag, report, config }) {
  const detail = report.detail ?? {};
  const context = { flag, dateKey: report.dateKey, mode: report.mode };

  if (flag.subject?.type === "task") {
    const taskId = String(flag.subject.id).split(":")[0];
    context.task = (detail.clickup?.tasks ?? []).find((t) => t.id === taskId) ?? null;
    const priorityLabel = context.task?.leadershipPriority?.label ?? null;
    context.leadershipPriority =
      (detail.leadership?.queue ?? []).find((i) => String(i.title).toLowerCase() === String(priorityLabel).toLowerCase()) ?? null;
  }

  if (flag.subject?.type === "test") {
    const testId = String(flag.subject.id).split(":")[0];
    context.test = (detail.intelligems?.tests ?? []).find((t) => t.id === testId) ?? null;
    // The stored reference values, so long term value can be weighed against immediate
    // conversion rather than ignored.
    context.ltvReferences = config.references?.ltv ?? null;
    context.readinessGate = config.intelligems.readinessGate;
    context.verdictMap = config.intelligems.verdictMap;
  }

  if (flag.subject?.type === "person") {
    const personId = String(flag.subject.id).split(":")[0];
    context.person = (detail.crossLayer?.people ?? []).find((p) => p.id === personId) ?? null;
    context.leadershipQueue = detail.leadership?.queue ?? [];
  }

  if (flag.subject?.type === "priority" || flag.subject?.type === "queue") {
    context.leadershipQueue = detail.leadership?.queue ?? [];
    context.leadershipBacklog = detail.leadership?.backlog ?? [];
    context.item = (detail.leadership?.queue ?? []).find((i) => i.id === flag.subject.id) ?? null;
  }

  context.otherFlagsOnSameSubject = (report.flags ?? []).filter(
    (f) => f.id !== flag.id && String(f.subject?.id).split(":")[0] === String(flag.subject?.id).split(":")[0],
  );

  return context;
}

export async function advise({ flagId, store, config, env = process.env, logger, reuseCached = true }) {
  const cached = reuseCached ? await store.getAdvice(flagId) : null;
  if (cached) {
    logger?.info?.("advisor.cache_hit", { flagId });
    return { ...cached, cached: true };
  }

  const report = await store.getLatestReport();
  if (!report) return { error: "There is no report in storage yet, so there is nothing to advise on." };

  const flag = (report.flags ?? []).find((f) => f.id === flagId);
  if (!flag) {
    return { error: `Flag ${flagId} is not in the latest readout. It may have resolved itself, or the readout has moved on.` };
  }

  const context = gatherContext({ flag, report, config });
  const system = readSkill("strategic-advisor");

  const result = await ask({
    system,
    config,
    env,
    logger,
    messages: [
      {
        role: "user",
        content: [
          "Alex clicked the button on this flagged item and wants a recommendation.",
          "",
          "THE FLAG",
          JSON.stringify({ rule: flag.rule, layer: flag.layer, severity: flag.severity, message: flag.message, values: flag.values }, null, 2),
          "",
          "STORED CONTEXT",
          JSON.stringify(context, null, 2),
          "",
          "Give a recommendation, the reasoning behind it, and the trade offs you weighed.",
          "Say plainly when the data does not support a call yet.",
        ].join("\n"),
      },
    ],
  });

  if (result.refused) {
    return { error: "The model declined to answer this one.", category: result.category, flagId };
  }

  const advice = {
    flagId,
    rule: flag.rule,
    subject: flag.subject,
    reportRunId: report.runId,
    dateKey: report.dateKey,
    askedAt: new Date().toISOString(),
    text: result.text,
    model: result.response?.model ?? null,
    usage: {
      inputTokens: result.response?.usage?.input_tokens ?? null,
      outputTokens: result.response?.usage?.output_tokens ?? null,
    },
  };

  await store.putAdvice(flagId, advice);
  logger?.info?.("advisor.answered", { flagId, rule: flag.rule, chars: result.text?.length ?? 0 });
  return advice;
}

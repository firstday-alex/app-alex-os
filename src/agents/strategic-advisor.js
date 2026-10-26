// Skill 5. Strategic Advisor. Agentic. On demand only. Never runs on its own.
//
// Triggered when Alex clicks the button on an item the dashboard or the Slack readout has
// already flagged as needing attention. Nothing else invokes it. It gets the flagged item
// plus its stored context, and returns a recommendation with the reasoning and the trade
// offs it weighed.
//
// The goals come from the rocks, read fresh from the latest report on every call, so the
// advisor weighs a flag against what leadership is actually chasing this quarter. The
// standing context (how the business works, constraints, risk appetite) lives in
// skills/strategic-advisor/SKILL.md, which the Learning Skill can edit with Alex's
// approval, same as the manager skills.

import { ask, readSkill } from "./anthropic.js";
import { SettingsStore } from "../store/settings.js";

const LTV_KEYS = [
  "subscriptionLtvMultiplier",
  "oneTimeLtvMultiplier",
  "ltvMultiplierHorizonMonths",
  "ltvMultipliersAsOf",
  "subscriptionLtv6mo",
  "oneTimeLtv6mo",
  "ltvHorizonMonths",
  "ltvAsOf",
];

/**
 * The rocks, active and recently shipped, trimmed to what a recommendation is weighed
 * against. They are the biggest goals this quarter, so every answer sees all of them,
 * whatever the flag is about.
 */
export function rocksForAdvice(queue = []) {
  return queue.map((rock) => ({
    id: rock.id,
    title: rock.title,
    priority: rock.priority ?? null,
    state: rock.state ?? null,
    status: rock.status ?? null,
    owner: rock.owner?.name ?? null,
    kpi: rock.kpi ?? null,
    checkInDate: rock.checkInDate ?? null,
    shippedAt: rock.shippedAt || null,
    intelligemsExperienceId: rock.intelligemsExperienceId ?? null,
    notes: rock.notes ?? null,
  }));
}

/** The rock a ticket serves, through its Big Swing option, else by Big Swing label. */
function rockForTask(task, queue) {
  const swing = task?.bigSwing;
  if (!swing?.optionId && !swing?.label) return null;
  return (
    queue.find((r) => swing.optionId && r.clickupBigSwingOptionId && String(r.clickupBigSwingOptionId) === String(swing.optionId)) ??
    queue.find((r) => swing.label && String(r.title).trim().toLowerCase() === String(swing.label).trim().toLowerCase()) ??
    null
  );
}

/**
 * Assembles everything known about one flagged item. The advisor sees no more and no less
 * than this, which is what makes its answers reproducible enough to argue with.
 */
export function gatherContext({ flag, report, config, settings = null }) {
  const detail = report.detail ?? {};
  const queue = detail.leadership?.queue ?? [];
  const context = { flag, dateKey: report.dateKey, mode: report.mode, rocks: rocksForAdvice(queue) };

  if (flag.subject?.type === "task") {
    const taskId = String(flag.subject.id).split(":")[0];
    context.task = (detail.clickup?.tasks ?? []).find((t) => t.id === taskId) ?? null;
    context.rock = rockForTask(context.task, queue)?.id ?? null;
  }

  if (flag.subject?.type === "test") {
    const testId = String(flag.subject.id).split(":")[0];
    context.test = (detail.intelligems?.tests ?? []).find((t) => t.id === testId) ?? null;
    context.rock = queue.find((r) => r.intelligemsExperienceId && String(r.intelligemsExperienceId) === testId)?.id ?? null;
    // The stored reference values, so long term value can be weighed against immediate
    // conversion rather than ignored.
    context.ltvReferences = settings ? Object.fromEntries(LTV_KEYS.map((k) => [k, settings[k] ?? null])) : null;
    context.readinessGate = config.intelligems.readinessGate;
    context.verdictMap = config.intelligems.verdictMap;
  }

  if (flag.subject?.type === "person") {
    const personId = String(flag.subject.id).split(":")[0];
    context.person = (detail.crossLayer?.people ?? []).find((p) => p.id === personId) ?? null;
  }

  if (flag.subject?.type === "priority" || flag.subject?.type === "queue") {
    context.leadershipBacklog = detail.leadership?.backlog ?? [];
    context.rock = queue.find((i) => i.id === flag.subject.id)?.id ?? null;
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

  const settings = await new SettingsStore(store.backend, logger)
    .read()
    .then((d) => d.settings)
    .catch((err) => {
      logger?.warn?.("advisor.settings_unreadable", { err });
      return null;
    });
  const { rocks, ...context } = gatherContext({ flag, report, config, settings });
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
          "THE ROCKS",
          "This quarter's biggest goals. Weigh the call by what it does for them. When context.rock is set, it names the rock this item serves.",
          JSON.stringify(rocks, null, 2),
          "",
          "THE FLAG",
          JSON.stringify(
            { rule: flag.rule, layer: flag.layer, severity: flag.severity, message: flag.message, values: flag.values },
            null,
            2,
          ),
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

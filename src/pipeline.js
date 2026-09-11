// The pipeline. Each stage is a separate function with a clear input and output:
// collector returns a snapshot, delta returns flags, renderer returns a report, sender
// posts it. That separation is what makes the whole thing testable.
//
// Every stage in here is deterministic code. No model runs in the daily readout. The two
// agentic surfaces (Strategic Advisor, Learning Skill) live in src/agents/ and only run
// when Alex clicks a button or replies with feedback.

import { loadConfig, validateConfig } from "./config.js";
import { createLogger, newRunId } from "./lib/logger.js";
import { Store } from "./lib/storage.js";
import { RocksStore } from "./store/rocks.js";
import { SettingsStore } from "./store/settings.js";
import { dateKey as toDateKey, zonedParts, baselineCandidateKeys } from "./lib/time.js";
import { collectClickUp } from "./collectors/clickup.js";
import { collectIntelligems } from "./collectors/intelligems.js";
import { collectLeadership } from "./collectors/leadership.js";
import { collectShopify } from "./collectors/shopify.js";
import { computeFlags } from "./delta/index.js";
import { buildReport } from "./render/report.js";
import { sendReadout } from "./send/slack.js";

/**
 * @param {object} opts
 * @param {'official'|'refresh'} opts.mode
 *   official - the scheduled 8 AM send. Writes the day's baseline snapshot, posts to Slack.
 *   refresh  - the dashboard's on demand re-pull. Same pinned baseline, no Slack post.
 * @param {Date} [opts.now]
 * @param {boolean} [opts.dryRun] run everything, skip the Slack post
 */
export async function runPipeline(opts = {}) {
  const config = opts.config ?? loadConfig();
  const now = opts.now ?? new Date();
  const mode = opts.mode ?? "refresh";
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  // Injectable so tests do not sit through the real retry backoff.
  const sleep = opts.sleep;

  const runId = opts.runId ?? newRunId(now);
  const logger = opts.logger ?? createLogger({ runId, level: config.system.logging?.level });
  const startedAt = Date.now();

  const tz = config.system.timezone;
  const parts = zonedParts(now, tz);
  const dateKey = parts.dateKey;
  const timeKey = parts.timeKey;

  logger.info("run.start", { mode, dateKey, timeKey, tz, centralHour: parts.hour });

  const problems = validateConfig(config);
  for (const problem of problems) {
    logger[problem.level === "fatal" ? "error" : "warn"]("config.problem", problem);
  }
  const fatal = problems.filter((p) => p.level === "fatal");

  const store = opts.store ?? (await Store.open({ config, logger, mode: opts.storageMode }));

  // The baseline is pinned: the previous WORKING day's official 8 AM snapshot. It is the
  // same answer at 8 AM and at 2 PM, so a mid-day refresh is a live preview of what
  // tomorrow's 8 AM readout would say if nothing else changed.
  const { candidates } = baselineCandidateKeys(now, config);

  const baselines = {};
  for (const source of ["clickup", "intelligems", "leadership", "shopify"]) {
    baselines[source] = await store.getBaseline(source, candidates);
  }

  /* ------------------------------- collectors -------------------------------
     Collectors fail independently. If Intelligems is down, the ClickUp readout still
     goes out with a clear line saying that section is missing and why. A partial
     readout beats no readout. A failed collector never overwrites a good snapshot, so
     the baseline stays intact. */

  const snapshots = { errors: {} };

  const runCollector = async (name, fn) => {
    const t0 = Date.now();
    try {
      if (fatal.length && name === "clickup") {
        throw new Error(fatal.map((f) => f.message).join(" "));
      }
      const snapshot = await fn();
      snapshots[name] = snapshot;
      logger.info("collector.ok", { collector: name, durationMs: Date.now() - t0, items: snapshot.items?.length ?? null });
      const stored = await store.putSnapshot(name, snapshot, { dateKey, timeKey, mode, runId });
      if (!stored.stored) {
        logger.warn("collector.snapshot_not_stored", { collector: name, reason: stored.reason });
      }
    } catch (err) {
      snapshots.errors[name] = err.message;
      logger.error("collector.failed", { collector: name, durationMs: Date.now() - t0, err });
    }
  };

  await Promise.all([
    runCollector("clickup", () =>
      collectClickUp({
        config,
        token: env.CLICKUP_TOKEN,
        store,
        logger: logger.child({ collector: "clickup" }),
        fetchImpl,
        sleep,
        baseline: baselines.clickup.snapshot,
        now,
      }),
    ),
    runCollector("shopify", () =>
      collectShopify({
        config,
        env,
        store,
        logger: logger.child({ collector: "shopify" }),
        fetchImpl,
        sleep,
        now,
      }),
    ),
    runCollector("intelligems", () =>
      collectIntelligems({
        config,
        token: env.INTELLIGEMS_TOKEN,
        store,
        logger: logger.child({ collector: "intelligems" }),
        fetchImpl,
        sleep,
        now,
      }),
    ),
  ]);

  // Layer 1 reads the ClickUp dropdown options out of the snapshot we just took, so it
  // runs after the other two rather than alongside them. No extra API call.
  const rocksStore = opts.rocksStore ?? new RocksStore(store.backend, logger);

  await runCollector("leadership", () =>
    collectLeadership({
      config,
      rocksStore,
      clickupSnapshot: snapshots.clickup ?? baselines.clickup.snapshot,
      logger: logger.child({ collector: "leadership" }),
      now,
    }),
  );

  /* --------------------------------- delta --------------------------------- */

  // App-level settings: the LTV references and significance thresholds the Layer 3 tree
  // and the future-value projection read.
  let settings = null;
  try {
    settings = (await new SettingsStore(store.backend, logger).read()).settings;
  } catch (err) {
    logger.warn("settings.unavailable", { err, note: "falling back to defaults" });
  }

  const { flags, sections, detail } = computeFlags({
    snapshots,
    baselines,
    config,
    settings,
    dateKey,
    nowIso: now.toISOString(),
    logger,
  });

  /* -------------------------------- render -------------------------------- */

  const baselineDescribe = (() => {
    const dates = [...new Set(Object.values(baselines).map((b) => b.dateKey).filter(Boolean))];
    if (dates.length === 0) return "none. This is the first run.";
    const stale = Object.entries(baselines).filter(([, b]) => b.stale).map(([name]) => name);
    const base = `${dates.join(", ")} 8 AM Central`;
    return stale.length ? `${base} (${stale.join(", ")} baseline is older than the previous working day)` : base;
  })();

  const report = buildReport({
    runId,
    mode,
    dateKey,
    nowIso: now.toISOString(),
    flags,
    sections,
    detail,
    baseline: {
      describe: baselineDescribe,
      bySource: Object.fromEntries(
        Object.entries(baselines).map(([name, b]) => [name, { dateKey: b.dateKey, key: b.key, stale: b.stale }]),
      ),
      candidatesConsidered: candidates,
    },
    config,
  });

  report.configProblems = problems;
  const reportKey = await store.putReport(report);

  /* --------------------------------- send --------------------------------- */

  let delivery = { sent: false, reason: "not attempted" };
  if (opts.dryRun) {
    delivery = { sent: false, reason: "dry run" };
  } else if (mode === "official") {
    delivery = await sendReadout({
      report,
      store,
      config,
      token: env.SLACK_BOT_TOKEN,
      channel: env.SLACK_READOUT_CHANNEL,
      logger,
      fetchImpl,
      sleep,
    });
  } else {
    delivery = { sent: false, reason: "refresh runs do not post to Slack. The 8 AM send is the official readout." };
  }

  const outcome = snapshots.errors && Object.keys(snapshots.errors).length
    ? Object.keys(snapshots.errors).length === 3
      ? "failed"
      : "partial"
    : "success";

  logger.info("run.end", {
    outcome,
    durationMs: Date.now() - startedAt,
    flags: flags.length,
    reportKey,
    delivered: delivery.sent,
    missing: report.missing.map((m) => m.section),
  });

  if (config.system.logging?.persistRunLogToStorage) {
    await store.putRunLog(runId, dateKey, {
      runId,
      mode,
      dateKey,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      outcome,
      records: logger.records(),
    });
  }

  return { runId, mode, dateKey, outcome, report, reportKey, delivery, baselines, logger };
}

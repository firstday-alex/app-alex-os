// The delta stage. Snapshots in, a flags list out.
//
// Layer 1 and cross-layer flags come from their own modules. This file raises the Layer 2
// and Layer 3 flags and assembles everything into one sorted, logged list.

import { makeFlag, sortFlags, logFlags } from "./flags.js";
import { metricLabel, formatMetricValue } from "./p1band.js";
import { describeResult } from "./readiness.js";
import { preSprintCheck } from "./pre-sprint.js";
import { clickupDelta } from "./clickup-delta.js";
import { intelligemsDelta } from "./intelligems-delta.js";
import { leadershipChecks } from "./leadership-checks.js";
import { crossLayerCheck } from "./crosslayer.js";

export { clickupDelta, intelligemsDelta, leadershipChecks, crossLayerCheck };

function clickupFlags(delta, { config, dateKey, fieldMap }) {
  const flags = [];
  const add = (spec) => flags.push(makeFlag(spec, { dateKey }));
  const stalledAfter = config.clickup.rules?.stalledAfterDays ?? 3;

  // A field that does not exist on the board is a configuration problem, not a problem
  // with every ticket. Flagging each ticket separately turns one fact into N lines and
  // buries the signal that actually matters underneath them.
  const ownerFieldExists = Boolean(fieldMap?.taskOwner?.id);
  // Tickets reach rocks through Big Swing, so that is the field the ladder needs.
  const swingFieldExists = Boolean(fieldMap?.bigSwing?.id);
  const bauMarkers = (config.clickup.bauMarkers ?? []).map((m) => String(m).toLowerCase());
  const isBau = (task) =>
    [task.leadershipPriority?.label, task.bigSwing?.label].some((l) => l && bauMarkers.includes(String(l).trim().toLowerCase()));
  const openTasks = (delta.tasks ?? []).filter((t) => t.bucket !== "done");

  if (!ownerFieldExists) {
    add({
      layer: 2,
      rule: "clickup.owner_field_missing",
      severity: "p1",
      advisable: false,
      subject: { type: "field", id: "task-owner-field", label: "Task Owner field" },
      message: `There is no Task Owner field on the sprint list, so nobody is recorded as accountable for any of the ${openTasks.length} open tickets. The ownership model cannot run until the field exists.`,
      values: { openTasks: openTasks.length, lookedFor: config.clickup.customFields?.taskOwner?.matchName ?? [] },
    });
  }

  if (!swingFieldExists) {
    add({
      layer: 2,
      rule: "clickup.big_swing_field_missing",
      severity: "p1",
      advisable: false,
      subject: { type: "field", id: "big-swing-field-missing", label: "Big Swing field" },
      message: `There is no Big Swing field on the sprint list, so no ticket can ladder up to a rock and the cross layer check has nothing to read.`,
      values: { openTasks: openTasks.length, lookedFor: config.clickup.customFields?.bigSwing?.matchName ?? [] },
    });
  }

  for (const task of delta.tasks ?? []) {
    if (task.bucket === "done") continue;

    if (task.signal === "stalled") {
      add({
        layer: 2,
        rule: "clickup.stalled",
        severity: "attention",
        subject: { type: "task", id: task.id, label: task.name, url: task.url },
        message: `"${task.name}" is ${task.status} and nothing has touched it for ${task.idleDays} days. This is where a clarifying question goes.`,
        values: {
          status: task.status,
          idleDays: task.idleDays,
          stalledAfterDays: stalledAfter,
          owner: task.taskOwners.map((u) => u.username).join(", ") || null,
          assignees: task.assignees.map((u) => u.username).join(", ") || null,
        },
      });
    }

    // ClickUp allows several owners on one ticket. The spec's model is one accountable
    // person: "the owner is accountable for divvying up the work and keeping the task
    // moving". Two owners is not twice the accountability, it is none.
    if (ownerFieldExists && task.taskOwners.length > 1) {
      add({
        layer: 2,
        rule: "clickup.multiple_task_owners",
        severity: "info",
        advisable: false,
        subject: { type: "task", id: `${task.id}:owners`, label: task.name, url: task.url },
        message: `"${task.name}" has ${task.taskOwners.length} Project Owners. One person should be accountable for keeping it moving; the rest can be assignees.`,
        values: { owners: task.taskOwners.map((u) => u.username) },
      });
    }

    if (ownerFieldExists && task.taskOwners.length === 0) {
      add({
        layer: 2,
        rule: "clickup.no_task_owner",
        severity: "attention",
        subject: { type: "task", id: `${task.id}:owner`, label: task.name, url: task.url },
        message: `"${task.name}" has no Task Owner. Nobody is accountable for keeping it moving.`,
        values: { status: task.status, assignees: task.assignees.map((u) => u.username) },
      });
    }

    // A ticket with no Big Swing ladders up to no rock. BAU work, marked in either field,
    // is expected and needs none.
    if (swingFieldExists && !task.bigSwing && !isBau(task)) {
      add({
        layer: 2,
        rule: "clickup.no_big_swing_set",
        severity: "info",
        advisable: false,
        subject: { type: "task", id: `${task.id}:swing`, label: task.name, url: task.url },
        message: `"${task.name}" has no Big Swing set, so it ladders up to no rock.`,
        values: { status: task.status },
      });
    }
  }

  if (delta.changes?.disappeared?.length) {
    add({
      layer: 2,
      rule: "clickup.task_disappeared",
      severity: "attention",
      subject: { type: "list", id: "disappeared", label: "Sprint list" },
      message: `${delta.changes.disappeared.length} task(s) present yesterday are missing from the list today. Moved, archived or deleted.`,
      values: { tasks: delta.changes.disappeared.slice(0, 10).map((t) => ({ id: t.id, name: t.name, status: t.status })) },
    });
  }

  return flags;
}

function intelligemsFlags(delta, { config, dateKey, testNotes = null }) {
  const flags = [];
  const add = (spec) => flags.push(makeFlag(spec, { dateKey }));

  for (const test of delta.tests ?? []) {
    const subject = { type: "test", id: test.id, label: test.name };

    if (test.changes.verdictChanged) {
      add({
        layer: 3,
        rule: "intelligems.verdict_changed",
        severity: "p1",
        subject,
        message: `"${test.name}" moved from ${test.before?.verdict ?? "no verdict"} to ${test.verdict}. Recommendation is now ${test.recommendation.recommendation}.`,
        values: { from: test.before?.verdict ?? null, to: test.verdict, recommendation: test.recommendation.recommendation },
      });
    }

    // Ready for a call: past the gate AND a clear result on a decision metric. Passing the
    // gate alone raises nothing: enough data is not a result.
    if (test.changes.readyJustNow) {
      const results = test.recommendation.clearResults ?? [];
      add({
        layer: 3,
        rule: "intelligems.ready_for_call",
        severity: "p1",
        subject: { ...subject, id: `${test.id}:ready` },
        message: `"${test.name}" is ready for a call: ${results.length ? `${results.map(describeResult).join("; ")}, ` : ""}after ${test.recommendation.gate.days} days and ${test.recommendation.gate.orders} orders in the smallest group. The recommendation is ${test.recommendation.recommendation}.`,
        values: { gate: test.recommendation.gate, clearResults: results, recommendation: test.recommendation.recommendation },
      });
    }

    for (const move of test.changes.p0Moves) {
      add({
        layer: 3,
        rule: "intelligems.p0_moved",
        severity: "p1",
        subject: { ...subject, id: `${test.id}:${move.groupId}:${move.metric}` },
        message: (() => {
          const fmt = (v) => formatMetricValue(move.metric, v);
          const [low, high] = move.interval ?? [];
          const control = move.control
            ? ` The control held steady (${fmt(move.control.baseline)} to ${fmt(move.control.today)}), so this is the variant, not the site.`
            : " The control could not be checked, so a site-wide move is not ruled out.";
          return `"${test.name}", variant "${move.groupName}": ${metricLabel(move.metric)}, a primary metric, moved from ${fmt(move.baseline)} to ${fmt(move.today)} since the last readout, outside its 95% range of ${fmt(low)} to ${fmt(high)}.${control}`;
        })(),
        values: move,
      });
    }

    // A variant that jumped while its control held steady: that is the test, not the
    // site. The numbers are in the message, because "swung outside its band" alone left
    // nothing to judge it by.
    for (const band of test.changes.p1OutOfBand) {
      const fmt = (v) => formatMetricValue(band.metric, v);
      const [low, high] = band.values?.interval ?? [];
      const control = band.control
        ? ` The control held steady (${fmt(band.control.baseline)} to ${fmt(band.control.today)}), so this is the variant, not the site.`
        : " The control could not be checked, so a site-wide move is not ruled out.";
      add({
        layer: 3,
        rule: "intelligems.p1_out_of_band",
        severity: "attention",
        subject: { ...subject, id: `${test.id}:${band.groupId}:${band.metric}` },
        message: `"${test.name}", variant "${band.groupName}": ${metricLabel(band.metric)} moved from ${fmt(band.values?.baseline)} to ${fmt(band.values?.today)} since the last readout, outside its 95% range of ${fmt(low)} to ${fmt(high)}.${control}`,
        values: { ...band.values, control: band.control },
      });
    }

    for (const cross of test.changes.probabilityCrossings) {
      add({
        layer: 3,
        rule: "intelligems.probability_crossed",
        severity: "attention",
        subject: { ...subject, id: `${test.id}:${cross.groupId}:${cross.metric}:prob` },
        message: `"${test.name}" ${cross.groupName} ${cross.direction} the ${cross.threshold} probability-to-beat-control threshold on ${cross.metric}.`,
        values: cross,
      });
    }

    const conflicted = (test.tradeOffs ?? []).filter((t) => t.conflict);
    for (const trade of conflicted) {
      add({
        layer: 3,
        rule: "intelligems.metric_conflict",
        severity: "attention",
        subject: { ...subject, id: `${test.id}:${trade.groupId}:tradeoff` },
        message: `"${test.name}" ${trade.groupName} wins on ${trade.wins.map((w) => w.metric).join(", ")} and loses on ${trade.losses.map((l) => l.metric).join(", ")}. The trade off needs a call.`,
        values: { wins: trade.wins, losses: trade.losses, futureValue: trade.futureValue },
      });
    }

    if (test.recommendation.disagreement) {
      add({
        layer: 3,
        rule: "intelligems.gate_disagreement",
        severity: "attention",
        advisable: false,
        subject: { ...subject, id: `${test.id}:disagreement` },
        message: `"${test.name}": our readiness gate says ${test.recommendation.disagreement.ours} but the platform reports ${test.recommendation.disagreement.theirs}. Taking the conservative answer.`,
        values: test.recommendation.disagreement,
      });
    }

    if (test.recommendation.unmappedVerdict) {
      add({
        layer: 3,
        rule: "intelligems.unmapped_verdict",
        severity: "attention",
        advisable: false,
        subject: { ...subject, id: `${test.id}:unmapped` },
        message: `"${test.name}" came back with verdict "${test.verdict}", which has no entry in config.intelligems.verdictMap. Add the mapping.`,
        values: { verdict: test.verdict, known: Object.keys(config.intelligems.verdictMap ?? {}) },
      });
    }

    // A quiet test is only worth a prompt when a call is actually due: the gate is met and
    // the numbers point somewhere (Ship, Iterate or Kill), and no decision is written in
    // its notes. A test still at Keep Running is meant to sit quietly; asking about it
    // every morning was noise.
    const call = test.recommendation?.recommendation;
    const decided = Boolean(testNotes?.[String(test.id)]?.decision);
    if (test.quiet && call && call !== "Keep Running" && !test.recommendation?.unmappedVerdict && !decided) {
      add({
        layer: 3,
        rule: "intelligems.decision_due",
        severity: "prompt",
        subject: { ...subject, id: `${test.id}:decision` },
        message: `"${test.name}" is ready for a call: the recommendation is ${call} after ${test.daysRunning ?? "?"} days and ${test.minOrdersPerGroup ?? "?"} orders in its smallest group${test.recommendation?.clearResults?.length ? `, on ${test.recommendation.clearResults.map(describeResult).join("; ")}` : ""}, and no decision is recorded. Add one in its notes.`,
        values: {
          recommendation: call,
          daysRunning: test.daysRunning,
          ordersInSmallestGroup: test.minOrdersPerGroup,
          stabilized: test.timeseriesStabilized?.stabilized ?? null,
        },
      });
    }

    // A segment that contradicts the aggregate turns ship-or-kill into a third option:
    // ship it to the segment it works for. This is the finding the breakdown exists for.
    for (const audience of test.audiences ?? []) {
      for (const d of audience.divergent) {
        add({
          layer: 3,
          rule: "intelligems.segment_diverges",
          severity: "attention",
          subject: { ...subject, id: `${test.id}:${audience.dimension}:${d.segment}` },
          message: d.overallDirection
            ? `"${test.name}" is a ${d.overallDirection} overall but a ${d.direction} on ${d.segment} (${d.upliftPct > 0 ? "+" : ""}${d.upliftPct?.toFixed(1)}% ${audience.metric}). Worth segmenting rather than calling it either way.`
            : `"${test.name}" is inconclusive overall but a ${d.direction} on ${d.segment} (${d.upliftPct > 0 ? "+" : ""}${d.upliftPct?.toFixed(1)}% ${audience.metric}).`,
          values: { dimension: audience.dimension, segment: d.segment, variant: d.variant, level: d.level, upliftPct: d.upliftPct, metric: audience.metric },
        });
      }
    }

    // No flag for a test with no description in Intelligems: Alex removed it on
    // 2026-10-20. The Tests view still shows what a test changes, worked out from its
    // setup, so the gap is visible where it matters without a line in the readout.

    if (test.metricsConfigured === false) {
      add({
        layer: 3,
        rule: "intelligems.no_metrics_configured",
        severity: "attention",
        advisable: false,
        subject: { ...subject, id: `${test.id}:nometrics` },
        message: `"${test.name}" returned no configured success metrics, so there is nothing to judge it on.`,
        values: {},
      });
    }
  }

  for (const test of delta.ended ?? []) {
    add({
      layer: 3,
      rule: "intelligems.test_ended",
      severity: "attention",
      subject: { type: "test", id: `${test.id}:ended`, label: test.name },
      message: `"${test.name}" is no longer running. Final verdict: ${test.finalVerdict ?? "none recorded"}. It drops out of the watch list after this readout.`,
      values: { finalVerdict: test.finalVerdict, endedBetween: test.endedBetween },
    });
  }

  for (const failure of delta.failures ?? []) {
    add({
      layer: 3,
      rule: "intelligems.test_fetch_failed",
      severity: "attention",
      advisable: false,
      subject: { type: "test", id: `${failure.experienceId}:failed`, label: failure.name ?? failure.experienceId },
      message: `Results for test ${failure.name ?? failure.experienceId} could not be pulled this morning. Its section is missing, not empty.`,
      values: { error: failure.error },
    });
  }

  // A control group that swung is the site moving, not any test. One line per metric
  // across every test, instead of a flag per test that reads like a test result.
  const byMetric = new Map();
  for (const test of delta.tests ?? []) {
    for (const swing of [...(test.changes?.p0ControlSwings ?? []), ...(test.changes?.p1ControlSwings ?? [])]) {
      if (!byMetric.has(swing.metric)) byMetric.set(swing.metric, []);
      byMetric.get(swing.metric).push({ test: test.name, testId: test.id, ...swing.values });
    }
  }
  for (const [metric, swings] of byMetric) {
    const fmt = (v) => formatMetricValue(metric, v);
    const list = swings.map((s) => `${s.test}: ${fmt(s.baseline)} to ${fmt(s.today)}`).join("; ");
    add({
      layer: 3,
      rule: "intelligems.control_moved",
      severity: "info",
      advisable: false,
      subject: { type: "metric", id: `control:${metric}`, label: metricLabel(metric) },
      message: `${metricLabel(metric)[0].toUpperCase()}${metricLabel(metric).slice(1)} moved outside its normal range in the control group of ${swings.length === 1 ? "1 test" : `${swings.length} tests`} since the last readout (${list}). A control is the unchanged site, so this is a site-wide move, not a test result.`,
      values: { metric, swings },
    });
  }

  return flags;
}

/**
 * Runs every rule over the snapshots and returns the assembled flags plus the per-layer
 * detail the renderer needs.
 *
 * `sections` records which layers are present and which are missing and why. A partial
 * readout beats no readout, and the reader has to be able to see the difference.
 */
export function computeFlags({ snapshots, baselines, config, settings = null, statusLedger = null, testNotes = null, dateKey, nowIso, logger }) {
  const sections = {};
  const flags = [];

  /* ---- Layer 2 ---- */
  let cuDelta = null;
  if (snapshots.clickup) {
    cuDelta = clickupDelta(baselines.clickup?.snapshot ?? null, snapshots.clickup, {
      config,
      now: new Date(nowIso).getTime(),
      comments: snapshots.clickup.comments,
      statusLedger,
    });
    flags.push(...clickupFlags(cuDelta, { config, dateKey, fieldMap: snapshots.clickup.fieldMap }));

    // Sat too long where it is. Separate from the `stalled` signal, which asks whether
    // anything touched the ticket: a ticket can be commented on daily for three weeks
    // and never leave QA. This is the one that catches that.
    for (const task of cuDelta.byStaleness) {
      if (!task.stale) continue;
      const qualifier = task.statusAge.exact ? "" : "at least ";
      flags.push({
        id: `clickup.stale_in_status:${task.id}`,
        key: `clickup.stale_in_status:${task.id}`,
        layer: 2,
        subject: { type: "task", id: task.id, label: task.name, url: task.url ?? null },
        severity: "attention",
        rule: "clickup.stale_in_status",
        message: `"${task.name}" has been in ${task.status} for ${qualifier}${task.statusAge.days} days, past the ${task.stale.threshold} day mark for that status.${
          task.assignees?.length ? ` With ${task.assignees.map((a) => a.username).join(", ")}.` : ""
        }`,
        advisable: true,
        url: task.url ?? null,
      });
    }
    sections.clickup = { present: true, baselineDate: baselines.clickup?.dateKey ?? null, counts: cuDelta.counts };
  } else {
    sections.clickup = { present: false, reason: snapshots.errors?.clickup ?? "collector did not run" };
  }

  /* ---- Layer 3 ---- */
  let igDelta = null;
  if (snapshots.intelligems) {
    igDelta = intelligemsDelta(baselines.intelligems?.snapshot ?? null, snapshots.intelligems, { config, logger, settings, now: new Date(nowIso) });
    flags.push(...intelligemsFlags(igDelta, { config, dateKey, testNotes }));
    sections.intelligems = { present: true, baselineDate: baselines.intelligems?.dateKey ?? null, counts: igDelta.counts };
  } else {
    sections.intelligems = { present: false, reason: snapshots.errors?.intelligems ?? "collector did not run" };
  }

  /* ---- Layer 0. Store-wide metrics. ----
     The point of this layer is context: it separates "the variant won" from "the whole
     store moved on Tuesday". Flags here are a sanity check, never a statistical claim. */
  let shopify = null;
  if (snapshots.shopify) {
    shopify = snapshots.shopify;
    const threshold = config.shopify?.alerts?.movePercentThreshold ?? 15;
    const against = config.shopify?.alerts?.compareAgainst ?? null;

    for (const tile of shopify.tiles ?? []) {
      if (!tile.available) {
        flags.push(
          makeFlag({
            layer: 0,
            rule: "shopify.metric_unavailable",
            severity: "info",
            advisable: false,
            subject: { type: "metric", id: `shopify:${tile.metric}`, label: tile.label },
            message: `Store metric ${tile.label} could not be read. ${tile.reason ?? ""}`.trim(),
            values: { metric: tile.metric, reason: tile.reason },
          }, { dateKey }),
        );
        continue;
      }

      // Flag against one named window, not all of them, or a single move produces a
      // flag per comparison and the readout says the same thing twice.
      const cmp = (tile.comparisons ?? []).find((c) => c.window === against) ?? (tile.comparisons ?? [])[0];
      if (!cmp || cmp.changePct == null || Math.abs(cmp.changePct) < threshold) continue;

      const movedUp = cmp.changePct > 0;
      const good = tile.goodDirection === "down" ? !movedUp : movedUp;
      flags.push(
        makeFlag({
          layer: 0,
          rule: "shopify.metric_moved",
          severity: good ? "info" : "attention",
          subject: { type: "metric", id: `shopify:${tile.metric}`, label: tile.label },
          message: `Store-wide ${tile.label} is ${movedUp ? "up" : "down"} ${Math.abs(cmp.changePct).toFixed(1)}%${cmp.basis === "per day" ? " per day" : ""} against ${cmp.label}. Worth knowing before reading any test result as a win or a loss.`,
          values: { metric: tile.metric, window: cmp.label, value: tile.value, comparedWith: cmp.value, changePct: cmp.changePct, basis: cmp.basis, threshold },
        }, { dateKey }),
      );
    }

    sections.shopify = { present: true, tiles: (shopify.tiles ?? []).length, shopDomain: shopify.shopDomain };
  } else {
    sections.shopify = { present: false, reason: snapshots.errors?.shopify ?? "collector did not run" };
  }

  /* ---- Layer 1 ---- */
  let leadership = null;
  if (snapshots.leadership) {
    leadership = leadershipChecks({
      leadership: snapshots.leadership,
      clickup: snapshots.clickup,
      config,
      dateKey,
      nowIso,
    });
    flags.push(...leadership.flags);
    sections.leadership = { present: true, summary: leadership.summary };
  } else {
    sections.leadership = { present: false, reason: snapshots.errors?.leadership ?? "collector did not run" };
  }

  /* ---- Cross layer. Needs both Layer 1 and Layer 2. ---- */
  let cross = null;
  const swingFieldPresent = Boolean(snapshots.clickup?.fieldMap?.bigSwing?.id);
  if (cuDelta && snapshots.leadership && swingFieldPresent) {
    cross = crossLayerCheck({ clickupDelta: cuDelta, leadership: snapshots.leadership, config, dateKey });
    flags.push(...cross.flags);
    sections.crossLayer = { present: true, summary: cross.summary };
  } else if (cuDelta && snapshots.leadership && !swingFieldPresent) {
    // The check would report every single person as having no big swing, which is true
    // and useless. One line naming the cause beats five lines naming the symptom.
    cross = crossLayerCheck({ clickupDelta: cuDelta, leadership: snapshots.leadership, config, dateKey });
    sections.crossLayer = {
      present: false,
      reason: "the Big Swing field does not exist on the sprint list, so no ticket can ladder up to a rock yet",
      wouldFlag: cross.flags.length,
      summary: cross.summary,
    };
    cross = { ...cross, flags: [], suppressed: true };
  } else {
    sections.crossLayer = {
      present: false,
      reason: "the cross layer check needs both the ClickUp sprint and the leadership queue",
    };
  }

  const sorted = sortFlags(flags);
  logFlags(sorted, logger);

  return {
    flags: sorted,
    sections,
    detail: {
      shopify,
      clickup: cuDelta,
      intelligems: igDelta,
      leadership,
      crossLayer: cross,
      preSprint: snapshots.clickup
        ? preSprintCheck({
            backlogReady: snapshots.clickup.backlogReady,
            error: snapshots.clickup.backlogReadyError,
            sprintTasks: cuDelta?.tasks ?? [],
            leadership: snapshots.leadership,
            config,
          })
        : { available: false, reason: "the ClickUp pull did not run" },
      // The open backlog, for planning under each rock on the Rocks view.
      backlog: Array.isArray(snapshots.clickup?.backlog)
        ? { available: true, items: snapshots.clickup.backlog }
        : { available: false, reason: snapshots.clickup?.backlogReadyError ?? "the backlog was not collected" },
    },
  };
}

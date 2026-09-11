// The delta stage. Snapshots in, a flags list out.
//
// Layer 1 and cross-layer flags come from their own modules. This file raises the Layer 2
// and Layer 3 flags and assembles everything into one sorted, logged list.

import { makeFlag, sortFlags, logFlags } from "./flags.js";
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
  const priorityFieldExists = Boolean(fieldMap?.leadershipPriority?.id);
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

  if (!priorityFieldExists) {
    add({
      layer: 2,
      rule: "clickup.priority_field_missing",
      severity: "p1",
      advisable: false,
      subject: { type: "field", id: "leadership-priority-field-missing", label: "Leadership Priority field" },
      message: `There is no Leadership Priority field on the sprint list, so no ticket can ladder up to a leadership priority and the cross layer check has nothing to read.`,
      values: { openTasks: openTasks.length, lookedFor: config.clickup.customFields?.leadershipPriority?.matchName ?? [] },
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

    if (priorityFieldExists && !task.leadershipPriority) {
      add({
        layer: 2,
        rule: "clickup.no_leadership_priority",
        severity: "info",
        advisable: false,
        subject: { type: "task", id: `${task.id}:priority`, label: task.name, url: task.url },
        message: `"${task.name}" has no Leadership Priority set, so it ladders up to nothing.`,
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

function intelligemsFlags(delta, { config, dateKey }) {
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

    if (test.changes.gateJustMet) {
      add({
        layer: 3,
        rule: "intelligems.gate_met",
        severity: "p1",
        subject: { ...subject, id: `${test.id}:gate` },
        message: `"${test.name}" just passed the readiness gate at ${test.recommendation.gate.days} days and ${test.recommendation.gate.orders} orders in the smallest group. It can take a real verdict now.`,
        values: test.recommendation.gate,
      });
    }

    for (const move of test.changes.p0Moves) {
      add({
        layer: 3,
        rule: "intelligems.p0_moved",
        severity: "p1",
        subject: { ...subject, id: `${test.id}:${move.groupId}:${move.metric}` },
        message: `"${test.name}" P0 metric ${move.metric} on ${move.groupName} moved beyond its own confidence interval since yesterday.`,
        values: move,
      });
    }

    for (const band of test.changes.p1OutOfBand) {
      add({
        layer: 3,
        rule: "intelligems.p1_out_of_band",
        severity: "attention",
        subject: { ...subject, id: `${test.id}:${band.groupId}:${band.metric}` },
        message: `"${test.name}" P1 metric ${band.metric} on ${band.groupName} swung outside its band. Not normal trending.`,
        values: band.values,
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

    // Nothing notable moved. Prompt the owner for next steps or a decision.
    if (test.quiet) {
      add({
        layer: 3,
        rule: "intelligems.quiet_needs_owner_note",
        severity: "prompt",
        subject: { ...subject, id: `${test.id}:quiet` },
        message: `"${test.name}" did not move since yesterday. The owner should note next steps or make a decision.`,
        values: {
          recommendation: test.recommendation.recommendation,
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

    // A test nobody described is a test nobody will be able to read in three months.
    // Info, not attention: it is a documentation gap, not a problem with the result.
    if (test.experienceDiff?.descriptionMissing) {
      add({
        layer: 3,
        rule: "intelligems.no_description",
        severity: "info",
        advisable: false,
        subject: { ...subject, id: `${test.id}:description` },
        message: `"${test.name}" has no description in Intelligems. The system can say what it changes mechanically${test.experienceDiff.summary ? ` (${test.experienceDiff.summary})` : ""}, but not why.`,
        values: { types: test.experienceDiff.types, derivedSummary: test.experienceDiff.summary },
      });
    }

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

  return flags;
}

/**
 * Runs every rule over the snapshots and returns the assembled flags plus the per-layer
 * detail the renderer needs.
 *
 * `sections` records which layers are present and which are missing and why. A partial
 * readout beats no readout, and the reader has to be able to see the difference.
 */
export function computeFlags({ snapshots, baselines, config, settings = null, dateKey, nowIso, logger }) {
  const sections = {};
  const flags = [];

  /* ---- Layer 2 ---- */
  let cuDelta = null;
  if (snapshots.clickup) {
    cuDelta = clickupDelta(baselines.clickup?.snapshot ?? null, snapshots.clickup, {
      config,
      now: new Date(nowIso).getTime(),
      comments: snapshots.clickup.comments,
    });
    flags.push(...clickupFlags(cuDelta, { config, dateKey, fieldMap: snapshots.clickup.fieldMap }));
    sections.clickup = { present: true, baselineDate: baselines.clickup?.dateKey ?? null, counts: cuDelta.counts };
  } else {
    sections.clickup = { present: false, reason: snapshots.errors?.clickup ?? "collector did not run" };
  }

  /* ---- Layer 3 ---- */
  let igDelta = null;
  if (snapshots.intelligems) {
    igDelta = intelligemsDelta(baselines.intelligems?.snapshot ?? null, snapshots.intelligems, { config, logger, settings, now: new Date(nowIso) });
    flags.push(...intelligemsFlags(igDelta, { config, dateKey }));
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
  const priorityFieldPresent = Boolean(snapshots.clickup?.fieldMap?.leadershipPriority?.id);
  if (cuDelta && snapshots.leadership && priorityFieldPresent) {
    cross = crossLayerCheck({ clickupDelta: cuDelta, leadership: snapshots.leadership, config, dateKey });
    flags.push(...cross.flags);
    sections.crossLayer = { present: true, summary: cross.summary };
  } else if (cuDelta && snapshots.leadership && !priorityFieldPresent) {
    // The check would report every single person as having no big swing, which is true
    // and useless. One line naming the cause beats five lines naming the symptom.
    cross = crossLayerCheck({ clickupDelta: cuDelta, leadership: snapshots.leadership, config, dateKey });
    sections.crossLayer = {
      present: false,
      reason: "the Leadership Priority field does not exist on the sprint list, so no ticket can ladder up to anything yet",
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
    detail: { shopify, clickup: cuDelta, intelligems: igDelta, leadership, crossLayer: cross },
  };
}

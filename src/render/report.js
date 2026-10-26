// The renderer. Flags plus snapshots in, a report out.
//
// Deterministic on purpose. No model touches the daily readout: code phrases the same
// fact the same way every morning, which is the whole reason the readout can be trusted
// and costs nothing. Order follows the spec: Layer 1 is checked first, every day.

import { flagRef } from "../store/flag-ledger.js";
import { isContext } from "../delta/flags.js";
import { topFlags } from "../delta/priority.js";
import { weeklyLines } from "../delta/weekly.js";
import { weekdayOfKey } from "../lib/time.js";

/** Friday's readout leads with the week; the rest of the week it is on the dashboard. */
const isFriday = (dateKey) => Boolean(dateKey) && weekdayOfKey(dateKey) === 5;

const SIGNAL_MARK = { stalled: "STALLED", waiting: "waiting", moving: "moving", idle: "idle" };

/** "L1", "L2", "L3", "CROSS". A layer label a person can read out loud. */
function layerLabel(layer) {
  return layer === "cross" ? "CROSS" : layer === 0 ? "STORE" : `L${layer}`;
}

function plural(n, singular, plural_) {
  return `${n} ${n === 1 ? singular : plural_ ?? `${singular}s`}`;
}

function fmtDate(ms) {
  if (!ms) return "no date";
  return new Date(Number(ms)).toISOString().slice(0, 10);
}

function fmtNum(value, { pct = false, money = false, currency = "USD" } = {}) {
  if (value == null) return "not configured";
  if (pct) return `${(value * (Math.abs(value) <= 1 ? 100 : 1)).toFixed(2)}%`;
  if (money) return `${currency} ${Number(value).toFixed(2)}`;
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(3);
}

function names(users) {
  const list = (users ?? []).map((u) => u.username ?? u.id);
  return list.length ? list.join(", ") : "unassigned";
}

/* --------------------------------- sections --------------------------------- */

/** A store metric as the readout prints it. Per-day values keep their cents. */
function storeValue(tile, value, perDay = false) {
  if (value == null) return null;
  if (tile.format === "percent") return `${(value * 100).toFixed(2)}%`;
  if (tile.format === "money") return `${tile.kind === "rate" || perDay ? Number(value).toFixed(2) : Math.round(value).toLocaleString("en-US")}${perDay ? "/d" : ""}`;
  return `${Math.round(value).toLocaleString("en-US")}${perDay ? "/d" : ""}`;
}

function renderStore(detail, section, lines, context = []) {
  const win = detail?.primaryWindow;
  lines.push(`STORE. ${win?.label ?? "Store"} against ${(detail?.windows ?? []).filter((w) => w.key !== win?.key).map((w) => w.label).join(" and ")}. Totals compared per day.`);
  if (context.length) {
    lines.push("  SITE-WIDE MOVES. Read every test result below against these.");
    for (const flag of context) lines.push(`    ${flag.message}`);
  }
  if (!section?.present) {
    lines.push(`  MISSING. ${section?.reason ?? "not collected"}`);
    lines.push("");
    return;
  }
  for (const tile of detail?.tiles ?? []) {
    if (!tile.available) {
      lines.push(`  ${tile.label}: unavailable. ${tile.reason ?? ""}`.trimEnd());
      continue;
    }
    const value =
      tile.format === "percent"
        ? `${(tile.value * 100).toFixed(2)}%`
        : tile.format === "money"
          ? (tile.kind === "rate" ? tile.value.toFixed(2) : Math.round(tile.value).toLocaleString("en-US"))
          : Math.round(tile.value).toLocaleString("en-US");
    const cmps = (tile.comparisons ?? [])
      // The other window's own number first, then how this one compares with it, so
      // "Yest" can never be read as yesterday's change.
      .map((c) => {
        const perDay = c.basis === "per day";
        const theirs = storeValue(tile, perDay ? c.perDay : c.value, perDay);
        if (c.changePct == null) return `vs ${c.label} ${theirs ?? "n/a"}`;
        return `vs ${c.label} ${theirs ?? "n/a"}: ${c.changePct > 0 ? "+" : ""}${c.changePct}%`;
      })
      .join(", ");
    lines.push(`  ${tile.label}: ${value} (${cmps})`);
  }
  lines.push("");
}

function renderLeadership(detail, section, lines) {
  lines.push("LAYER 1. LEADERSHIP PRIORITIES. Every item is a P1.");
  if (!section.present) {
    lines.push(`  MISSING. ${section.reason}`);
    lines.push("");
    return;
  }
  const { queue, backlog, summary } = detail;
  lines.push(
    `  ${summary.activeCount} active, ${summary.shippedCount} shipped, ${summary.backlogCount} in backlog. ${summary.peopleAtCapacity} of ${summary.rosterSize} people at capacity.`,
  );
  for (const item of queue) {
    const owner = item.owner?.name ?? "NO OWNER";
    const extra =
      item.state === "shipped"
        ? ` shipped ${item.shippedAt ?? "?"}, last checked ${item.lastMiniReadoutAt ?? "never"}`
        : "";
    lines.push(`  [${item.state}] ${item.title} - ${owner}${extra}`);
  }
  if (backlog.length) {
    lines.push(`  Backlog: ${backlog.map((i) => i.title).join("; ")}`);
  }
  lines.push("");
}

function renderClickUp(delta, section, lines) {
  lines.push("LAYER 2. CLICKUP SPRINT.");
  if (!section.present) {
    lines.push(`  MISSING. ${section.reason}`);
    lines.push("");
    return;
  }
  const c = delta.counts;
  lines.push(
    `  ${c.total} tasks. ${c.notStarted} not started, ${c.inProgress} in progress, ${c.done} done. ${c.stalled} stalled, ${c.changed} changed since the baseline.`,
  );
  if (!delta.hasBaseline) {
    lines.push("  FIRST RUN. There is no previous snapshot, so there is no day over day section below.");
  }

  lines.push("");
  lines.push("  NOT STARTED");
  if (delta.boards.notStarted.length === 0) lines.push("    nothing");
  for (const task of delta.boards.notStarted) {
    lines.push(`    ${task.name} | ${task.status} | owner ${names(task.taskOwners)} | assignees ${names(task.assignees)} | due ${fmtDate(task.dueDate)}`);
  }

  lines.push("");
  lines.push("  IN PROGRESS");
  if (delta.boards.inProgress.length === 0) lines.push("    nothing");
  for (const task of delta.boards.inProgress) {
    const idle = task.idleDays == null ? "?" : `${task.idleDays}d`;
    lines.push(
      `    [${SIGNAL_MARK[task.signal] ?? task.signal}] ${task.name} | ${task.status} | owner ${names(task.taskOwners)} | untouched ${idle} | ${task.leadershipPriority?.label ?? "no priority"}`,
    );
  }

  if (delta.hasBaseline) {
    lines.push("");
    lines.push("  DAY OVER DAY");
    const ch = delta.changes;
    const any =
      ch.statusChanges.length + ch.assigneeChanges.length + ch.ownerChanges.length + ch.priorityChanges.length + ch.newComments.length + ch.newTasks.length + ch.disappeared.length;
    if (any === 0) lines.push("    no changes");
    for (const t of ch.statusChanges) lines.push(`    status: ${t.name}: ${t.from} -> ${t.to}`);
    for (const t of ch.assigneeChanges) lines.push(`    assignee: ${t.name}: ${t.from} -> ${t.to}`);
    for (const t of ch.ownerChanges) lines.push(`    owner: ${t.name}: ${t.from} -> ${t.to}`);
    for (const t of ch.priorityChanges) lines.push(`    priority: ${t.name}: ${t.from} -> ${t.to}`);
    for (const t of ch.newComments) {
      const who = t.latest?.user ? ` by ${t.latest.user}` : "";
      const text = t.latest?.text ? `: "${t.latest.text.slice(0, 120)}"` : "";
      lines.push(`    comment: ${t.name}: +${t.added}${who}${text}`);
    }
    for (const t of ch.newTasks) lines.push(`    new: ${t.name} | ${t.status} | owner ${names(t.taskOwners)}`);
    for (const t of ch.disappeared) lines.push(`    gone: ${t.name} | was ${t.status}`);
  }
  lines.push("");
}

function renderIntelligems(delta, section, lines, config) {
  lines.push("LAYER 3. ACTIVE TESTS.");
  if (!section.present) {
    lines.push(`  MISSING. ${section.reason}`);
    lines.push("");
    return;
  }
  const c = delta.counts;
  lines.push(`  ${c.running} running. ${c.notable} moved, ${c.quiet} quiet, ${c.readyForVerdict} past the readiness gate, ${c.ended} ended.`);
  if (!delta.hasBaseline) {
    lines.push("  FIRST RUN. No previous snapshot, so no day over day comparison on results.");
  }
  lines.push("");

  const p0 = config.intelligems.metrics?.p0 ?? [];

  for (const test of delta.tests) {
    lines.push(`  ${test.name} [${test.verdict ?? "no verdict"}] -> ${test.recommendation.recommendation}`);
    lines.push(`    ${test.recommendation.reason}`);
    lines.push(`    ${test.daysRunning ?? "?"} days, ${test.minOrdersPerGroup ?? "?"} orders in the smallest group.`);

    for (const group of test.groups) {
      const parts = p0.map((name) => {
        const m = group.metrics?.[name];
        if (!m || m.value == null) return `${name} not configured`;
        // upliftPct, not uplift: the API returns a fraction, so 0.159 is +15.9%, not +0.16%.
        const uplift = m.upliftPct == null ? "" : ` (${m.upliftPct > 0 ? "+" : ""}${Number(m.upliftPct).toFixed(1)}%)`;
        return `${name} ${fmtNum(m.value)}${uplift}`;
      });
      lines.push(`    ${group.isControl ? "control" : "variant"} ${group.name}: ${parts.join(", ")}`);
    }

    for (const trade of test.tradeOffs ?? []) {
      if (!trade.conflict) continue;
      lines.push(
        `    TRADE OFF on ${trade.groupName}: wins ${trade.wins.map((w) => w.metric).join(", ")} against losses ${trade.losses.map((l) => l.metric).join(", ")}.`,
      );
      const fv = trade.futureValue;
      if (fv?.configured === false) {
        lines.push("      Lifetime value: not configured. Set the LTV multipliers in Settings to weigh lifetime against first order.");
      } else if (fv?.upliftPct != null) {
        const signed = (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
        lines.push(
          `      ${fv.horizonMonths} month value per visitor vs control: ${signed(fv.upliftPct)}` +
            (fv.immediateUpliftPct != null ? `, against ${signed(fv.immediateUpliftPct)} on this order.` : ".") +
            (fv.disagreesWithImmediate ? " Lifetime and immediate disagree." : ""),
        );
      }
    }

    if (test.timeseriesStabilized?.stabilized === false) {
      lines.push(`    Results still swinging. Worst recent day over day swing ${test.timeseriesStabilized.worstSwingPct}%.`);
    }
    lines.push("");
  }

  for (const test of delta.ended) {
    lines.push(`  ENDED. ${test.name}. Final verdict ${test.finalVerdict ?? "none recorded"}.`);
  }
  if (delta.ended.length) lines.push("");
}

function renderCrossLayer(detail, section, lines) {
  lines.push("CROSS LAYER. Does each sprint ladder up to a leadership priority.");
  if (!section.present) {
    lines.push(`  MISSING. ${section.reason}`);
    lines.push("");
    return;
  }
  const s = detail.summary;
  lines.push(
    `  ${s.withBigSwing} of ${s.peopleChecked} people hold at least one big swing. ${plural(s.withoutBigSwing, "person has", "people have")} tickets but no big swing.`,
  );
  for (const person of detail.people) {
    lines.push(
      `  ${person.name}: ${person.distinctBigSwings} big swing(s), ${person.bauTickets.length} BAU, ${person.unrelatedTickets.length} unrelated, ${person.totalTickets} tickets total.`,
    );
  }
  lines.push("");
}

/* ---------------------------------- report ---------------------------------- */

// One table, because the text and the Slack rendering used to carry the same ternary in
// two places and a third mode is exactly how those drift apart.
const MODE_LABEL = {
  official: "8 AM official readout",
  refresh: "On demand refresh",
  test: "Test send, triggered by hand",
};

const isAttention = (f) => f.severity === "p1" || f.severity === "attention";

/** " (open 4 working days)" on a flag that is not new. Nothing on a flag with no ledger. */
function ageNote(flag) {
  if (!flag.openDays) return "";
  return ` (open ${plural(flag.openDays, "working day")}${flag.escalated ? ", escalated from attention" : ""})`;
}

/** "1 done, 2 snoozed, 1 not a problem", or null when nothing is parked. */
function parkedSummary(flags) {
  const count = (status) => flags.filter((f) => f.triage?.status === status).length;
  const parts = [
    [count("done"), "done"],
    [count("snoozed"), "snoozed"],
    [count("dismissed"), "not a problem"],
  ].filter(([n]) => n > 0);
  return parts.length ? parts.map(([n, label]) => `${n} ${label}`).join(", ") : null;
}

/**
 * Triage from the readout itself. Snooze lengths are working days, the same as the
 * dashboard's. The value is a short ref, not the key, because of Slack's length caps.
 */
export const SLACK_TRIAGE = {
  flag_done: { label: "Done", status: "done" },
  flag_snooze_1: { label: "Snooze 1 day", status: "snoozed", workingDays: 1 },
  flag_snooze_5: { label: "Snooze 1 week", status: "snoozed", workingDays: 5 },
  flag_dismiss: { label: "Not a problem", status: "dismissed" },
};

// Slack allows 50 blocks a message, and each flag takes two: the message and its buttons.
const SLACK_FLAG_LIMIT = 18;

export function renderText(report) {
  const lines = [];
  const { detail, sections, config, flags } = report._render;

  if (report.mode === "test") {
    // The whole point of a test send is to look exactly like the real thing. That is
    // also the danger, so the label goes first, before anyone reads a number.
    lines.push("*** TEST SEND. Triggered by hand from the dashboard. This is NOT the 8 AM readout. ***");
  }
  lines.push(`TURNPUPS READOUT. ${report.dateKey}. ${MODE_LABEL[report.mode] ?? "on demand refresh"}.`);
  lines.push(`Run ${report.runId}. Baseline: ${report.baseline.describe}.`);
  if (report.missing.length) {
    lines.push(`PARTIAL. Missing: ${report.missing.map((m) => `${m.section} (${m.reason})`).join("; ")}.`);
  }
  lines.push("");

  const context = flags.filter(isContext);
  const open = flags.filter((f) => !f.triage && !isContext(f));
  const needsAttention = open.filter(isAttention);
  const prompts = open.filter((f) => f.severity === "prompt");
  const line = (flag) => `[${flag.severity.toUpperCase()}] [${layerLabel(flag.layer)}] ${flag.message}${ageNote(flag)}`;

  // Without a ledger there is no age to split on, and the list reads as it always did.
  const aged = needsAttention.some((f) => f.isNew !== undefined);
  const fresh = needsAttention.filter((f) => f.isNew);
  const still = needsAttention.filter((f) => !f.isNew);
  if (isFriday(report.dateKey) && detail.weekly) {
    lines.push("WEEK IN REVIEW.");
    for (const l of weeklyLines(detail.weekly)) lines.push(`  ${l}`);
    lines.push("");
  }

  const top = topFlags(flags);
  if (top.length) {
    lines.push("TODAY'S 3. Start here.");
    top.forEach((flag, i) => lines.push(`  ${i + 1}. ${line(flag)}`));
    lines.push("");
  }

  lines.push(
    `NEEDS YOUR ATTENTION. ${needsAttention.length} item(s).${aged && needsAttention.length ? ` ${fresh.length} new today, ${still.length} still open.` : ""}`,
  );
  if (needsAttention.length === 0) lines.push("  nothing flagged");
  if (aged) {
    if (fresh.length) lines.push("  NEW TODAY");
    for (const flag of fresh) lines.push(`    ${line(flag)}`);
    if (still.length) lines.push("  STILL OPEN");
    for (const flag of still) lines.push(`    ${line(flag)}`);
  } else {
    for (const flag of needsAttention) lines.push(`  ${line(flag)}`);
  }
  lines.push("");

  const waiting = flags.filter((f) => f.triage?.status === "waiting");
  if (waiting.length) {
    lines.push(`WAITING ON SOMEONE. ${waiting.length} item(s). Back on the list when the wait runs out, if still raised.`);
    for (const flag of waiting) {
      lines.push(`  [${layerLabel(flag.layer)}] ${flag.message} - waiting on ${flag.triage.waitingOn} until ${flag.triage.until}`);
    }
    lines.push("");
  }
  const parked = parkedSummary(flags);
  if (parked) {
    lines.push(`PARKED. ${parked}. On the dashboard.`);
    lines.push("");
  }

  if (prompts.length) {
    lines.push(`DECISIONS DUE. ${prompts.length} test(s) ready for a call with no decision recorded.`);
    for (const flag of prompts) lines.push(`  ${flag.message}`);
    lines.push("");
  }

  renderStore(detail.shopify, sections.shopify, lines, context);
  renderLeadership(detail.leadership, sections.leadership, lines);
  renderCrossLayer(detail.crossLayer, sections.crossLayer, lines);
  renderClickUp(detail.clickup, sections.clickup, lines);
  renderIntelligems(detail.intelligems, sections.intelligems, lines, config);

  const info = open.filter((f) => f.severity === "info");
  if (info.length) {
    lines.push(`HYGIENE. ${info.length} item(s). Not urgent.`);
    for (const flag of info) lines.push(`  ${flag.message}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Slack Block Kit. Each actionable flag carries the "Ask for recommendation" button. */
export function renderSlackBlocks(report, config) {
  const blocks = [];
  const flags = report._render.flags;

  if (report.mode === "test") {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":test_tube: *TEST SEND* — triggered by hand from the dashboard to check that the readout posts and renders. *This is not the 8 AM readout* and it does not replace it. The numbers are live.",
      },
    });
  }

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `${report.mode === "test" ? "[TEST] " : ""}Turnpups readout. ${report.dateKey}` },
  });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${MODE_LABEL[report.mode] ?? "On demand refresh"} · baseline ${report.baseline.describe} · run \`${report.runId}\``,
      },
    ],
  });

  if (report.missing.length) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:warning: *Partial readout.* Missing: ${report.missing.map((m) => `${m.section} — ${m.reason}`).join("; ")}`,
      },
    });
  }

  const counts = report.summary;
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: [
        `*${counts.p1} P1* · *${counts.attention} need attention* · ${counts.prompt} decision(s) due${counts.newToday == null ? "" : ` · ${counts.newToday} new today`}`,
        ...(counts.triaged && (counts.triaged.waiting || counts.parked)
          ? [`${counts.triaged.waiting} waiting on someone · ${counts.parked} parked`]
          : []),
        `Layer 1: ${counts.byLayer["1"] ?? 0} · Cross layer: ${counts.byLayer.cross ?? 0} · Layer 2: ${counts.byLayer["2"] ?? 0} · Layer 3: ${counts.byLayer["3"] ?? 0}`,
      ].join("\n"),
    },
  });

  if (isFriday(report.dateKey) && report._render.detail?.weekly) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: ["*Week in review*", ...weeklyLines(report._render.detail.weekly).map((l) => `• ${l}`)].join("\n").slice(0, 2900) },
    });
  }
  const top = topFlags(flags);
  if (top.length) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: [`*Today's 3* · start here`, ...top.map((f, i) => `${i + 1}. ${f.message}${ageNote(f)}`)].join("\n").slice(0, 2900) },
    });
  }
  const actionable = flags.filter((f) => f.severity !== "info" && !f.triage && !isContext(f));
  const context = flags.filter(isContext);
  if (context.length) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: [`*Site-wide moves* · read test results against these`, ...context.slice(0, 8).map((f) => `• ${f.message}`)].join("\n").slice(0, 2900) },
    });
  }
  const shown = actionable.slice(0, SLACK_FLAG_LIMIT);
  if (shown.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "Nothing flagged this morning." } });
  }

  for (const flag of shown) {
    const block = {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${flag.severity === "p1" ? ":red_circle:" : flag.severity === "attention" ? ":large_orange_circle:" : ":speech_balloon:"} *${layerLabel(flag.layer)}*${flag.isNew ? " _new_" : ""} ${flag.message}${ageNote(flag)}`,
      },
    };
    if (flag.advisable) {
      block.accessory = {
        type: "button",
        text: { type: "plain_text", text: config.system.slack?.advisorButtonText ?? "Ask for recommendation" },
        action_id: "ask_advisor",
        value: flag.id.slice(0, 2000),
      };
    }
    blocks.push(block);
    blocks.push({
      type: "actions",
      elements: Object.entries(SLACK_TRIAGE).map(([actionId, t]) => ({
        type: "button",
        text: { type: "plain_text", text: t.label },
        action_id: actionId,
        value: flagRef(flag.key ?? flag.id),
      })),
    });
  }

  if (actionable.length > shown.length) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `${actionable.length - shown.length} more item(s) in the full readout on the dashboard.` }],
    });
  }

  const waiting = flags.filter((f) => f.triage?.status === "waiting");
  if (waiting.length) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [`*Waiting on someone* (${waiting.length})`, ...waiting.slice(0, 15).map((f) => `• ${f.triage.waitingOn}: ${f.message}`)].join("\n").slice(0, 2900),
      },
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "Reply in this thread with feedback and the learning skill will propose a change." }],
  });

  return blocks;
}

/**
 * Assembles the report. `_render` holds the objects the two renderers need and is stripped
 * before the report is stored, so the stored JSON stays a clean artifact.
 */
export function buildReport({ runId, mode, dateKey, nowIso, flags, sections, detail, baseline, config }) {
  // The counts are of what is still open. A flag Alex has already dealt with is in the
  // report, marked, but it is not something that needs attention this morning.
  const open = flags.filter((f) => !f.triage && !isContext(f));
  const byLayer = {};
  for (const flag of open) byLayer[String(flag.layer)] = (byLayer[String(flag.layer)] ?? 0) + 1;
  const triageCount = (status) => flags.filter((f) => f.triage?.status === status).length;
  const aged = flags.some((f) => f.isNew !== undefined);

  const missing = Object.entries(sections)
    .filter(([, section]) => section.present === false)
    .map(([name, section]) => ({ section: name, reason: section.reason }));

  const report = {
    runId,
    mode,
    dateKey,
    generatedAt: nowIso,
    baseline,
    partial: missing.length > 0,
    missing,
    summary: {
      total: open.length,
      p1: open.filter((f) => f.severity === "p1").length,
      attention: open.filter((f) => f.severity === "attention").length,
      prompt: open.filter((f) => f.severity === "prompt").length,
      info: open.filter((f) => f.severity === "info").length,
      byLayer,
      newToday: aged ? open.filter((f) => f.isNew && isAttention(f)).length : null,
      escalated: open.filter((f) => f.escalated).length,
      triaged: { done: triageCount("done"), snoozed: triageCount("snoozed"), waiting: triageCount("waiting"), dismissed: triageCount("dismissed") },
      parked: triageCount("done") + triageCount("snoozed") + triageCount("dismissed"),
      context: flags.filter(isContext).length,
      topThree: topFlags(flags).map((f) => f.id),
    },
    flags,
    sections,
    detail,
    _render: { flags, sections, detail, config },
  };

  report.text = renderText(report);
  report.slackBlocks = renderSlackBlocks(report, config);
  delete report._render;
  return report;
}

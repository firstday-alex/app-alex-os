// The renderer. Flags plus snapshots in, a report out.
//
// Deterministic on purpose. No model touches the daily readout: code phrases the same
// fact the same way every morning, which is the whole reason the readout can be trusted
// and costs nothing. Order follows the spec: Layer 1 is checked first, every day.

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

function renderStore(detail, section, lines) {
  const win = detail?.primaryWindow;
  lines.push(`STORE. ${win?.label ?? "Store"} against ${(detail?.windows ?? []).filter((w) => w.key !== win?.key).map((w) => w.label).join(" and ")}. Totals compared per day.`);
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
      .map((c) => (c.changePct == null ? `${c.label} n/a` : `${c.label} ${c.changePct > 0 ? "+" : ""}${c.changePct}%${c.basis === "per day" ? "/d" : ""}`))
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
      if (trade.futureValue?.configured === false) {
        lines.push("      Six month value: not configured. Populate config/references.json to weigh lifetime against first order.");
      } else if (trade.futureValue) {
        lines.push(`      Six month value spread, subscription over one time: ${fmtNum(trade.futureValue.spread, { money: true })}.`);
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
    `  ${s.withBigSwing} of ${s.peopleChecked} people hold at least one big swing. ${plural(s.withoutBigSwing, "person has", "people have")} tickets but no big swing. ${plural(s.overloaded, "person holds", "people hold")} more than one.`,
  );
  for (const person of detail.people) {
    lines.push(
      `  ${person.name}: ${person.distinctBigSwings} big swing(s), ${person.bauTickets.length} BAU, ${person.unrelatedTickets.length} unrelated, ${person.totalTickets} tickets total.`,
    );
  }
  lines.push("");
}

/* ---------------------------------- report ---------------------------------- */

export function renderText(report) {
  const lines = [];
  const { detail, sections, config, flags } = report._render;

  lines.push(`TURNPUPS READOUT. ${report.dateKey}. ${report.mode === "official" ? "8 AM official" : "on demand refresh"}.`);
  lines.push(`Run ${report.runId}. Baseline: ${report.baseline.describe}.`);
  if (report.missing.length) {
    lines.push(`PARTIAL. Missing: ${report.missing.map((m) => `${m.section} (${m.reason})`).join("; ")}.`);
  }
  lines.push("");

  const needsAttention = flags.filter((f) => f.severity === "p1" || f.severity === "attention");
  const prompts = flags.filter((f) => f.severity === "prompt");
  lines.push(`NEEDS YOUR ATTENTION. ${needsAttention.length} item(s).`);
  if (needsAttention.length === 0) lines.push("  nothing flagged");
  for (const flag of needsAttention) {
    lines.push(`  [${flag.severity.toUpperCase()}] [${layerLabel(flag.layer)}] ${flag.message}`);
  }
  lines.push("");

  if (prompts.length) {
    lines.push(`OWNER PROMPTS. ${prompts.length} item(s) that did not move and need a next step from their owner.`);
    for (const flag of prompts) lines.push(`  ${flag.message}`);
    lines.push("");
  }

  renderStore(detail.shopify, sections.shopify, lines);
  renderLeadership(detail.leadership, sections.leadership, lines);
  renderCrossLayer(detail.crossLayer, sections.crossLayer, lines);
  renderClickUp(detail.clickup, sections.clickup, lines);
  renderIntelligems(detail.intelligems, sections.intelligems, lines, config);

  const info = flags.filter((f) => f.severity === "info");
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

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `Turnpups readout. ${report.dateKey}` },
  });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${report.mode === "official" ? "8 AM official readout" : "On demand refresh"} · baseline ${report.baseline.describe} · run \`${report.runId}\``,
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
        `*${counts.p1} P1* · *${counts.attention} need attention* · ${counts.prompt} owner prompt(s)`,
        `Layer 1: ${counts.byLayer["1"] ?? 0} · Cross layer: ${counts.byLayer.cross ?? 0} · Layer 2: ${counts.byLayer["2"] ?? 0} · Layer 3: ${counts.byLayer["3"] ?? 0}`,
      ].join("\n"),
    },
  });

  const shown = flags.filter((f) => f.severity !== "info").slice(0, 40);
  if (shown.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "Nothing flagged this morning." } });
  }

  for (const flag of shown) {
    const block = {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${flag.severity === "p1" ? ":red_circle:" : flag.severity === "attention" ? ":large_orange_circle:" : ":speech_balloon:"} *${layerLabel(flag.layer)}* ${flag.message}`,
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
  }

  if (flags.filter((f) => f.severity !== "info").length > shown.length) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `${flags.length - shown.length} more item(s) in the full readout on the dashboard.` }],
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
  const byLayer = {};
  for (const flag of flags) byLayer[String(flag.layer)] = (byLayer[String(flag.layer)] ?? 0) + 1;

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
      total: flags.length,
      p1: flags.filter((f) => f.severity === "p1").length,
      attention: flags.filter((f) => f.severity === "attention").length,
      prompt: flags.filter((f) => f.severity === "prompt").length,
      info: flags.filter((f) => f.severity === "info").length,
      byLayer,
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

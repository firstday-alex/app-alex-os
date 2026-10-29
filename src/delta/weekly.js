// The Friday roll-up. The week in one place: what shipped against the rocks, what
// slipped, how the sprint's alignment moved, and what was handled.
//
// Built every run from what is already stored, so the dashboard can show it any day and
// the Friday readout leads with it: the rocks audit trail (timestamped exactly), the
// current ClickUp snapshot (tickets closed this week), last week's official report (the
// alignment then), and the flag ledger (what was handled). Nothing is fetched for it.

import { accountableFor } from "./crosslayer.js";

const DAY_MS = 86_400_000;

export function buildWeekly({ now, audit = [], rocks = [], tasks = [], cross = null, lastWeek = null, ledgerEntries = {}, flags = [], tests = [], preSprint = null, statusLabels = {} }) {
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const inWeek = (iso) => iso && new Date(iso).getTime() > since.getTime();
  const label = (s) => statusLabels[s] ?? s;

  // Rocks: from the audit trail, newest last, one line per change that matters.
  const shipped = [];
  const statusChanges = [];
  const created = [];
  const backlogged = [];
  for (const entry of audit.filter((e) => inWeek(e.at)).sort((a, b) => new Date(a.at) - new Date(b.at))) {
    for (const c of entry.changes ?? []) {
      if (c.change === "created") created.push(c.title);
      if (c.change !== "updated") continue;
      if (c.diff?.state?.to === "shipped") shipped.push(c.title);
      if (c.diff?.state?.to === "backlog") backlogged.push(c.title);
      if (c.diff?.status) statusChanges.push({ title: c.title, from: label(c.diff.status.from), to: label(c.diff.status.to) });
    }
  }

  // Tickets closed this week, by the person accountable for each.
  const closed = tasks.filter((t) => t.bucket === "done" && t.dateClosed && t.dateClosed > since.getTime());
  const byPerson = new Map();
  for (const t of closed) {
    for (const who of accountableFor(t)) {
      const row = byPerson.get(who.id) ?? { name: who.name, count: 0 };
      row.count += 1;
      byPerson.set(who.id, row);
    }
  }

  // Alignment: share of people with a big swing on a live rock, now and a week ago.
  const alignment = (summary) =>
    summary && summary.peopleChecked != null
      ? { withBigSwing: summary.withBigSwing ?? 0, withoutBigSwing: summary.withoutBigSwing ?? 0, peopleChecked: summary.peopleChecked }
      : null;

  // Flags handled this week, from the ledger's own timestamps.
  const handled = Object.values(ledgerEntries).filter((e) => inWeek(e.triage?.at) && ["done", "dismissed"].includes(e.triage?.status)).length;
  const open = flags.filter((f) => !f.triage && (f.severity === "p1" || f.severity === "attention"));

  const activeRocks = rocks.filter((r) => r.state === "active");
  const stalled = flags.filter((f) => f.rule === "crosslayer.rock_work_stalled").map((f) => f.subject?.label);
  const atRisk = activeRocks.filter((r) => r.status === "at_risk").map((r) => r.title);

  return {
    since: since.toISOString(),
    rocks: { shipped, created, backlogged, statusChanges, atRisk, stalled, active: activeRocks.length },
    tickets: { closed: closed.length, byPerson: [...byPerson.values()].sort((a, b) => b.count - a.count) },
    alignment: { now: alignment(cross), lastWeek: alignment(lastWeek?.crossSummary ?? null), lastWeekDate: lastWeek?.dateKey ?? null },
    flags: { handled, open: open.length, p1: open.filter((f) => f.severity === "p1").length, escalated: open.filter((f) => f.escalated).length },
    tests: {
      decisionsDue: flags.filter((f) => f.rule === "intelligems.decision_due" && !f.triage).map((f) => f.subject?.label),
      running: tests.length,
    },
    preSprintGaps: preSprint?.available ? (preSprint.people ?? []).filter((p) => p.noBigSwing).length + (preSprint.unqueuedRocks ?? []).length : null,
  };
}

/** The roll-up as plain lines, for the Friday text readout and Slack. */
export function weeklyLines(w) {
  if (!w) return [];
  const list = (xs) => xs.map((x) => `"${x}"`).join(", ");
  const out = [];
  if (w.rocks.shipped.length) out.push(`Shipped: ${list(w.rocks.shipped)}.`);
  if (w.rocks.statusChanges.length) out.push(`Status changes: ${w.rocks.statusChanges.map((c) => `"${c.title}" ${c.from} to ${c.to}`).join("; ")}.`);
  if (w.rocks.atRisk.length) out.push(`At Risk now: ${list(w.rocks.atRisk)}.`);
  if (w.rocks.stalled.length) out.push(`Work stopped on: ${list(w.rocks.stalled)}.`);
  if (w.rocks.created.length) out.push(`New rocks: ${list(w.rocks.created)}.`);
  if (w.rocks.backlogged.length) out.push(`Moved to the backlog: ${list(w.rocks.backlogged)}.`);
  out.push(`${w.tickets.closed} ticket(s) closed${w.tickets.byPerson.length ? `: ${w.tickets.byPerson.map((p) => `${p.name} ${p.count}`).join(", ")}` : ""}.`);
  const a = w.alignment;
  if (a.now) {
    out.push(
      `Big swing on a live rock: ${a.now.withBigSwing} of ${a.now.peopleChecked} people${a.lastWeek ? ` (a week ago ${a.lastWeek.withBigSwing} of ${a.lastWeek.peopleChecked})` : ""}.`,
    );
  }
  out.push(`Flags: ${w.flags.handled} handled this week, ${w.flags.open} still open (${w.flags.p1} P1${w.flags.escalated ? `, ${w.flags.escalated} escalated` : ""}).`);
  if (w.tests.decisionsDue.length) out.push(`Tests waiting on a decision: ${list(w.tests.decisionsDue)}.`);
  if (w.preSprintGaps) out.push(`Before next sprint: ${w.preSprintGaps} gap(s) to fix in the Ready pool. See the Backlog tab.`);
  return out;
}

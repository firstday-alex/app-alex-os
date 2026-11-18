// Today's rock moves: the few things Alex could do today that move a rock, each with what
// it moves and why now, and a record of the ones picked and done.
//
// Alex, 2026-11-17: "a higher likelihood I would do the higher value tasks if I had them
// easily available and acknowledged and clarity in impact". So three parts:
//
//   available     suggestions(), worked out from what the readout already holds, ranked:
//                 the decision an off-course or drifting rock is waiting on (its lead
//                 signal and fix, from the rock course check), this week's items on the
//                 Quarter plan, and Alex's own open tickets that are on a rock.
//   impact        every move carries the rock it moves, that rock's course, its
//                 definition of done, this month's milestone and, for a ticket on a
//                 tactic, the tactic and its KPI. All copied from the rocks (Supabase) and
//                 ClickUp; nothing is estimated or written by a model.
//   acknowledged  FocusStore keeps the moves Alex picks each day and when each was done;
//                 weekTally() counts them per day and per rock, with the tickets on rocks
//                 Alex shipped this week, so finished rock work is counted where it is seen.
//
// Stored as focus/<dateKey>.json, this app's own. Nothing here writes to ClickUp or Supabase.

import { placeTicket } from "../delta/rock-course.js";
import { weekStartOf, addDays, monthName } from "../../public/quarter.js";
import { dateKey as zonedDateKey } from "../lib/time.js";

export class FocusError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const MAX_PICKS = 3;
const MAX_TEXT = 200;
const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const first = (name) => String(name ?? "").trim().split(/\s+/)[0];
const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const sameFirst = (a, b) => a && b && first(a).toLowerCase() === first(b).toLowerCase();

/** What a move on this rock moves: the rock, its course, its definition of done, this month's milestone. */
export function impactOf(rock, course, dateKey, tactic = null) {
  const month = dateKey.slice(0, 7);
  const milestone = (rock.milestones ?? []).find((m) => m.month === month && !m.done) ?? (rock.milestones ?? []).find((m) => m.month > month && !m.done) ?? null;
  return {
    rockId: rock.id,
    rockTitle: rock.title,
    rockOwner: rock.owner?.name ?? null,
    course: course?.course ?? null,
    statusColor: rock.statusColor ?? null,
    definitionOfDone: rock.kpi ? clip(rock.kpi, 220) : null,
    milestone: milestone ? { month: milestone.month, label: monthName(milestone.month), deliverable: clip(milestone.deliverable, 140) } : null,
    tactic: tactic ? { id: tactic.id, title: clip(tactic.title, 100), kpi: tactic.kpi ? clip(tactic.kpi, 120) : null } : null,
  };
}

/**
 * The moves on offer today, best first. Pure: reads the readout, the quarter plan and the
 * moves already picked today.
 */
export function suggestions({ report, plan, dateKey, timeZone, alex = {}, picked = [], limit = 6 }) {
  const rocks = (report?.detail?.leadership?.queue ?? []).filter((r) => r.state === "active" && !r.bau);
  if (!rocks.length) return [];
  const courses = new Map((report?.detail?.rockCourse ?? []).map((c) => [c.id, c]));
  const out = [];
  const add = (m) => out.push(m);
  const courseBonus = (c) => (c?.course === "off" ? 30 : c?.course === "drift" ? 15 : 0);

  // 1. The decision a rock off course or drifting is waiting on.
  for (const rock of rocks) {
    const c = courses.get(rock.id);
    if (!c || c.course === "on") continue;
    const lead = (c.signals ?? []).find((s) => s.level !== "gap");
    if (!lead) continue;
    const owner = rock.owner?.name ?? null;
    const withWhom = owner && !sameFirst(owner, alex.name) ? ` (with ${first(owner)})` : "";
    add({
      id: `course:${rock.id}:${lead.kind}`,
      source: "course",
      text: clip(`${rock.title} — ${lead.fix}${withWhom}`, MAX_TEXT),
      why: capital(lead.text),
      score: 70 + courseBonus(c),
      impact: impactOf(rock, c, dateKey),
    });
  }

  // 2. This week's items on the Quarter plan, not done.
  const week = weekStartOf(dateKey);
  for (const p of (plan?.items ?? []).filter((p) => p.week === week && !p.done)) {
    const rock = rocks.find((r) => r.id === p.rockId);
    if (!rock) continue;
    const c = courses.get(rock.id);
    const tactic = (rock.tactics ?? []).find((t) => t.id === p.tacticId) ?? null;
    add({
      id: `plan:${p.id}`,
      source: "plan",
      text: clip(p.text, MAX_TEXT),
      why: "Planned for this week on the Quarter plan",
      score: 55 + courseBonus(c),
      impact: impactOf(rock, c, dateKey, tactic),
    });
  }

  // 3. Alex's own open tickets on a rock: in progress, due or overdue first.
  const tasks = report?.detail?.clickup?.tasks ?? [];
  const mine = tasks.filter((t) => !t.archived && t.bucket !== "done" && (t.assignees ?? []).some((u) => alex.clickupUserId != null && String(u.id) === String(alex.clickupUserId)));
  for (const t of mine) {
    const place = placeTicket(rocks, t);
    if (!place) continue;
    const rock = rocks.find((r) => r.id === place.rockId);
    const c = courses.get(rock.id);
    const tactic = (rock.tactics ?? []).find((x) => x.id === place.tacticId) ?? null;
    const due = t.dueDate ? zonedDateKey(new Date(Number(t.dueDate)), timeZone) : null;
    const dueWord = due ? (due < dateKey ? "overdue" : due === dateKey ? "due today" : null) : null;
    add({
      id: `ticket:${t.id}`,
      source: "ticket",
      text: clip(t.name, MAX_TEXT),
      why: [`Your ticket, ${t.status}`, dueWord].filter(Boolean).join(", "),
      url: t.url ?? null,
      score: 40 + (t.bucket === "inProgress" ? 10 : 0) + (dueWord ? 20 : 0) + courseBonus(c),
      impact: impactOf(rock, c, dateKey, tactic),
    });
  }

  const taken = new Set(picked.map((p) => p.id));
  return out
    .filter((m) => !taken.has(m.id))
    .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text))
    .slice(0, limit);
}

/** The tickets on a rock, assigned to Alex, finished between two days (inclusive). */
export function shippedOnRocks({ report, from, to, timeZone, alex = {} }) {
  const rocks = (report?.detail?.leadership?.queue ?? []).filter((r) => r.state === "active" && !r.bau);
  const doneOn = (t) => {
    const ms = t.dateDone ?? t.dateClosed ?? (t.statusAge?.exact ? t.statusAge.since : null);
    return ms ? zonedDateKey(new Date(Number(ms)), timeZone) : null;
  };
  return (report?.detail?.clickup?.tasks ?? [])
    .filter((t) => t.bucket === "done" && (t.assignees ?? []).some((u) => alex.clickupUserId != null && String(u.id) === String(alex.clickupUserId)))
    .map((t) => ({ t, on: doneOn(t), place: placeTicket(rocks, t) }))
    .filter(({ on, place }) => on && on >= from && on <= to && place)
    .map(({ t, on, place }) => ({ id: t.id, name: clip(t.name, 140), url: t.url ?? null, doneOn: on, rockId: place.rockId, rockTitle: rocks.find((r) => r.id === place.rockId)?.title ?? null }));
}

export class FocusStore {
  constructor(backend, logger) {
    this.backend = backend;
    this.logger = logger;
  }

  static key(dateKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey))) throw new FocusError("Which day?");
    return `focus/${dateKey}.json`;
  }

  async read(dateKey) {
    return (await this.backend.get(FocusStore.key(dateKey))) ?? { dateKey, picks: [], updatedAt: null };
  }

  /**
   * One change to a day's moves:
   *   { pick: {id, text, why?, url?, source?, impact?} }   at most MAX_PICKS a day
   *   { start: id }   started now (kept if already started)
   *   { done: id, note? }   { undo: id }   { remove: id }
   */
  async apply(dateKey, change, { now = new Date() } = {}) {
    const doc = await this.read(dateKey);
    const at = now.toISOString();
    const find = (id) => {
      const p = doc.picks.find((x) => x.id === String(id));
      if (!p) throw new FocusError("That move is not on today's list. Reload and try again.", 404);
      return p;
    };
    if (change?.pick) {
      const m = change.pick;
      const text = clip(m.text, MAX_TEXT);
      if (!text) throw new FocusError("Say what the move is.");
      const id = String(m.id ?? `own:${Date.now().toString(36)}`);
      if (doc.picks.some((p) => p.id === id)) throw new FocusError("Already on today's list.", 409);
      const impact = m.impact && typeof m.impact === "object" ? m.impact : null;
      if (!impact?.rockId) throw new FocusError("Which rock does it move?");
      if (doc.picks.filter((p) => !p.doneAt).length >= MAX_PICKS) throw new FocusError(`${MAX_PICKS} open moves is the most for one day. Finish or drop one first.`, 409);
      doc.picks.push({
        id,
        text,
        why: m.why ? clip(m.why, 300) : null,
        url: typeof m.url === "string" && /^https:\/\//.test(m.url) ? m.url : null,
        source: ["course", "plan", "ticket", "own"].includes(m.source) ? m.source : "own",
        impact,
        pickedAt: at,
        startedAt: change.start ? at : null,
        doneAt: null,
        note: null,
      });
    } else if (change?.start) {
      const p = find(change.start);
      p.startedAt = p.startedAt ?? at;
    } else if (change?.done) {
      const p = find(change.done);
      p.doneAt = at;
      p.note = change.note ? clip(change.note, 300) : null;
    } else if (change?.undo) {
      const p = find(change.undo);
      p.doneAt = null;
      p.note = null;
      p.startedAt = p.startedAt ?? null;
    } else if (change?.remove) {
      find(change.remove);
      doc.picks = doc.picks.filter((p) => p.id !== String(change.remove));
    } else {
      throw new FocusError("Pick, start, done, undo or remove?");
    }
    doc.updatedAt = at;
    await this.backend.set(FocusStore.key(dateKey), doc);
    return doc;
  }

  /** Monday to `dateKey`: each day's moves, and the done ones counted per rock. */
  async week(dateKey) {
    const start = weekStartOf(dateKey);
    const days = [];
    for (let k = start; k <= dateKey; k = addDays(k, 1)) days.push(await this.read(k));
    return weekTally(days);
  }
}

/** Pure: a week of days as the strip and the per-rock count. */
export function weekTally(days) {
  const done = days.flatMap((d) => d.picks.filter((p) => p.doneAt).map((p) => ({ ...p, dateKey: d.dateKey })));
  const byRock = new Map();
  for (const p of done) {
    const k = p.impact?.rockTitle ?? "Other";
    byRock.set(k, (byRock.get(k) ?? 0) + 1);
  }
  return {
    days: days.map((d) => ({ dateKey: d.dateKey, picked: d.picks.length, done: d.picks.filter((p) => p.doneAt).length })),
    done: done.length,
    rocks: [...byRock.entries()].map(([title, n]) => ({ title, n })).sort((a, b) => b.n - a.n || a.title.localeCompare(b.title)),
  };
}

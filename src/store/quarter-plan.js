// The Quarter plan: what Alex plans to get done each week, under each rock and tactic,
// and a record of the tickets that served each rock through the quarter.
//
// Two documents per quarter, both this app's own (Supabase stays read only, ClickUp is
// not written to from here):
//
//   plan/<quarter>.json          the planned items. Each is one line of work for one week,
//                                on a rock and optionally one of its tactics, optionally
//                                tied to a ClickUp ticket. Same optimistic version check
//                                as the rocks store; every change goes to plan/audit/.
//   plan/<quarter>-tickets.json  every ticket seen on a rock this quarter: when it was
//                                first and last seen, and the day it was first seen done.
//                                The sprint list only holds the current sprint, so without
//                                this October's finished work would vanish from the
//                                planner as soon as its sprint closed. Folded from each
//                                official readout, and backfilled once from the stored
//                                readouts when the document is new.

import { placeTicket } from "../delta/rock-course.js";
import { quarterWeeks, quarterOfKey } from "../../public/quarter.js";
import { dateKey as zonedDateKey } from "../lib/time.js";

export class PlanError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MAX_TEXT = 200;
const MAX_ITEMS = 600;
const str = (v) => (v == null || String(v).trim() === "" ? null : String(v).trim());

export class QuarterPlanStore {
  constructor(backend, logger) {
    this.backend = backend;
    this.logger = logger;
  }

  static key(quarter) {
    if (!/^\d{4}-Q[1-4]$/.test(String(quarter))) throw new PlanError("Which quarter?");
    return `plan/${quarter}.json`;
  }

  async read(quarter) {
    return (await this.backend.get(QuarterPlanStore.key(quarter))) ?? { quarter, version: 0, items: [], updatedAt: null };
  }

  /**
   * Applies one change. `change` is { add: {week, rockId, tacticId?, text, ticketId?} },
   * { update: {id, done?, week?, text?} } or { remove: id }.
   */
  async apply(quarter, change, { expectedVersion, actor = "dashboard" } = {}) {
    const doc = await this.read(quarter);
    if (expectedVersion != null && doc.version !== expectedVersion) {
      throw new PlanError(`The plan changed since you loaded it (you had version ${expectedVersion}, it is on ${doc.version}). Reload and try again.`, 409);
    }
    const weeks = new Set(quarterWeeks(quarter).map((w) => w.start));
    const now = new Date().toISOString();
    let items = [...doc.items];
    let reason;

    if (change.add) {
      const a = change.add;
      const text = str(a.text);
      if (!text) throw new PlanError("What is the work?");
      if (text.length > MAX_TEXT) throw new PlanError(`Keep it under ${MAX_TEXT} characters.`);
      if (!weeks.has(a.week)) throw new PlanError("That week is not in this quarter.");
      if (!str(a.rockId)) throw new PlanError("Which rock is it for?");
      if (items.length >= MAX_ITEMS) throw new PlanError("The plan is full.");
      const item = {
        id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        week: a.week,
        rockId: str(a.rockId),
        tacticId: str(a.tacticId),
        text,
        ticketId: str(a.ticketId),
        done: false,
        doneAt: null,
        createdAt: now,
      };
      items.push(item);
      reason = `planned "${text}" for the week of ${a.week}`;
    } else if (change.update) {
      const u = change.update;
      const i = items.findIndex((x) => x.id === u.id);
      if (i < 0) throw new PlanError("That item is not in the plan any more. Reload.", 404);
      const next = { ...items[i] };
      if (u.done != null) {
        next.done = Boolean(u.done);
        next.doneAt = next.done ? now : null;
      }
      if (u.week != null) {
        if (!weeks.has(u.week)) throw new PlanError("That week is not in this quarter.");
        next.week = u.week;
      }
      if (u.text != null) {
        const text = str(u.text);
        if (!text || text.length > MAX_TEXT) throw new PlanError(`Keep it between 1 and ${MAX_TEXT} characters.`);
        next.text = text;
      }
      items[i] = next;
      reason = u.done != null ? `marked "${next.text}" ${next.done ? "done" : "not done"}` : `moved "${next.text}" to the week of ${next.week}`;
    } else if (change.remove) {
      const gone = items.find((x) => x.id === change.remove);
      if (!gone) throw new PlanError("That item is not in the plan any more. Reload.", 404);
      items = items.filter((x) => x.id !== change.remove);
      reason = `removed "${gone.text}"`;
    } else {
      throw new PlanError("Add, update or remove?");
    }

    const next = { quarter, version: (doc.version ?? 0) + 1, items, updatedAt: now };
    await this.backend.set(QuarterPlanStore.key(quarter), next);
    await this.backend.set(`plan/audit/${now}-v${next.version}.json`, { at: now, quarter, version: next.version, actor, reason, change });
    return next;
  }

  /* ------------------------------ ticket ledger ------------------------------ */

  async readTickets(quarter) {
    return (await this.backend.get(`plan/${quarter}-tickets.json`)) ?? { quarter, tickets: {}, backfilled: false, updatedAt: null };
  }

  /**
   * Folds one readout's tickets in. Pure on the document; `persist` writes it.
   *
   * @param {object} doc   the ledger as read
   * @param {object[]} tasks  sprint (and backlog) tickets as the readout holds them
   * @param {object[]} rocks  the leadership queue, for which rock a ticket serves
   * @param {string} dayKey   the readout's date
   */
  static fold(doc, tasks, rocks, dayKey, timeZone) {
    const tickets = { ...doc.tickets };
    const live = (rocks ?? []).filter((r) => !r.bau);
    for (const t of tasks ?? []) {
      if (!t?.id || t.archived) continue;
      const place = placeTicket(live, t);
      const before = tickets[t.id];
      if (!place && !before) continue;
      const done = t.bucket === "done" || t.closed;
      const closedKey = t.dateClosed ? zonedDateKey(new Date(Number(t.dateClosed)), timeZone) : null;
      tickets[t.id] = {
        id: String(t.id),
        name: t.name,
        url: t.url ?? null,
        rockId: place?.rockId ?? before?.rockId ?? null,
        tacticId: place ? place.tacticId : before?.tacticId ?? null,
        status: t.status ?? null,
        bucket: t.bucket ?? null,
        dueOn: t.dueDate ? zonedDateKey(new Date(Number(t.dueDate)), timeZone) : null,
        who: (t.taskOwners?.length ? t.taskOwners : t.assignees ?? []).map((u) => u.username).filter(Boolean)[0] ?? null,
        firstSeen: before?.firstSeen ?? dayKey,
        lastSeen: dayKey,
        doneOn: done ? before?.doneOn ?? closedKey ?? dayKey : null,
      };
    }
    return { ...doc, tickets, updatedAt: new Date().toISOString() };
  }

  /**
   * This readout's tickets folded into the quarter's ledger. Backfills from the stored
   * official readouts the first time, so the weeks already gone are not empty.
   */
  async observeTickets({ store, tasks, rocks, dayKey, timeZone, persist = true, reportPrefix = "reports" }) {
    const quarter = quarterOfKey(dayKey);
    let doc = await this.readTickets(quarter);
    if (!doc.backfilled && store && persist) {
      const first = quarterWeeks(quarter)[0]?.start ?? `${dayKey.slice(0, 7)}-01`;
      const latestPerDay = new Map();
      for (const k of await store.backend.keys(`${reportPrefix}/`)) {
        const m = k.match(/\/(\d{4}-\d{2}-\d{2})-official-/);
        if (!m || m[1] < first || m[1] >= dayKey) continue;
        if (!latestPerDay.has(m[1]) || k > latestPerDay.get(m[1])) latestPerDay.set(m[1], k);
      }
      for (const [day, key] of [...latestPerDay].sort((a, b) => a[0].localeCompare(b[0]))) {
        try {
          const r = await store.backend.get(key);
          if (!r) continue;
          const pastRocks = r.detail?.leadership?.queue?.length ? r.detail.leadership.queue : rocks;
          doc = QuarterPlanStore.fold(doc, [...(r.detail?.clickup?.tasks ?? [])], pastRocks, day, timeZone);
        } catch (err) {
          this.logger?.warn?.("plan.backfill_report_failed", { key, err });
        }
      }
      doc.backfilled = true;
      this.logger?.info?.("plan.tickets_backfilled", { readouts: latestPerDay.size, tickets: Object.keys(doc.tickets).length });
    }
    doc = QuarterPlanStore.fold(doc, tasks, rocks, dayKey, timeZone);
    if (persist) await this.backend.set(`plan/${quarter}-tickets.json`, doc);
    return doc;
  }
}

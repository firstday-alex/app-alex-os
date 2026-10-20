// What happened to each flag after it was raised: how long it has been open, and what
// Alex decided to do about it.
//
// A flag's id carries the date, so on its own every morning starts from zero and nothing
// handled yesterday stays handled. The ledger is keyed on `flag.key` (rule plus subject,
// no date), which is the same flag on any day.
//
// Two writers, each owning different fields:
//   the pipeline   firstSeen, lastSeen, layer. Observations, recorded every run.
//   the dashboard  triage. Decisions, recorded when Alex makes one.
// Each writer re-reads the document and changes only its own fields, so a triage saved
// while a run is in flight is not overwritten by that run.
//
// An entry lives only while its flag keeps being raised. When the condition clears, the
// entry goes, triage and all, so if it comes back later it comes back as new. Clearing
// is only trusted for a layer whose collector actually ran: a failed ClickUp pull raises
// no ClickUp flags, and that must not read as every ClickUp problem being fixed.

import crypto from "node:crypto";
import { addWorkingDays, workingDaysBetween, shiftDateKey, isWorkingDayKey } from "../lib/time.js";

const DOC_KEY = "flags/ledger.json";

/** The section that has to be present for a layer's silence to mean "cleared". */
export const LAYER_SECTION = { 0: "shopify", 1: "leadership", 2: "clickup", 3: "intelligems", cross: "crossLayer" };

export const TRIAGE = {
  done: "Done",
  snoozed: "Snoozed",
  waiting: "Waiting on",
  dismissed: "Not a problem",
};

export class FlagLedgerError extends Error {
  constructor(message) {
    super(message);
    this.name = "FlagLedgerError";
  }
}

/** The ledger key for a flag. Older stored flags have no `key`, so it is derived from the id. */
export function flagKey(flag) {
  if (flag.key) return flag.key;
  return String(flag.id ?? "").replace(/^(\d{4}-\d{2}-\d{2}|nodate):/, "");
}

/**
 * A short, stable reference to a flag key, for Slack button values. Slack caps an option
 * value at 150 characters and a key built from test and group ids can run past that, so
 * the button carries this and the handler finds the key it belongs to.
 */
export function flagRef(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 20);
}

/** The key, among `keys`, that `ref` points at. Null when it is no longer raised. */
export function keyForRef(ref, keys) {
  return keys.find((k) => flagRef(k) === ref) ?? null;
}

/** Triage that is still in force on `today`. A snooze or a wait runs out on its date. */
export function activeTriage(triage, today) {
  if (!triage?.status) return null;
  if (triage.until && triage.until <= today) return null;
  return triage;
}

/**
 * Stamps each flag with its age and triage, and escalates attention flags that have been
 * open too long. Pure: the ledger entries in, annotated flags and the next entries out.
 *
 * @param {Array<object>} flags
 * @param {Record<string, object>} entries   the ledger as it stands
 * @param {object} opts
 * @param {string} opts.dateKey              today, Central
 * @param {Record<string, {present:boolean}>} opts.sections
 * @param {number} [opts.escalateAfterWorkingDays]
 * @param {number[]} [opts.workingWeekdays]
 */
export function annotateFlags(flags, entries, { dateKey, sections = {}, escalateAfterWorkingDays = 5, workingWeekdays } = {}) {
  const next = {};
  const raised = new Set();

  const annotated = flags.map((flag) => {
    const key = flagKey(flag);
    raised.add(key);
    const before = entries[key] ?? {};
    const firstSeen = before.firstSeen && before.firstSeen <= dateKey ? before.firstSeen : dateKey;
    const triage = activeTriage(before.triage, dateKey);

    next[key] = {
      firstSeen,
      lastSeen: dateKey,
      layer: flag.layer,
      ...(triage ? { triage } : {}),
    };

    const openDays = workingDaysBetween(firstSeen, dateKey, workingWeekdays);
    const out = { ...flag, key, firstSeen, openDays, isNew: firstSeen === dateKey };
    if (triage) out.triage = triage;

    // Something left at Attention for a week has stopped being something to keep an eye
    // on. It goes to P1, and says so, so the change in severity is never a mystery.
    if (flag.severity === "attention" && escalateAfterWorkingDays > 0 && openDays >= escalateAfterWorkingDays) {
      out.severity = "p1";
      out.escalated = true;
      out.originalSeverity = "attention";
    }
    return out;
  });

  // Entries for flags not raised this run. Kept only where we cannot tell whether the
  // condition cleared, and only for a month, so the document cannot grow forever.
  const keepUntil = shiftDateKey(dateKey, -30);
  for (const [key, entry] of Object.entries(entries)) {
    if (raised.has(key)) continue;
    const section = LAYER_SECTION[String(entry.layer)];
    const layerRan = section ? sections[section]?.present === true : false;
    if (layerRan) continue;
    if ((entry.lastSeen ?? "") < keepUntil) continue;
    next[key] = entry;
  }

  return { flags: annotated, entries: next };
}

export class FlagLedger {
  constructor(backend, logger) {
    this.backend = backend;
    this.logger = logger;
  }

  async read() {
    const doc = await this.backend.get(DOC_KEY);
    return doc && typeof doc.entries === "object" ? doc : { version: 0, updatedAt: null, entries: {} };
  }

  /**
   * The pipeline's write. Observations come from `computed`; triage comes from a fresh
   * read, because the dashboard may have written since the run started.
   */
  async saveObservations(computed) {
    const fresh = await this.read();
    const entries = {};
    for (const [key, entry] of Object.entries(computed)) {
      const live = fresh.entries[key] ?? {};
      const { triage: _t, ...observed } = entry;
      entries[key] = {
        ...observed,
        ...(live.triage ? { triage: live.triage } : entry.triage ? { triage: entry.triage } : {}),
      };
    }
    const doc = { version: (fresh.version ?? 0) + 1, updatedAt: new Date().toISOString(), entries };
    await this.backend.set(DOC_KEY, doc);
    return doc;
  }

  /**
   * The dashboard's write. Sets or clears the triage on one flag.
   *
   * @param {string} key
   * @param {object} action  { status: 'done'|'snoozed'|'waiting'|'dismissed'|null, workingDays?, waitingOn?, note? }
   * @param {object} ctx     { today, workingWeekdays, by, layer, defaultWaitingDays }
   */
  async setTriage(key, action, { today, workingWeekdays, by = "dashboard", layer = null, defaultWaitingDays = 2 } = {}) {
    if (!key) throw new FlagLedgerError("key is required");
    const status = action?.status ?? null;
    if (status !== null && !TRIAGE[status]) throw new FlagLedgerError(`Unknown triage "${status}".`);

    const doc = await this.read();
    const entry = { ...(doc.entries[key] ?? { firstSeen: today, lastSeen: today, layer }) };

    if (status === null) {
      delete entry.triage;
    } else {
      const triage = { status, at: new Date().toISOString(), by };
      const days = Number(action.workingDays);
      if (status === "snoozed") {
        if (!(days > 0)) throw new FlagLedgerError("A snooze needs a number of working days.");
        triage.until = addWorkingDays(today, days, workingWeekdays);
      }
      if (status === "waiting") {
        const name = String(action.waitingOn ?? "").trim();
        if (!name) throw new FlagLedgerError("Say who it is waiting on.");
        triage.waitingOn = name.slice(0, 120);
        triage.until = addWorkingDays(today, days > 0 ? days : defaultWaitingDays, workingWeekdays);
      }
      const note = String(action.note ?? "").trim();
      if (note) triage.note = note.slice(0, 1000);
      entry.triage = triage;
    }

    doc.entries = { ...doc.entries, [key]: entry };
    doc.version = (doc.version ?? 0) + 1;
    doc.updatedAt = new Date().toISOString();
    await this.backend.set(DOC_KEY, doc);
    return entry;
  }

  /**
   * First-run backfill, so flags already raised for days do not all start at "new today".
   *
   * Reads the official reports already in storage for the last `lookbackDays`, and for
   * each flag raised today walks back through consecutive working days on which it was
   * also raised. A gap ends the run, because a flag that cleared and came back is new.
   */
  async backfillFirstSeen(store, flags, { dateKey, workingWeekdays, lookbackDays = 30 } = {}) {
    const prefix = store.prefixes?.reportPrefix ?? "reports";
    const floor = shiftDateKey(dateKey, -lookbackDays);
    const keys = (await store.backend.keys(`${prefix}/`)).filter((k) => {
      const m = k.match(/\/(\d{4}-\d{2}-\d{2})-official-/);
      return m && m[1] >= floor && m[1] < dateKey;
    });

    const seenOn = new Map(); // flag key -> Set of date keys
    for (const k of keys) {
      const report = await store.backend.get(k).catch(() => null);
      if (!report?.dateKey) continue;
      for (const flag of report.flags ?? []) {
        const fk = flagKey(flag);
        if (!seenOn.has(fk)) seenOn.set(fk, new Set());
        seenOn.get(fk).add(report.dateKey);
      }
    }

    const entries = {};
    for (const flag of flags) {
      const fk = flagKey(flag);
      const dates = seenOn.get(fk);
      if (!dates) continue;
      let first = dateKey;
      let cursor = dateKey;
      for (let i = 0; i < lookbackDays; i += 1) {
        cursor = shiftDateKey(cursor, -1);
        if (cursor < floor) break;
        if (!isWorkingDayKey(cursor, workingWeekdays) && !dates.has(cursor)) continue; // no readout on a weekend
        if (!dates.has(cursor)) break;
        first = cursor;
      }
      if (first !== dateKey) entries[fk] = { firstSeen: first, lastSeen: dateKey, layer: flag.layer };
    }
    this.logger?.info?.("flag_ledger.backfilled", { reports: keys.length, flags: Object.keys(entries).length });
    return entries;
  }
}

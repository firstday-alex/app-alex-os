// How long each ticket has been in its current status.
//
// ClickUp has an API for this. It returns nothing for this workspace — `current_status`
// is `{}` and `status_history` is empty on every open ticket, because time-in-status is
// a paid-tier feature that is not on this plan. Verified against the live API rather
// than assumed.
//
// So it is derived from our own observations instead, which this system is already in a
// good position to do: it snapshots every ticket's status every working day. When a
// ticket's status differs from what we last saw, that is a transition, and the clock
// restarts. Otherwise the clock carries forward.
//
// The honest part is the first observation. A ticket that was already in progress when
// we started watching has been there longer than we know, so the ledger distinguishes
// two kinds of answer and the dashboard renders them differently:
//
//   exact   — we watched the transition happen. "14 days in this status."
//   floor   — we did not. "at least 14 days", from evidence, never from a guess.
//
// The floor is sound rather than approximate. `date_updated` moves on any activity at
// all, including a status change, so if nothing has touched a ticket in 16 days then it
// has certainly been in its current status for at least those 16 days. `date_created`
// gives the other end: a ticket cannot have been in any status longer than it has
// existed. Both are recorded, so a seeded row can say "at least 16d, created 66d ago"
// instead of pretending to a precision it does not have.

const DOC_KEY = "status-ledger/index.json";
const DAY_MS = 86_400_000;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export class StatusLedger {
  constructor(backend, logger) {
    this.backend = backend;
    this.logger = logger;
  }

  async read() {
    const doc = await this.backend.get(DOC_KEY);
    return doc && typeof doc.entries === "object" ? doc : { version: 0, updatedAt: null, entries: {} };
  }

  /**
   * Folds one snapshot's worth of observations into the ledger and returns the result.
   *
   * Idempotent: running twice in a day records the same transition once, because a
   * transition is "the status differs from the one on file", not "a run happened".
   *
   * @param {Array<object>} items    tickets from the ClickUp collector
   * @param {Date} now
   * @param {object} [opts]
   * @param {boolean} [opts.persist] false to compute without writing
   */
  async update(items, now = new Date(), { persist = true } = {}) {
    const doc = await this.read();
    const entries = { ...doc.entries };
    const nowMs = now.getTime();
    const seen = new Set();

    let transitions = 0;
    let seeded = 0;

    for (const item of items ?? []) {
      // Closed work has no staleness worth tracking, and keeping it would grow this
      // document without bound: 229 of 242 tickets on this board are complete.
      if (item.closed || item.statusType === "closed" || item.bucket === "done") continue;

      const id = String(item.id);
      seen.add(id);
      const status = item.status ?? null;
      const prior = entries[id];

      if (!prior) {
        // First sight. Seed the clock from the last activity on the ticket, which is a
        // true lower bound, and remember that it is a bound rather than a measurement.
        const updated = num(item.dateUpdated);
        const created = num(item.dateCreated);
        entries[id] = {
          status,
          since: Math.min(updated ?? nowMs, nowMs),
          exact: false,
          firstObserved: nowMs,
          createdAt: created ?? null,
        };
        seeded += 1;
        continue;
      }

      if (prior.status !== status) {
        // A transition we actually watched. From here the number is exact.
        entries[id] = {
          status,
          since: nowMs,
          exact: true,
          firstObserved: prior.firstObserved ?? nowMs,
          createdAt: prior.createdAt ?? num(item.dateCreated),
          previousStatus: prior.status ?? null,
        };
        transitions += 1;
        continue;
      }

      // Unchanged. The clock keeps running; nothing to write.
      entries[id] = prior;
    }

    // Anything we no longer see is closed, archived or out of the query. Drop it, so a
    // ticket that comes back starts a fresh, honestly-seeded clock.
    for (const id of Object.keys(entries)) if (!seen.has(id)) delete entries[id];

    const next = {
      version: (doc.version ?? 0) + 1,
      updatedAt: new Date(nowMs).toISOString(),
      entries,
    };

    if (persist) {
      await this.backend.set(DOC_KEY, next);
      this.logger?.info?.("status_ledger.updated", {
        tracked: Object.keys(entries).length,
        transitions,
        seeded,
        version: next.version,
      });
    }

    return next;
  }
  /**
   * Rebuilds the ledger from the snapshots already in storage, oldest first.
   *
   * Two reasons this exists rather than the ledger simply accruing from today.
   *
   * The ledger is a single document, and a single document is a single point of failure
   * for the only history we have. The snapshots are the real record; this makes the
   * ledger a derived artefact that can be thrown away and rebuilt, which is the right
   * relationship between the two.
   *
   * And it means the clock does not restart when the feature ships. Every official
   * snapshot already taken is an observation of where each ticket was on that day, so a
   * status change that happened between two stored snapshots is a transition we did in
   * fact witness — we just had not looked yet.
   */
  async backfill(store, now = new Date()) {
    const index = await store.readIndex("clickup");
    const dated = Object.entries(index.officialByDate ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (!dated.length) return { rebuilt: false, reason: "no official snapshots stored yet" };

    // Start clean: replaying onto an existing ledger would read every replayed day as a
    // fresh transition and date everything to today.
    await this.backend.set(DOC_KEY, { version: 0, updatedAt: null, entries: {} });

    let folded = 0;
    for (const [dateKey, key] of dated) {
      const snapshot = await store.getSnapshot(key);
      if (!snapshot?.items?.length) continue;
      // Each snapshot is folded AS OF the day it was taken, not as of now, so an
      // observed transition is dated to the day it actually happened.
      await this.update(snapshot.items, new Date(`${dateKey}T13:00:00Z`));
      folded += 1;
    }

    const doc = await this.read();
    this.logger?.info?.("status_ledger.backfilled", {
      snapshotsFolded: folded,
      from: dated[0][0],
      to: dated[dated.length - 1][0],
      tracked: Object.keys(doc.entries).length,
      exact: Object.values(doc.entries).filter((e) => e.exact).length,
    });
    return { rebuilt: true, snapshotsFolded: folded, from: dated[0][0], to: dated[dated.length - 1][0] };
  }
}

/**
 * Days in the current status, for one ticket, against one ledger.
 *
 * Returns null rather than zero when there is nothing on file: an untracked ticket is
 * unknown, and rendering unknown as "0 days in status" would read as "just moved".
 */
export function statusAge(entry, now = new Date()) {
  if (!entry || !num(entry.since)) return null;
  const days = Math.floor((now.getTime() - entry.since) / DAY_MS);
  const ceilingDays = num(entry.createdAt)
    ? Math.floor((now.getTime() - entry.createdAt) / DAY_MS)
    : null;

  return {
    days: Math.max(0, days),
    exact: Boolean(entry.exact),
    since: new Date(entry.since).toISOString(),
    // Only meaningful while the number is a floor. Once we have watched a transition the
    // age is the age, and the ticket's creation date says nothing more about it.
    ceilingDays: entry.exact ? null : ceilingDays,
    previousStatus: entry.previousStatus ?? null,
  };
}

/**
 * Whether a ticket has sat in its status longer than that status allows.
 *
 * Thresholds are per status bucket because the buckets mean different things. A week in
 * progress is work; a week in QA is a queue nobody is looking at. The not-started bucket
 * has no threshold at all: a backlog is supposed to sit there, and flagging it would
 * bury the two buckets that matter under everything anyone has ever written down.
 */
/**
 * The configured limit for a task's status, or null if it has none.
 *
 * Status first, bucket second: 'in-progress', 'vqa', 'qa' and 'ready for deploy' are all
 * the inProgress bucket, but a week in each means something different. The not-started
 * bucket is excluded outright rather than given a large number — a backlog is supposed
 * to sit, and flagging it would bury the buckets that matter.
 */
export function stalenessThreshold(item, config) {
  const cfg = config?.clickup?.staleness ?? {};
  if (cfg.enabled === false) return null;
  if (item?.bucket === "notStarted") return null;
  return (
    num((cfg.thresholdDaysByStatus ?? {})[item?.status]) ??
    num((cfg.thresholdDaysByBucket ?? {})[item?.bucket]) ??
    null
  );
}

export function isStale(item, age, config) {
  const cfg = config?.clickup?.staleness ?? {};
  if (!age || cfg.enabled === false) return null;

  const bucket = item.bucket ?? null;
  const threshold = stalenessThreshold(item, config);
  if (!threshold) return null;
  if (age.days < threshold) return null;

  return {
    bucket,
    status: item.status ?? null,
    threshold,
    days: age.days,
    exact: age.exact,
    over: age.days - threshold,
  };
}

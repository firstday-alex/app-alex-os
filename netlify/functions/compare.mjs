// The dashboard's day over day, over a chosen window.
//
//   GET /compare?window=readout   against the readout's pinned baseline (previous working day, 8 AM)
//   GET /compare?window=24h       against the snapshot nearest 24 hours ago
//   GET /compare?window=today     against the last snapshot before local midnight
//
// The current side is always the newest stored ClickUp snapshot. Rock changes in the
// same window come from the rocks audit trail, which is timestamped exactly, so they
// need no snapshot at all. Read only: nothing is collected or written here.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";
import { baselineCandidateKeys } from "../../src/lib/time.js";
import { clickupDelta } from "../../src/delta/clickup-delta.js";
import { RocksStore } from "../../src/store/rocks.js";
import { WINDOWS, windowStart, pickBaselineEntry, mergeComments, rockChangesSince } from "../../src/delta/window.js";

/** At most this many snapshots are read to gather comments across a window. */
const MAX_COMMENT_SNAPSHOTS = 30;

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "compare" } });
  const store = await Store.open({ config, logger });
  const url = new URL(req.url);
  const window = url.searchParams.get("window") ?? "readout";
  if (!WINDOWS.includes(window)) return json({ error: `window must be one of ${WINDOWS.join(", ")}` }, 400);

  const now = new Date();
  const index = await store.readIndex("clickup");
  const currentEntry = (index.recent ?? []).find((e) => e.key === index.latest) ?? null;
  const current = await store.getSnapshot(index.latest);
  if (!current) return json({ error: "No ClickUp snapshot is stored yet. Run a refresh first." }, 404);

  let baseline = null;
  let baselineEntry = null;
  let start;
  let gapMinutes = null;
  let coversWindow = true;

  if (window === "readout") {
    const { candidates } = baselineCandidateKeys(now, config);
    const pinned = await store.getBaseline("clickup", candidates);
    baseline = pinned.snapshot;
    baselineEntry = (index.recent ?? []).find((e) => e.key === pinned.key) ?? { key: pinned.key, takenAt: baseline?.takenAt ?? null };
    start = baseline?.takenAt ? new Date(baseline.takenAt) : null;
  } else {
    start = windowStart(window, now, config.system.timezone);
    // Walk back past any entry whose blob has been pruned, rather than failing the window.
    let pool = (index.recent ?? []).filter((e) => e.key !== index.latest);
    while (pool.length && !baseline) {
      const pick = pickBaselineEntry(pool, start);
      if (!pick) break;
      baseline = await store.getSnapshot(pick.entry.key);
      if (baseline) ({ entry: baselineEntry, gapMinutes, coversWindow } = pick);
      else pool = pool.filter((e) => e.key !== pick.entry.key);
    }
  }

  if (!baseline) {
    return json({ window, error: "There is no earlier ClickUp snapshot to compare against yet." }, 404);
  }

  // Comments from every snapshot between the two, so the comment that explains a change
  // is found even when an hourly snapshot in the middle is the one that fetched it.
  const baselineMs = new Date(baseline.takenAt).getTime();
  const between = (index.recent ?? [])
    .filter((e) => e.takenAt && new Date(e.takenAt).getTime() > baselineMs && e.key !== index.latest)
    .sort((a, b) => new Date(a.takenAt) - new Date(b.takenAt))
    .slice(-MAX_COMMENT_SNAPSHOTS);
  const middle = [];
  for (const e of between) {
    const s = await store.getSnapshot(e.key);
    if (s) middle.push(s);
  }
  const comments = mergeComments([...middle, current]);

  const delta = clickupDelta(baseline, current, { config, now: now.getTime(), comments });

  const rocks = new RocksStore(store.backend, logger);
  const audit = start ? rockChangesSince(await rocks.auditTrail({ limit: 60 }), start) : [];

  return json({
    window,
    start: start?.toISOString() ?? null,
    current: { takenAt: current.takenAt, mode: currentEntry?.mode ?? null },
    baseline: { takenAt: baseline.takenAt, mode: baselineEntry?.mode ?? null },
    gapMinutes,
    coversWindow,
    // Only what the day over day view draws. The full task list is the report's job.
    delta: {
      hasBaseline: true,
      statusOrder: delta.statusOrder,
      tasks: delta.tasks.map((t) => ({ status: t.status })),
      changes: delta.changes,
    },
    rockChanges: audit,
  });
};

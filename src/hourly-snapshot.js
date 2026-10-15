// The hourly ClickUp snapshot.
//
// The readout needs one snapshot a day, at 8 AM. The dashboard's "last 24 hours" and
// "today" views need snapshots near any hour, or they compare against whatever happened
// to be stored and the window means nothing. So ClickUp alone is snapshotted every hour.
//
// These are mode "hourly": never the readout's baseline (that is the official 8 AM one
// only), never posted anywhere. They are pruned after a fortnight, because nothing reads
// an hourly snapshot older than a day or two and a year of them is a lot of blobs.

import { collectClickUp } from "./collectors/clickup.js";
import { zonedParts, shiftDateKey } from "./lib/time.js";

export const HOURLY_MODE = "hourly";

/** An hourly run this soon after the last snapshot of any kind is skipped. */
export const MIN_GAP_MINUTES = 30;

export async function takeHourlySnapshot({ config, store, token, logger, now = new Date(), fetchImpl, sleep }) {
  const parts = zonedParts(now, config.system.timezone);

  // Compared against the previous snapshot of any kind, so only tickets that moved in the
  // last hour have their comments re-fetched.
  const { snapshot: previous } = await store.getLatestSnapshot("clickup");

  // The trigger is cron-invoked and checks no request, so this is what bounds a stray or
  // repeated call: at most one crawl per half hour, whoever asks.
  const sinceMinutes = previous?.takenAt ? (now - new Date(previous.takenAt)) / 60000 : Infinity;
  if (sinceMinutes < MIN_GAP_MINUTES) {
    logger?.info?.("hourly.skipped_recent", { sinceMinutes: Math.round(sinceMinutes) });
    return { stored: { stored: false, reason: "a snapshot was taken less than 30 minutes ago" }, pruned: 0, skipped: true };
  }

  const snapshot = await collectClickUp({ config, token, store, logger, fetchImpl, sleep, baseline: previous, now, mode: "refresh" });
  const stored = await store.putSnapshot("clickup", snapshot, {
    dateKey: parts.dateKey,
    timeKey: parts.timeKey,
    mode: HOURLY_MODE,
    runId: `hourly-${parts.dateKey}T${parts.timeKey}`,
  });

  const pruned = await pruneHourly({ store, today: parts.dateKey, keepDays: config.system.storage?.hourlySnapshotDays ?? 14 });
  logger?.info?.("hourly.done", { stored: stored.stored, key: stored.key, tasks: snapshot.items?.length ?? 0, pruned });
  return { stored, pruned };
}

/** Deletes hourly ClickUp snapshots older than `keepDays`. Official and refresh ones are never touched. */
export async function pruneHourly({ store, today, keepDays }) {
  const prefix = `${store.prefixes.snapshotPrefix ?? "snapshots"}/clickup/`;
  const cutoff = shiftDateKey(today, -keepDays);
  const old = (await store.backend.keys(prefix)).filter((key) => {
    if (!key.endsWith(`-${HOURLY_MODE}.json`)) return false;
    const dateKey = key.slice(prefix.length, prefix.length + 10);
    return dateKey < cutoff;
  });
  for (const key of old) await store.backend.del(key);
  return old.length;
}

// Comparison windows for the dashboard's day over day.
//
// The readout's baseline is pinned to the previous working day's 8 AM snapshot, and that
// stays: the 8 AM send has to mean the same thing every day. The dashboard can also ask
// two other questions of the same stored snapshots:
//
//   24h    - what moved in the last 24 hours, against the snapshot nearest 24 hours ago
//   today  - what moved since midnight, against the last snapshot taken before it
//
// A window can only be as sharp as the snapshots behind it. The answer always says which
// snapshot it actually compared against, and how far that is from the window's start,
// rather than claiming an exact 24 hours it does not have.

import { zonedParts } from "../lib/time.js";

export const WINDOWS = ["readout", "24h", "today"];

/** The instant local midnight began today, in the given zone. */
export function startOfLocalDay(now, timeZone) {
  const p = zonedParts(now, timeZone);
  const sinceMidnightMs = ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 + (now.getTime() % 1000);
  return new Date(now.getTime() - sinceMidnightMs);
}

export function windowStart(window, now, timeZone) {
  if (window === "24h") return new Date(now.getTime() - 24 * 3600 * 1000);
  if (window === "today") return startOfLocalDay(now, timeZone);
  throw new Error(`window must be one of ${WINDOWS.join(", ")}`);
}

/**
 * The snapshot to compare against: the newest one taken at or before the window's start.
 *
 * When nothing is that old, the oldest snapshot there is stands in and the answer says it
 * covers less than the window asked for. `gapMinutes` is how far the chosen snapshot sits
 * from the window's start, so the dashboard can say "nearest snapshot was 40 min earlier".
 */
export function pickBaselineEntry(entries, start, { excludeKey = null } = {}) {
  const usable = (entries ?? [])
    .filter((e) => e.takenAt && e.key !== excludeKey)
    .sort((a, b) => new Date(b.takenAt) - new Date(a.takenAt));
  if (!usable.length) return null;

  const startMs = start.getTime();
  const before = usable.find((e) => new Date(e.takenAt).getTime() <= startMs);
  const entry = before ?? usable[usable.length - 1];
  return {
    entry,
    gapMinutes: Math.round(Math.abs(startMs - new Date(entry.takenAt).getTime()) / 60000),
    coversWindow: Boolean(before),
  };
}

/**
 * The latest comment per task across every snapshot in the window, oldest applied first
 * so the newest wins. A snapshot only fetches comments for tasks that moved since the
 * snapshot before it, so the comment that explains a change can sit in any of them.
 */
export function mergeComments(snapshotsOldestFirst) {
  const merged = {};
  for (const snapshot of snapshotsOldestFirst) {
    for (const [taskId, value] of Object.entries(snapshot?.comments ?? {})) {
      if (value) merged[taskId] = value;
    }
  }
  return merged;
}

/** Rock audit entries inside the window, newest first. */
export function rockChangesSince(auditEntries, start) {
  const startMs = start.getTime();
  return (auditEntries ?? [])
    .filter((e) => new Date(e.at).getTime() > startMs)
    .sort((a, b) => new Date(b.at) - new Date(a.at));
}

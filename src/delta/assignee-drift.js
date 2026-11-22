// Done tickets that changed hands during the sprint. Alex, 2026-11-22: "for all complete
// tickets ... see if the assignee when it was first added to the sprint changed to where it
// is now at for its DONE (this sprint) status? so it can flag and prompt me if i want to
// update it back to the original".
//
// Read from this app's own daily ClickUp snapshots: the first snapshot this sprint that
// holds the ticket says who was on it then; the latest says who is on it now. Nothing is
// guessed: a ticket first seen in the latest snapshot has no history to compare and is left
// out.

const DONE = "done (this sprint)";
const ids = (list) => new Set((list ?? []).map((u) => String(u.id)));
const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * @param {object} args
 * @param {Array<{dateKey: string, items: object[]}>} args.snapshots this sprint's, any order
 * @param {object[]} args.current the latest snapshot's tickets
 * @returns {Array<{ id, name, url, firstSeen, was: {id, username}[], now: {id, username}[] }>}
 */
export function assigneeDrift({ snapshots = [], current = [] }) {
  const ordered = [...snapshots].sort((a, b) => String(a.key ?? a.dateKey).localeCompare(String(b.key ?? b.dateKey)));
  const first = new Map();
  for (const snap of ordered) {
    for (const t of snap.items ?? []) {
      const id = String(t.id);
      if (!first.has(id)) first.set(id, { dateKey: snap.dateKey, key: snap.key ?? snap.dateKey, assignees: t.assignees ?? [] });
    }
  }
  const latestKey = ordered.length ? String(ordered.at(-1).key ?? ordered.at(-1).dateKey) : null;
  const out = [];
  for (const t of current) {
    if (String(t.status ?? "").trim().toLowerCase() !== DONE) continue;
    const seen = first.get(String(t.id));
    if (!seen || seen.key === latestKey) continue;
    const was = seen.assignees.map((u) => ({ id: String(u.id), username: u.username ?? null }));
    const now = (t.assignees ?? []).map((u) => ({ id: String(u.id), username: u.username ?? null }));
    if (!was.length || same(ids(was), ids(now))) continue;
    out.push({ id: String(t.id), name: t.name, url: t.url ?? null, firstSeen: seen.dateKey, was, now });
  }
  return out;
}

/**
 * Reads this sprint's ClickUp snapshots (Monday to now, in the configured time zone): the
 * 8 AM one and the last one of each day, which is enough to see the first day a ticket was on
 * the sprint, and the latest for who is on it now.
 */
export async function sprintDriftFromStore({ store, config, now = new Date(), zonedParts, shiftDateKey }) {
  const tz = config.system?.timezone ?? "America/Chicago";
  const today = zonedParts(now, tz);
  const monday = shiftDateKey(today.dateKey, -((today.weekday + 6) % 7));
  const index = await store.readIndex("clickup");
  const keys = new Map();
  for (const [dateKey, key] of [...Object.entries(index.officialByDate ?? {}), ...Object.entries(index.latestByDate ?? {})]) {
    if (dateKey >= monday && dateKey <= today.dateKey && key) keys.set(key, dateKey);
  }
  if (index.latest) keys.set(index.latest, keys.get(index.latest) ?? today.dateKey);
  const snapshots = [];
  for (const [key, dateKey] of keys) {
    const snap = await store.getSnapshot(key);
    if (snap?.items) snapshots.push({ key, dateKey, items: snap.items });
  }
  const latest = snapshots.find((s) => s.key === index.latest) ?? snapshots.sort((a, b) => a.key.localeCompare(b.key)).at(-1);
  return { since: monday, snapshots: snapshots.length, tickets: assigneeDrift({ snapshots, current: latest?.items ?? [] }) };
}

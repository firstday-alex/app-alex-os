// Parked tickets: work that is fine where it is and should not be chased, like a test
// that is built and waiting for a test slot to open.
//
// A ticket is parked when its title carries one of the markers in brackets or
// parentheses, "[Waiting for Test Slot]" or "(on track)", any case, or it has a ClickUp
// tag with the same words. Configured in system.parked.markers.
//
// A parked ticket raises no ticket flags, so nothing nudges about it, and it stays on the
// sprint, labelled. Taking the marker off brings the flags back on the next run.

const DEFAULT_MARKERS = ["waiting for test slot", "on track"];

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parkedMarkers(config) {
  const list = config?.system?.parked?.markers;
  return (Array.isArray(list) && list.length ? list : DEFAULT_MARKERS).map(norm).filter(Boolean);
}

/** Matches a marker in brackets or parentheses, with the space around it. */
function markerRe(markers) {
  const alt = markers.map((m) => escapeRe(m).replace(/ /g, "\\s+")).join("|");
  return new RegExp(`\\s*(?:\\[\\s*(?:${alt})\\s*\\]|\\(\\s*(?:${alt})\\s*\\))\\s*`, "gi");
}

/** Why a ticket is parked, as written on it ("Waiting for Test Slot"), or null. */
export function parkedReason(task, markers) {
  if (!markers.length) return null;
  const inTitle = String(task.name ?? "").match(markerRe(markers));
  if (inTitle) return inTitle[0].trim().replace(/^[[(]\s*|\s*[\])]$/g, "");
  const tag = (task.tags ?? []).find((t) => markers.includes(norm(t)));
  return tag ?? null;
}

/** The title without its parked markers, for the update text. */
export function withoutMarkers(name, markers) {
  if (!markers.length) return name;
  return String(name ?? "").replace(markerRe(markers), " ").replace(/\s+/g, " ").trim();
}

/**
 * Marks each parked ticket in place (`parked`, and `plainName` for the update text) and
 * returns the ids of the parked ones.
 */
export function markParked(tasks, config) {
  const markers = parkedMarkers(config);
  const ids = new Set();
  for (const task of tasks ?? []) {
    const reason = parkedReason(task, markers);
    if (!reason) continue;
    task.parked = reason;
    task.plainName = withoutMarkers(task.name, markers);
    ids.add(String(task.id));
  }
  return ids;
}

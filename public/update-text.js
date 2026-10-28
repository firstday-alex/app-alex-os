// The daily update and the accomplishments list, written from ClickUp.
//
// Both are grouped by Big Swing, one ticket per line, ready to paste into the update doc.
// Nothing here is invented: each line is the ticket's own name, who is doing it, its
// status and a date ClickUp recorded.
//
//   **Upsells / Bundles 2.0**
//   ✅ @Robson – Bundle page build – done 10/27
//   @Cristobal – QA – Checkout upsell – last update: 10/27
//
// "done (this sprint)" and "complete" are different statuses. The daily update carries
// the first, never the second; accomplishments carry both.

// Statuses the daily update covers, furthest along first. "complete" is deliberately absent.
export const UPDATE_STATUSES = ["done (this sprint)", "done", "ready for deploy", "vqa", "qa", "in review", "in-progress", "in progress", "to do"];
const DONE_STATUSES = new Set(["done (this sprint)", "done", "complete"]);

const STATUS_LABEL = {
  "to do": "To do",
  "in-progress": "In progress",
  "in progress": "In progress",
  qa: "QA",
  vqa: "VQA",
  "in review": "In review",
  "ready for deploy": "Ready for deploy",
};

/** Start of the previous working day (Mon–Fri), local time. On a Monday that is Friday. */
export function windowStart(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  do d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6);
  return d.getTime();
}

/** The latest thing that happened to a ticket: an update, a close, or a comment. */
export function lastActivity(task) {
  return Math.max(task.dateUpdated ?? 0, task.dateClosed ?? 0, task.lastComment?.date ?? 0) || null;
}

/**
 * When a ticket was done. ClickUp sets a close date for "complete"; "done (this sprint)"
 * is not a closed status, so for it this is when it entered the status, when the system
 * saw that, else its last update.
 */
export function doneDate(task) {
  return task.dateClosed ?? (task.statusAge?.exact ? task.statusAge.since : null) ?? task.dateUpdated ?? null;
}

/** 10/27 */
export function shortDate(ms) {
  if (!ms) return "?";
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

const statusKey = (task) => String(task.status ?? "").toLowerCase();
const isDone = (task) => DONE_STATUSES.has(statusKey(task));

/** "DEV - All in 1 Bundle Page" and "[DEV] Gifts..." read better without the type prefix. */
export function cleanName(name) {
  return String(name ?? "")
    .replace(/^\s*\[(dev|design|qa)\]\s*/i, "")
    .replace(/^\s*(dev|design)\s*-\s*/i, "")
    .trim();
}

/**
 * One ticket as a line. Done: "✅ @Who – Title – done 10/27". Anything else:
 * "@Who – Status – Title – last update: 10/27". Who is whoever is doing the work (the
 * assignee), else the owner. `handleFor(user)` turns a ClickUp user into the @name.
 */
export function updateItem(task, handleFor) {
  const holders = task.assignees?.length ? task.assignees : task.taskOwners ?? [];
  const who = holders.map((u) => `@${handleFor(u)}`).join(" + ") || "@unassigned";
  const name = cleanName(task.name);
  if (isDone(task)) return `✅ ${who} – ${name} – done ${shortDate(doneDate(task))}`;
  const status = STATUS_LABEL[statusKey(task)] ?? task.status ?? "";
  return `${who} – ${status} – ${name} – last update: ${shortDate(lastActivity(task))}`;
}

/** Groups by Big Swing, A–Z with "No Big Swing" last, each list in `order`. */
function groupBySwing(tasks, order, handleFor) {
  const groups = new Map();
  for (const t of tasks) {
    const label = t.bigSwing?.label || "";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(t);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "") - (b === "") || a.localeCompare(b))
    .map(([label, list]) => ({
      label: label || "No Big Swing",
      tasks: list.sort(order).map((t) => ({ task: t, text: updateItem(t, handleFor) })),
    }));
}

/**
 * The daily update: tickets touched since `since` in one of UPDATE_STATUSES, furthest
 * along first. "complete" tickets never appear here, however recently they were touched.
 */
export function buildUpdate(tasks, { since, handleFor }) {
  const rank = (t) => UPDATE_STATUSES.indexOf(statusKey(t));
  const picked = (tasks ?? []).filter((t) => {
    if (t.archived || rank(t) < 0) return false;
    const at = lastActivity(t);
    return at != null && at >= since;
  });
  return groupBySwing(picked, (a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)), handleFor);
}

/**
 * Accomplishments: every ticket in "complete" or "done (this sprint)" whose done date is
 * on or after `since`, newest first inside each Big Swing.
 */
export function buildAccomplishments(tasks, { since, handleFor }) {
  const picked = (tasks ?? []).filter((t) => !t.archived && isDone(t) && (doneDate(t) ?? 0) >= since);
  return groupBySwing(picked, (a, b) => doneDate(b) - doneDate(a), handleFor);
}

/** The text to paste: **Big Swing**, then one ticket per line. */
export function groupsText(groups, excluded = new Set()) {
  return groups
    .map((g) => ({ label: g.label, items: g.tasks.filter((x) => !excluded.has(String(x.task.id))).map((x) => x.text) }))
    .filter((g) => g.items.length)
    .map((g) => [`**${g.label}**`, ...g.items].join("\n"))
    .join("\n\n");
}

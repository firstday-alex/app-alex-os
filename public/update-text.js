// The daily update, written from ClickUp.
//
// Every sprint ticket touched since the start of the previous working day (updated,
// closed, or commented on), grouped by its Big Swing, as one line per Big Swing that can
// be dropped straight into the update doc. Nothing here is invented: the line is the
// ticket's own name, who holds it, and its status. The emoji is read off keywords in the
// name, and a ticket with no keyword gets none.

// Statuses whose tickets belong in the update, in the order they are listed: furthest along first.
export const UPDATE_STATUSES = ["done", "ready for deploy", "vqa", "qa", "in review", "in-progress", "in progress", "to do"];

const STATUS_SUFFIX = {
  "to do": "(to do)",
  qa: "(in qa)",
  vqa: "(in vqa)",
  "in review": "(in review)",
  "ready for deploy": "(ready for deploy)",
};

// First match wins. Tested against the ticket name.
const KINDS = [
  { emoji: "🧪", re: /\b(a\/?b|test|testing)\b/i },
  { emoji: "🎨", re: /\b(design|designing|mock ?ups?|figma|creative|images?|videos?)\b/i },
  { emoji: "📊", re: /\b(report|dashboard|analysis|analytics|data|metrics)\b/i },
  { emoji: "👷", re: /\b(dev|develop|development|build|building|deploy|deployment|logic|code|implement)\b/i },
];

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

function statusKey(task) {
  return task.bucket === "done" ? "done" : String(task.status ?? "").toLowerCase();
}

/** "DEV - All in 1 Bundle Page" and "[DEV] Gifts..." read better without the type prefix. */
export function cleanName(name) {
  return String(name ?? "")
    .replace(/^\s*\[(dev|design|qa)\]\s*/i, "")
    .replace(/^\s*(dev|design)\s*-\s*/i, "")
    .trim();
}

export function kindEmoji(name) {
  return KINDS.find((k) => k.re.test(name ?? ""))?.emoji ?? "";
}

/**
 * One ticket as update text: emoji, @who, name, status.
 * `handleFor(user)` turns a ClickUp user into the @name; the default is their first name.
 */
export function updateItem(task, handleFor) {
  const who = (task.taskOwners?.length ? task.taskOwners : task.assignees ?? []).map((u) => `@${handleFor(u)}`).join(" + ");
  const key = statusKey(task);
  const emoji = key === "done" ? "✅" : kindEmoji(task.name);
  const suffix = key === "done" ? "(done)" : STATUS_SUFFIX[key] ?? "";
  return [emoji, who, cleanName(task.name), suffix].filter(Boolean).join(" ");
}

/**
 * The tickets for the update, grouped by Big Swing. Groups are A–Z with "No Big Swing"
 * last; inside a group, furthest along first.
 */
export function buildUpdate(tasks, { since, handleFor }) {
  const rank = (t) => {
    const i = UPDATE_STATUSES.indexOf(statusKey(t));
    return i < 0 ? UPDATE_STATUSES.length : i;
  };
  const picked = (tasks ?? []).filter((t) => {
    if (t.archived) return false;
    const key = statusKey(t);
    if (!UPDATE_STATUSES.includes(key)) return false;
    // A done ticket counts by when it closed; anything else by its last activity.
    const at = key === "done" ? t.dateClosed : lastActivity(t);
    return at != null && at >= since;
  });

  const groups = new Map();
  for (const t of picked) {
    const label = t.bigSwing?.label || "";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(t);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "") - (b === "") || a.localeCompare(b))
    .map(([label, list]) => ({
      label: label || "No Big Swing",
      tasks: list
        .sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)))
        .map((t) => ({ task: t, text: updateItem(t, handleFor) })),
    }));
}

/** The text to paste: the Big Swing, then "Update:" and its items on one line. */
export function updateText(groups, excluded = new Set()) {
  return groups
    .map((g) => ({ label: g.label, items: g.tasks.filter((x) => !excluded.has(String(x.task.id))).map((x) => x.text) }))
    .filter((g) => g.items.length)
    .map((g) => `${g.label}\nUpdate: ${g.items.join(" ")}`)
    .join("\n\n");
}

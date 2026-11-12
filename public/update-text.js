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
  // A parked ticket's marker, "[Waiting for Test Slot]", is a note to the dashboard, not part of the title.
  const name = cleanName(task.plainName ?? task.name);
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

/* ------------------------------ last week's wins ------------------------------
   The "complete" tickets (last sprint's work, moved there at rollover), summarised by
   the ClickUp ROCK field (field f9135883, `bigSwing` in code: it was named Big Swing
   until it was renamed in ClickUp), then kudos by person. Every line is a ticket ClickUp holds; nothing is
   written by a model. */

const NO_ROCK = "No rock";
const who = (task) => (task.assignees?.length ? task.assignees : task.taskOwners ?? []);

/** A name list as people say it: "A", "A and B", "A, B and C". */
export function listed(items) {
  const xs = [...items];
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

export function buildLastWeekWins(tasks, { handleFor }) {
  const done = (tasks ?? []).filter((t) => !t.archived && statusKey(t) === "complete");
  const dates = done.map(doneDate).filter(Boolean);

  const rocks = new Map();
  const people = new Map();
  for (const t of done) {
    const rock = t.bigSwing?.label || NO_ROCK;
    if (!rocks.has(rock)) rocks.set(rock, { label: rock, tasks: [], people: new Set() });
    const r = rocks.get(rock);
    r.tasks.push(t);
    for (const u of who(t)) {
      const handle = handleFor(u);
      r.people.add(handle);
      if (!people.has(handle)) people.set(handle, { who: handle, tasks: [], rocks: new Set() });
      people.get(handle).tasks.push(t);
      if (rock !== NO_ROCK) people.get(handle).rocks.add(rock);
    }
  }

  const byDone = (a, b) => (doneDate(b) ?? 0) - (doneDate(a) ?? 0);
  return {
    count: done.length,
    from: dates.length ? Math.min(...dates) : null,
    to: dates.length ? Math.max(...dates) : null,
    // Most wins first; "No rock" last, because work that ladders to nothing is the footnote.
    rocks: [...rocks.values()]
      .sort((a, b) => (a.label === NO_ROCK) - (b.label === NO_ROCK) || b.tasks.length - a.tasks.length || a.label.localeCompare(b.label))
      .map((r) => ({ label: r.label, people: [...r.people], tasks: r.tasks.sort(byDone) })),
    kudos: [...people.values()]
      .sort((a, b) => b.tasks.length - a.tasks.length || a.who.localeCompare(b.who))
      .map((p) => ({ who: p.who, rocks: [...p.rocks], tasks: p.tasks.sort(byDone) })),
  };
}

/** "Bundles 2.0: Bundle page; Checkout fix; Gift box". Plain text, so it pastes anywhere. */
export function rockLine(r, excluded = new Set()) {
  const tasks = r.tasks.filter((t) => !excluded.has(String(t.id)));
  if (!tasks.length) return null;
  return `${r.label}: ${tasks.map((t) => cleanName(t.plainName ?? t.name)).join("; ")}`;
}

/** "🙌 Robson (Bundles 2.0): Bundle page, Gift box". */
export function kudosLine(p, excluded = new Set()) {
  const tasks = p.tasks.filter((t) => !excluded.has(String(t.id)));
  if (!tasks.length) return null;
  const across = p.rocks.length ? ` (${p.rocks.join(", ")})` : "";
  return `🙌 ${p.who}${across}: ${tasks.map((t) => cleanName(t.plainName ?? t.name)).join(", ")}`;
}

export function lastWeekText(wins, excluded = new Set()) {
  const rocks = wins.rocks.map((r) => rockLine(r, excluded)).filter(Boolean);
  const kudos = wins.kudos.map((p) => kudosLine(p, excluded)).filter(Boolean);
  return [rocks.length ? ["Last week's wins, by rock", ...rocks].join("\n") : "", kudos.length ? ["Kudos", ...kudos].join("\n") : ""]
    .filter(Boolean)
    .join("\n\n");
}

/** The text to paste: **Big Swing**, then one ticket per line. */
export function groupsText(groups, excluded = new Set()) {
  return groups
    .map((g) => ({ label: g.label, items: g.tasks.filter((x) => !excluded.has(String(x.task.id))).map((x) => x.text) }))
    .filter((g) => g.items.length)
    .map((g) => [`**${g.label}**`, ...g.items].join("\n"))
    .join("\n\n");
}

/* ------------------------------ update + stand-up ------------------------------
   The same update, with what each person said in stand-up. A stand-up line goes under a
   ticket only when it clearly names that ticket and the ticket is the poster's (assignee
   or owner, or nobody's); a ticket someone mentions is pulled in even if ClickUp was not touched; the
   rest goes under "Also from stand-up". No model: word overlap, shown so it can be
   checked. */

const STOP = new Set(
  ("the and for with from into onto this that then than now all not our its are was were has have had will " +
    "fix fixes fixed update updates updated new page test tests testing done live ready deploy today yesterday " +
    "work working finish finished continue review build ship shipped pass second first feedback ideas iteration " +
    "add adding more meeting meetings sync monitor check start started wrap wrapped make making get got set via " +
    "dev design qa vqa per out off can could should need needs")
    .split(" "),
);

/** The words of a phrase that can tell one ticket from another. */
export function matchWords(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .split(/[^a-z0-9]+/)
    .map(singular)
    .filter((w) => w && !STOP.has(w) && (w.length >= 3 || /\d/.test(w)) && !/^\d+$/.test(w));
}

/** Good enough plurals for ticket names: boxes, carts, stories, upsells. */
function singular(w) {
  if (w.length <= 3) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + "y";
  if (/(xes|ches|shes|sses)$/.test(w)) return w.slice(0, -2);
  if (/[^s]s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Initials of each run of 3 or 4 words in a ticket name: "Family Bundle Builder V4" gives "fbb", "fbbv", "bbv". */
function acronyms(name) {
  const w = String(name ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out = new Set();
  for (let n = 3; n <= 4; n++) for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).map((x) => x[0]).join(""));
  return out;
}

/**
 * How often each word appears across ticket names. A word on many tickets ("checkout",
 * "cart") says little about which one a line means.
 */
export function wordCounts(tasks) {
  const counts = new Map();
  for (const t of tasks) for (const w of new Set(matchWords(cleanName(t.name)))) counts.set(w, (counts.get(w) ?? 0) + 1);
  return counts;
}

/**
 * How strongly a stand-up line names a ticket: a point per shared word (half a point for
 * a word on 3 or more tickets), two for an acronym of the ticket's name. 1.5 is a match:
 * one telling word and one common one ("checkout workshop"), never two common ones
 * ("cart/checkout").
 */
export function matchScore(line, task, counts = new Map()) {
  const words = new Set(matchWords(cleanName(task.name)));
  const acr = acronyms(cleanName(task.name));
  let score = 0;
  for (const w of new Set(matchWords(line))) {
    if (words.has(w)) score += (counts.get(w) ?? 1) >= 3 ? 0.5 : 1;
    else if (w.length >= 3 && acr.has(w)) score += 2;
  }
  return score;
}

const MATCH_AT = 1.5;

/** The ticket a phrase names among `tasks`, or null when none clearly does or two tie. */
function bestTicket(phrase, tasks, counts) {
  const scored = tasks.map((t) => ({ t, score: matchScore(phrase, t, counts) })).filter((x) => x.score >= MATCH_AT).sort((a, b) => b.score - a.score);
  return scored.length && (scored.length === 1 || scored[0].score > scored[1].score) ? scored[0].t : null;
}

const firstOf = (name) => String(name ?? "").trim().split(/\s+/)[0].toLowerCase();
// A ticket is someone's to talk about when they are on it, or when nobody is.
const isTheirs = (task, person) => {
  const on = [...(task.assignees ?? []), ...(task.taskOwners ?? [])];
  return !on.length || on.some((u) => firstOf(u.username) === firstOf(person));
};

/** Each person's latest stand-up posted at or after `since`. */
export function latestPosts(standupDays, since) {
  const latest = new Map();
  for (const day of standupDays ?? []) {
    for (const p of day.posts ?? []) {
      if (p.postedAt < since) continue;
      const prior = latest.get(p.name);
      if (!prior || prior.postedAt < p.postedAt) latest.set(p.name, p);
    }
  }
  return [...latest.values()].sort((a, b) => a.postedAt - b.postedAt);
}

const SECTIONS = [
  ["yesterday", "Yesterday"],
  ["today", "Today"],
];

/**
 * The update with stand-up context. Returns the Big Swing groups (each ticket line with
 * its stand-up notes), the stand-up lines that matched no ticket, and the blockers.
 */
export function buildStandupUpdate(tasks, standupDays, { since, handleFor }) {
  const posts = latestPosts(standupDays, since);
  const candidates = (tasks ?? []).filter((t) => !t.archived && UPDATE_STATUSES.includes(statusKey(t)));
  const touched = new Set(buildUpdate(tasks, { since, handleFor }).flatMap((g) => g.tasks.map((x) => String(x.task.id))));
  const counts = wordCounts(candidates);
  const notes = new Map();
  const extra = [];
  const blockers = [];

  for (const post of posts) {
    const theirs = candidates.filter((t) => isTheirs(t, post.name));
    for (const [key, label] of SECTIONS) {
      for (const line of post[key] ?? []) {
        // "family box builder + home hero cta + 90d upsell" is three pieces of work. Each
        // piece is matched on its own, and the line goes under every ticket one names.
        const hits = new Set(
          line
            .split(/\s+\+\s+/)
            .map((part) => bestTicket(part, theirs, counts))
            .filter(Boolean)
            .map((t) => String(t.id)),
        );
        if (!hits.size) extra.push({ who: post.name, section: label, text: line });
        for (const id of hits) {
          if (!notes.has(id)) notes.set(id, []);
          notes.get(id).push({ who: post.name, section: label, text: line });
        }
      }
    }
    for (const line of post.blockers ?? []) blockers.push({ who: post.name, text: line });
  }

  // The update's tickets, plus any ticket a stand-up named that ClickUp shows untouched.
  const picked = candidates.filter((t) => touched.has(String(t.id)) || notes.has(String(t.id)));
  const rank = (t) => UPDATE_STATUSES.indexOf(statusKey(t));
  const groups = groupBySwing(picked, (a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)), handleFor).map((g) => ({
    ...g,
    tasks: g.tasks.map((x) => ({ ...x, notes: notes.get(String(x.task.id)) ?? [], fromStandup: !touched.has(String(x.task.id)) })),
  }));
  return { groups, extra, blockers, posts };
}

/** The text to paste. `excluded` holds ticket ids and "extra:i" / "blocker:i" keys. */
export function standupUpdateText({ groups, extra, blockers }, handleFor, excluded = new Set()) {
  const at = (name) => `@${handleFor({ username: name })}`;
  const parts = groups
    .map((g) => ({
      label: g.label,
      lines: g.tasks
        .filter((x) => !excluded.has(String(x.task.id)))
        .flatMap((x) => [x.text, ...x.notes.map((n) => `    ↳ ${n.section}: ${n.text}`)]),
    }))
    .filter((g) => g.lines.length)
    .map((g) => [`**${g.label}**`, ...g.lines].join("\n"));
  const extraLines = extra.map((e, i) => [e, i]).filter(([, i]) => !excluded.has(`extra:${i}`)).map(([e]) => `${at(e.who)} – ${e.section}: ${e.text}`);
  if (extraLines.length) parts.push(["**Also from stand-up**", ...extraLines].join("\n"));
  const blockerLines = blockers.map((b, i) => [b, i]).filter(([, i]) => !excluded.has(`blocker:${i}`)).map(([b]) => `${at(b.who)} – ${b.text}`);
  if (blockerLines.length) parts.push(["**Blockers**", ...blockerLines].join("\n"));
  return parts.join("\n\n");
}

/* --------------------------- changes to production ---------------------------
   From the firstday.com changelog sheet, read into the report by the pipeline
   (src/collectors/changelog.js). Each line is the sheet's own row: date, change, details,
   and the test result and added monthly revenue when the row records them. */

/** "YYYY-MM-DD" for a time, in the browser's own day. */
export function localDateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The changelog entries dated on or after the day `since` falls on, newest first. */
export function buildChanges(changelog, { since }) {
  const from = localDateKey(since);
  return (changelog?.entries ?? []).filter((e) => e.date >= from);
}

/** "🚀 11/11 – Promoted New Homepage – details – Won + Promoted, +$39,711/mo" */
export function changeLine(e) {
  const [, m, d] = String(e.date).split("-");
  const revenue = e.monthlyRevenue != null ? `+$${Math.round(e.monthlyRevenue).toLocaleString("en-US")}/mo` : null;
  const result = [e.promoted, revenue].filter(Boolean).join(", ");
  return [`🚀 ${m}/${d}`, e.change, e.details, result || null].filter(Boolean).join(" – ");
}

/** The section to paste under the update. `excluded` holds "change:<row>" keys. */
export function changesText(changes, excluded = new Set()) {
  const lines = (changes ?? []).filter((e) => !excluded.has(`change:${e.row}`)).map(changeLine);
  return lines.length ? ["**Changes to production**", ...lines].join("\n") : "";
}


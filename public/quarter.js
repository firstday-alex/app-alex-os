// The quarter as a calendar: its three months, and the weeks inside each.
//
// A week runs Monday to Sunday and belongs to the month its Thursday falls in, so every
// week sits in exactly one month and a quarter has 13 or 14 of them (Q4 2026: the week
// of Mon 28 Sep holds Thu 1 Oct, so it is October's first week; the week of Mon 28 Dec
// holds Thu 31 Dec, so it is December's last).
//
// Shared by the dashboard (public/app.js) and the server (the rock course check and the
// plan store), so the planner and the flags agree on which week is which. Plain date-key
// arithmetic in UTC: a date key ("2026-11-17") has no time of day to drift.

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, "0");
const toKey = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const toMs = (key) => Date.parse(`${key}T00:00:00Z`);

/** "2026-Q4" for a date key. */
export function quarterOfKey(key) {
  const [y, m] = String(key).split("-").map(Number);
  return `${y}-Q${Math.ceil(m / 3)}`;
}

/** The quarter's months, as YYYY-MM. */
export function monthsOf(quarter) {
  const m = String(quarter ?? "").match(/^(\d{4})-Q([1-4])$/);
  if (!m) return [];
  const first = Number(m[2]) * 3 - 2;
  return [0, 1, 2].map((i) => `${m[1]}-${pad(first + i)}`);
}

/** The Monday of the week a date key falls in. */
export function weekStartOf(key) {
  const ms = toMs(key);
  const dow = new Date(ms).getUTCDay(); // 0 Sunday
  return toKey(ms - ((dow + 6) % 7) * DAY);
}

export const addDays = (key, n) => toKey(toMs(key) + n * DAY);

/** The month a week belongs to: the month of its Thursday. */
export const monthOfWeek = (start) => addDays(start, 3).slice(0, 7);

/**
 * The weeks of a quarter, in order: { start, end, month, n } with `start` the Monday,
 * `end` the Sunday and `n` counting from 1.
 */
export function quarterWeeks(quarter) {
  const months = monthsOf(quarter);
  if (!months.length) return [];
  const out = [];
  let start = weekStartOf(`${months[0]}-01`);
  if (!months.includes(monthOfWeek(start))) start = addDays(start, 7);
  while (months.includes(monthOfWeek(start))) {
    out.push({ start, end: addDays(start, 6), month: monthOfWeek(start), n: out.length + 1 });
    start = addDays(start, 7);
  }
  return out;
}

/** Days from one key to another; negative when `to` is earlier. */
export const daysFrom = (from, to) => Math.round((toMs(to) - toMs(from)) / DAY);

/** How far through its month a date key is, 0 to 1, counting the day itself as gone. */
export function monthShare(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d / days;
}

/** Days left in the month after this one. */
export function daysLeftInMonth(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate() - d;
}

/** "Nov 16" for a date key, without the browser's timezone moving it a day. */
export function shortDay(key) {
  return new Date(toMs(key)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "November" for YYYY-MM. */
export function monthName(month) {
  return new Date(toMs(`${month}-01`)).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
}

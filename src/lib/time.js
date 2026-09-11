// Central-time and working-day arithmetic.
//
// Two rules from the spec live in here and nowhere else:
//   1. The readout runs 8:00 AM Central, Monday through Friday. Cron is UTC and Central
//      shifts with daylight saving, so the schedule fires twice and this module decides.
//   2. The baseline is always the previous WORKING day's 8 AM snapshot. Monday's baseline
//      is Friday's, not Sunday's. It does not float during the day.
//
// Uses Intl with an explicit timeZone rather than offset math, so DST is handled by the
// platform's tz database instead of by us.

const DEFAULT_TZ = "America/Chicago";

const partsFormatterCache = new Map();
function partsFormatter(timeZone) {
  let fmt = partsFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    partsFormatterCache.set(timeZone, fmt);
  }
  return fmt;
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts in the given zone. `hour` is 0-23, `weekday` is 0 (Sun) to 6 (Sat). */
export function zonedParts(date = new Date(), timeZone = DEFAULT_TZ) {
  const map = {};
  for (const part of partsFormatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  // Intl renders midnight as "24" in some ICU versions.
  const hour = Number(map.hour) % 24;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: WEEKDAY_INDEX[map.weekday],
    weekdayName: map.weekday,
    dateKey: `${map.year}-${map.month}-${map.day}`,
    timeKey: `${String(hour).padStart(2, "0")}-${map.minute}`,
  };
}

/** "2026-09-10" for the wall-clock date in the zone. */
export function dateKey(date = new Date(), timeZone = DEFAULT_TZ) {
  return zonedParts(date, timeZone).dateKey;
}

export function hourIn(date = new Date(), timeZone = DEFAULT_TZ) {
  return zonedParts(date, timeZone).hour;
}

/** A date key's weekday, 0 (Sun) to 6 (Sat). Pure string math, no zone needed. */
export function weekdayOfKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isWorkingDayKey(key, workingWeekdays = [1, 2, 3, 4, 5]) {
  return workingWeekdays.includes(weekdayOfKey(key));
}

export function shiftDateKey(key, days) {
  const [y, m, d] = key.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * The working day before `key`. Tuesday gives Monday. Monday gives Friday.
 * Walks back day by day so a holiday list could be added to workingWeekdays logic later.
 */
export function previousWorkingDayKey(key, workingWeekdays = [1, 2, 3, 4, 5]) {
  let cursor = shiftDateKey(key, -1);
  for (let i = 0; i < 14; i += 1) {
    if (isWorkingDayKey(cursor, workingWeekdays)) return cursor;
    cursor = shiftDateKey(cursor, -1);
  }
  throw new Error(`previousWorkingDayKey: no working day within 14 days before ${key}`);
}

/**
 * Should the scheduled function hand off to the pipeline right now?
 * The cron fires at 13:00 and 14:00 UTC year round; exactly one of those is 8 AM Central.
 */
export function shouldRunScheduled(now = new Date(), config) {
  const timeZone = config?.system?.timezone ?? DEFAULT_TZ;
  const targetHour = config?.system?.schedule?.readoutHourCentral ?? 8;
  const workingWeekdays = config?.system?.schedule?.workingWeekdays ?? [1, 2, 3, 4, 5];
  const parts = zonedParts(now, timeZone);

  if (!workingWeekdays.includes(parts.weekday)) {
    return { run: false, reason: `${parts.weekdayName} is not a working day`, parts };
  }
  if (parts.hour !== targetHour) {
    return { run: false, reason: `Central hour is ${parts.hour}, target is ${targetHour}`, parts };
  }
  return { run: true, reason: `${parts.weekdayName} ${parts.hour}:00 Central`, parts };
}

/**
 * Which date's official 8 AM snapshot is the baseline, given "now".
 *
 * Pinned, not floating: at 8 AM and at 2 PM on the same working day this returns the same
 * answer, so a mid-day dashboard refresh is a live preview of what tomorrow's 8 AM readout
 * would say. Returns candidate keys newest-first; the storage layer picks the first that
 * actually has an official snapshot.
 */
export function baselineCandidateKeys(now = new Date(), config) {
  const timeZone = config?.system?.timezone ?? DEFAULT_TZ;
  const workingWeekdays = config?.system?.schedule?.workingWeekdays ?? [1, 2, 3, 4, 5];
  const lookback = config?.system?.storage?.baselineLookbackWorkingDays ?? 10;
  const today = dateKey(now, timeZone);

  const keys = [];
  let cursor = today;
  for (let i = 0; i < lookback; i += 1) {
    cursor = previousWorkingDayKey(cursor, workingWeekdays);
    keys.push(cursor);
  }
  return { today, candidates: keys };
}

export function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return Math.floor((to.getTime() - from.getTime()) / 86400000);
}

export { DEFAULT_TZ };

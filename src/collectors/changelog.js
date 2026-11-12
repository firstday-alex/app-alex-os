// The site changelog: what changed on firstday.com in production. Read from the team's
// Google Sheet (system.changelog): every tab with a Date and a Change column, such as the
// one the Slack "changelog" workflow appends to (Date, Change, Details, URL, Test Link,
// Test Promoted, Additional Monthly Revenue) and the older day-by-day site_changelog.
//
// Deterministic and read only (spreadsheets.readonly). Read by the pipeline into the
// report, so the Update on the Write-ups tab carries "Changes to production", and read
// live by the Daily Speech so a change logged after 8 AM still makes the speech.
//
// Columns are found by their header, not their position, so a column added or moved in
// the sheet does not shift what is read. Screenshots are left out: they are Slack file
// links, and their paths carry Slack user ids.

import { httpJson } from "../lib/http.js";
import { googleAccessToken, serviceAccountFrom } from "../lib/google.js";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const DETAIL_CHARS = 280;

export const CHANGELOG_SETUP =
  "Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY in Netlify, and share the changelog sheet with that email as a Viewer.";

/* ------------------------------------------------------------------ parsing */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");
const keyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const validDay = (y, m, d) => y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;

/** Hours and minutes from "3:09:00 PM", "15:09" or null. */
function clock(text) {
  const m = String(text ?? "").match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return h < 24 ? `${pad(h)}:${m[2]}` : null;
}

/**
 * A sheet cell as a date, in the sheet's own clock: { date: "2026-07-07", time: "15:09" }.
 * Takes a Sheets serial number (days since 1899-12-30, the unformatted value of a date
 * cell) or text: "7/7/2026", "Jul 7, 2026, 3:09:00 PM", "2026-07-07". Anything else is null.
 */
export function parseSheetDate(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 20000 && value < 80000) {
    const days = Math.floor(value);
    const d = new Date(Date.UTC(1899, 11, 30) + days * 86_400_000);
    const minutes = Math.round((value - days) * 1440);
    const time = minutes > 0 && minutes < 1440 ? `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}` : null;
    return { date: keyOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), time };
  }
  const s = String(value ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m && validDay(+m[1], +m[2], +m[3])) return { date: keyOf(+m[1], +m[2], +m[3]), time: clock(s.slice(10)) };
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (validDay(y, +m[1], +m[2])) return { date: keyOf(y, +m[1], +m[2]), time: clock(s.slice(m[0].length)) };
  }
  m = s.match(/^(?:[a-z]{3,9},?\s+)?([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i);
  if (m && MONTHS[m[1].toLowerCase()] && validDay(+m[3], MONTHS[m[1].toLowerCase()], +m[2])) {
    return { date: keyOf(+m[3], MONTHS[m[1].toLowerCase()], +m[2]), time: clock(s.slice(m[0].length)) };
  }
  return null;
}

const COLUMNS = [
  ["date", (h) => /^date\b/.test(h)],
  ["change", (h) => /^change\b/.test(h)],
  ["details", (h) => /^details?\b/.test(h)],
  ["testLink", (h) => /test\s*link/.test(h)],
  ["url", (h) => /\burl\b/.test(h) && !/test/.test(h)],
  ["promoted", (h) => /promoted/.test(h)],
  ["monthlyRevenue", (h) => /revenue/.test(h)],
  ["deck", (h) => /deck/.test(h)],
];

const text = (v) => (v == null ? "" : String(v).replace(/\s*\n+\s*/g, "; ").replace(/\s+/g, " ").trim());
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** A revenue cell as a number of dollars, or null. 39711, "$39,711", "39.7k". */
export function money(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const m = String(value ?? "").replace(/[$,\s]/g, "").match(/^(-?\d+(?:\.\d+)?)(k)?$/i);
  return m ? Number(m[1]) * (m[2] ? 1000 : 1) : null;
}

/**
 * The sheet's rows as changelog entries, newest first. Pure. The header row is the first
 * row with a "Date" cell; the change is the "Change" column, or for a sheet without one,
 * the first unnamed column after Date. A row without a date or a change is skipped.
 */
export function parseChangelog(rows) {
  const headerAt = (rows ?? []).findIndex((r) => (r ?? []).some((c) => /^date\b/i.test(String(c ?? "").trim())));
  if (headerAt < 0) throw new Error('The changelog tab has no header row with a "Date" column.');
  const header = rows[headerAt].map((c) => String(c ?? "").trim().toLowerCase());
  const col = {};
  for (const [name, test] of COLUMNS) {
    const i = header.findIndex(test);
    if (i >= 0 && !Object.values(col).includes(i)) col[name] = i;
  }
  if (col.change == null) {
    const i = header.findIndex((h, idx) => idx > col.date && h === "");
    if (i >= 0) col.change = i;
  }
  if (col.change == null) throw new Error('The changelog tab has no "Change" column.');

  const entries = [];
  rows.slice(headerAt + 1).forEach((row, i) => {
    const when = parseSheetDate(row?.[col.date]);
    const change = text(row?.[col.change]);
    if (!when || !change) return;
    const get = (name) => (col[name] == null ? "" : text(row?.[col[name]]));
    entries.push({
      row: headerAt + i + 2,
      date: when.date,
      time: when.time,
      change,
      details: clip(get("details"), DETAIL_CHARS) || null,
      url: get("url") || null,
      testLink: /^https?:\/\//.test(get("testLink")) ? get("testLink") : null,
      promoted: get("promoted") || null,
      monthlyRevenue: col.monthlyRevenue == null ? null : money(row?.[col.monthlyRevenue]),
      deck: /^https?:\/\//.test(get("deck")) ? get("deck") : null,
    });
  });
  return entries.sort((a, b) => `${b.date} ${b.time ?? ""}`.localeCompare(`${a.date} ${a.time ?? ""}`) || b.row - a.row);
}

/** The entries on or after a date key, newest first. */
export function changesSince(entries, sinceKey) {
  return (entries ?? []).filter((e) => e.date >= sinceKey);
}

/** A change as the Daily Speech sees it: no links, nothing it could not say out loud. */
export function changeForSpeech(e) {
  return {
    date: e.date,
    change: e.change,
    details: e.details ?? undefined,
    page: e.url ?? undefined,
    abTested: e.testLink ? true : undefined,
    result: e.promoted ?? undefined,
    additionalMonthlyRevenue: e.monthlyRevenue ?? undefined,
  };
}

/* -------------------------------------------------------------------- fetch */

export function changelogConfigured(config, env = process.env) {
  return Boolean(config.system?.changelog?.spreadsheetId) && Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL || env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

/**
 * Reads the sheet and returns the entries in the lookback window, newest first. With
 * system.changelog.gid set, only that tab (the number after #gid= in its URL); without,
 * every tab that reads as a changelog, merged.
 */
export async function collectChangelog({ config, env = process.env, fetchImpl, sleep, logger, now = new Date() }) {
  const cfg = config.system?.changelog ?? {};
  if (!cfg.spreadsheetId) throw new Error("system.changelog.spreadsheetId is not set.");
  const account = serviceAccountFrom(env);
  if (!account) throw new Error(`No Google service account. ${CHANGELOG_SETUP}`);

  const token = await googleAccessToken({ account, fetchImpl, sleep, logger });
  const headers = { authorization: `Bearer ${token}` };
  const call = (url, label) =>
    httpJson(url, { headers, label, maxAttempts: 3, fetchImpl, sleep, logger }).catch((err) => {
      if (err.status === 403 || err.status === 404) {
        throw new Error(`The changelog sheet could not be opened (HTTP ${err.status}). Share it with ${account.email} as a Viewer.`);
      }
      throw err;
    });

  const meta = await call(`${SHEETS}/${encodeURIComponent(cfg.spreadsheetId)}?fields=properties.title,sheets.properties(sheetId,title)`, "sheets.meta");
  const tabs = (meta.body?.sheets ?? []).map((s) => s.properties);
  // With a gid, that one tab. Without, every tab that reads as a changelog (a Date column
  // and a change column); the others (test lists, backlog, scratch) are passed over.
  const wanted = cfg.gid != null ? tabs.filter((t) => String(t.sheetId) === String(cfg.gid)) : tabs;
  if (!wanted.length) throw new Error(`The changelog sheet has no tab with gid ${cfg.gid}. Tabs: ${tabs.map((t) => t.title).join(", ")}.`);

  const ranges = wanted.map((t) => `ranges=${encodeURIComponent(`'${t.title.replace(/'/g, "''")}'`)}`).join("&");
  const batch = await call(
    `${SHEETS}/${encodeURIComponent(cfg.spreadsheetId)}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
    "sheets.values",
  );
  const read = [];
  const seen = new Set();
  const all = [];
  (batch.body?.valueRanges ?? []).forEach((vr, i) => {
    const tab = wanted[i];
    let parsed;
    try {
      parsed = parseChangelog(vr.values ?? []);
    } catch (err) {
      if (cfg.gid != null) throw err;
      return;
    }
    read.push(tab);
    for (const e of parsed) {
      // The same change logged in two tabs on the same day is one change.
      const same = `${e.date}|${e.change.toLowerCase()}`;
      if (seen.has(same)) continue;
      seen.add(same);
      all.push({ ...e, row: `${tab.sheetId}:${e.row}`, tab: tab.title });
    }
  });
  if (!read.length) throw new Error(`No tab in the changelog sheet has a Date and a Change column. Tabs: ${tabs.map((t) => t.title).join(", ")}.`);
  all.sort((a, b) => `${b.date} ${b.time ?? ""}`.localeCompare(`${a.date} ${a.time ?? ""}`));

  const lookback = cfg.lookbackDays ?? 14;
  const tz = config.system?.timezone ?? "America/Chicago";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - lookback * 86_400_000).toISOString().slice(0, 10);
  const entries = all.filter((e) => e.date >= since && e.date <= today);

  logger?.info?.("changelog.read", { tabs: read.map((t) => t.title), rows: all.length, inWindow: entries.length });
  return {
    takenAt: now.toISOString(),
    sheet: {
      title: meta.body?.properties?.title ?? null,
      tab: read.map((t) => t.title).join(" + "),
      url: `https://docs.google.com/spreadsheets/d/${cfg.spreadsheetId}/edit${read.length === 1 ? `#gid=${read[0].sheetId}` : ""}`,
    },
    since,
    latest: all[0]?.date ?? null,
    entries,
  };
}

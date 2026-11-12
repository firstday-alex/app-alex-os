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
  'List the tabs in system.changelog.tabs and share the sheet as "anyone with the link can view", or set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY and share the sheet with that email.';

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

/** RFC 4180 CSV, as Google's export writes it: quoted fields, "" for a quote, newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const t = String(text ?? "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n") row.push(field), rows.push(row), (row = []), (field = "");
    else if (c !== "\r") field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows;
}

/**
 * Ready to read: a spreadsheet id, and either tabs to read from the public export or a
 * service account for a sheet that is not public.
 */
export function changelogConfigured(config, env = process.env) {
  const cfg = config.system?.changelog ?? {};
  return Boolean(cfg.spreadsheetId) && Boolean(cfg.tabs?.length || env.GOOGLE_SERVICE_ACCOUNT_EMAIL || env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

/**
 * The public way: each tab in system.changelog.tabs as CSV from Google's export link. No
 * credentials, so it only works while the sheet is shared as "anyone with the link can
 * view". A sheet that is not shows Google's sign-in page instead of CSV, and that is said.
 */
async function readPublicTabs(cfg, { fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), logger }) {
  const out = [];
  for (const tab of cfg.tabs) {
    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(cfg.spreadsheetId)}/export?format=csv&gid=${encodeURIComponent(tab.gid)}`;
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(30000) });
        logger?.apiCall?.({ label: "sheets.export", method: "GET", status: res.status, attempt });
        if (res.status < 500 && res.status !== 429) break;
      } catch (err) {
        if (attempt >= 3) throw new Error(`The changelog tab ${tab.name ?? tab.gid} could not be read: ${err.message}`);
      }
      if (attempt >= 3) break;
      await sleep(1000 * attempt);
    }
    const type = res.headers?.get?.("content-type") ?? "";
    if (!res.ok || !type.includes("text/csv")) {
      throw new Error(
        `The changelog tab ${tab.name ?? tab.gid} is not readable from its public link (HTTP ${res.status}). Share the sheet as "anyone with the link can view", or set up a service account (docs/DEPLOY.md).`,
      );
    }
    out.push({ sheetId: tab.gid, title: tab.name ?? `gid ${tab.gid}`, values: parseCsv(await res.text()) });
  }
  return { title: cfg.title ?? null, tabs: out };
}

/** The private way: the Sheets API as a service account, every tab or the configured ones. */
async function readTabsAsServiceAccount(cfg, account, { fetchImpl, sleep, logger }) {
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
  const all = (meta.body?.sheets ?? []).map((s) => s.properties);
  const gids = cfg.tabs?.length ? cfg.tabs.map((t) => String(t.gid)) : null;
  const wanted = gids ? all.filter((t) => gids.includes(String(t.sheetId))) : all;
  if (!wanted.length) throw new Error(`The changelog sheet has none of the configured tabs. Tabs: ${all.map((t) => t.title).join(", ")}.`);

  const ranges = wanted.map((t) => `ranges=${encodeURIComponent(`'${t.title.replace(/'/g, "''")}'`)}`).join("&");
  const batch = await call(
    `${SHEETS}/${encodeURIComponent(cfg.spreadsheetId)}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
    "sheets.values",
  );
  return {
    title: meta.body?.properties?.title ?? null,
    tabs: wanted.map((t, i) => ({ sheetId: t.sheetId, title: t.title, values: batch.body?.valueRanges?.[i]?.values ?? [] })),
  };
}

/**
 * Reads the sheet and returns the entries in the lookback window, newest first, merged
 * across every tab read that has a Date and a Change column; the rest are passed over.
 * With a service account set it uses the Sheets API (and with no tabs configured reads
 * every tab); otherwise the public CSV export of each tab in system.changelog.tabs.
 */
export async function collectChangelog({ config, env = process.env, fetchImpl, sleep, logger, now = new Date() }) {
  const cfg = config.system?.changelog ?? {};
  if (!cfg.spreadsheetId) throw new Error("system.changelog.spreadsheetId is not set.");
  const account = serviceAccountFrom(env);
  if (!account && !cfg.tabs?.length) throw new Error(`No tabs configured and no Google service account. ${CHANGELOG_SETUP}`);
  const sheet = account ? await readTabsAsServiceAccount(cfg, account, { fetchImpl, sleep, logger }) : await readPublicTabs(cfg, { fetchImpl, sleep, logger });

  const read = [];
  const seen = new Set();
  const all = [];
  for (const tab of sheet.tabs) {
    let parsed;
    try {
      parsed = parseChangelog(tab.values);
    } catch {
      continue;
    }
    read.push(tab);
    for (const e of parsed) {
      // The same change logged in two tabs on the same day is one change.
      const same = `${e.date}|${e.change.toLowerCase()}`;
      if (seen.has(same)) continue;
      seen.add(same);
      all.push({ ...e, row: `${tab.sheetId}:${e.row}`, tab: tab.title });
    }
  }
  if (!read.length) throw new Error(`No changelog tab read has a Date and a Change column. Tabs read: ${sheet.tabs.map((t) => t.title).join(", ")}.`);
  all.sort((a, b) => `${b.date} ${b.time ?? ""}`.localeCompare(`${a.date} ${a.time ?? ""}`));

  const lookback = cfg.lookbackDays ?? 14;
  const tz = config.system?.timezone ?? "America/Chicago";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - lookback * 86_400_000).toISOString().slice(0, 10);
  const entries = all.filter((e) => e.date >= since && e.date <= today);

  logger?.info?.("changelog.read", { via: account ? "service_account" : "public_link", tabs: read.map((t) => t.title), rows: all.length, inWindow: entries.length });
  return {
    takenAt: now.toISOString(),
    sheet: {
      title: sheet.title,
      tab: read.map((t) => t.title).join(" + "),
      url: `https://docs.google.com/spreadsheets/d/${cfg.spreadsheetId}/edit${read.length === 1 ? `#gid=${read[0].sheetId}` : ""}`,
    },
    since,
    latest: all[0]?.date ?? null,
    entries,
  };
}

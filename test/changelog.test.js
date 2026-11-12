// The site changelog: read from the sheet by header, dated in the sheet's own clock, and
// folded into the Update and the Daily Speech exactly as the rows say.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { parseSheetDate, parseChangelog, parseCsv, changesSince, money, changeForSpeech, collectChangelog, changelogConfigured } from "../src/collectors/changelog.js";
import { signedJwt, serviceAccountFrom, clearGoogleTokenCache } from "../src/lib/google.js";
import { buildChanges, changeLine, changesText } from "../public/update-text.js";
import { changesForSpeech } from "../src/agents/daily-speech.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const env = { GOOGLE_SERVICE_ACCOUNT_EMAIL: "reader@example.iam.gserviceaccount.com", GOOGLE_PRIVATE_KEY: pem.replace(/\n/g, "\\n") };

const HEADER = ["Date", "Change", "Details", "Screenshot", "url of change if applicable", "Test Link", "Test Promoted", "Additional Monthly Revenue", "Link To CRO Deck"];
// 46161 is 2026-05-19 as a Sheets serial; .6 of a day is 14:24.
const ROWS = [
  HEADER,
  ["Jul 7, 2026, 3:09:00 PM", "Activated Sticky Anchor Test On LPs", "running on pages with -lp", "https://firstdayteam.slack.com/files/U050/F0/shot.png", "", "https://app.intelligems.io/experiment/761b", "", "", ""],
  [46239.6, "Growth Angle V2 Copy TDK BTS", "", "", "firstday.com/pages/tdk-behind-the-science-lp", "https://app.intelligems.io/experiment/666b", "Won + Promoted", 39711, ""],
  ["11/11/2026", "Promoted New Homepage", "line one\nline two", "", "firstday.com", "", "", "", ""],
  ["", "no date, skipped"],
  ["11/10/2026", ""],
];

test("sheet dates read in the sheet's own clock, whatever the cell holds", () => {
  assert.deepEqual(parseSheetDate(46161), { date: "2026-05-19", time: null });
  assert.deepEqual(parseSheetDate(46161.6), { date: "2026-05-19", time: "14:24" });
  assert.deepEqual(parseSheetDate("Jul 7, 2026, 3:09:00 PM"), { date: "2026-07-07", time: "15:09" });
  assert.deepEqual(parseSheetDate("2/14/2026"), { date: "2026-02-14", time: null });
  assert.deepEqual(parseSheetDate("2026-11-12"), { date: "2026-11-12", time: null });
  assert.equal(parseSheetDate("someday"), null);
  assert.equal(parseSheetDate(""), null);
});

test("rows are found by header, newest first, and screenshots never come through", () => {
  const entries = parseChangelog(ROWS);
  assert.deepEqual(entries.map((e) => e.change), ["Promoted New Homepage", "Growth Angle V2 Copy TDK BTS", "Activated Sticky Anchor Test On LPs"]);
  const [home, growth, anchor] = entries;
  assert.equal(home.details, "line one; line two");
  assert.equal(home.row, 4);
  assert.equal(growth.date, "2026-08-05");
  assert.equal(growth.promoted, "Won + Promoted");
  assert.equal(growth.monthlyRevenue, 39711);
  assert.equal(growth.url, "firstday.com/pages/tdk-behind-the-science-lp");
  assert.equal(anchor.testLink, "https://app.intelligems.io/experiment/761b");
  assert.ok(!JSON.stringify(entries).includes("slack.com"), "screenshot links carry Slack ids");
});

test("a sheet with no Change header takes the first unnamed column after Date", () => {
  const entries = parseChangelog([["Day", "Date", "", "", "", ""], ["Sat", "2/14/2026", "Demo switcher test launch", "", "", "RPV: +25%"], ["Sun", "2/15/2026", ""]]);
  assert.deepEqual(entries.map((e) => [e.date, e.change]), [["2026-02-14", "Demo switcher test launch"]]);
});

test("a tab without a Date header is an error that says so", () => {
  assert.throws(() => parseChangelog([["Change"], ["x"]]), /Date/);
});

test("money reads the ways people type it", () => {
  assert.equal(money(39711), 39711);
  assert.equal(money("$39,711"), 39711);
  assert.equal(money("39.7k"), 39700);
  assert.equal(money("tbd"), null);
});

test("the Update section: since the window's day, a line per row, untickable", () => {
  const entries = parseChangelog(ROWS);
  const changes = buildChanges({ entries }, { since: new Date(2026, 7, 5, 0, 0).getTime() });
  assert.equal(changes.length, 2);
  assert.equal(changeLine(changes[1]), "🚀 08/05 – Growth Angle V2 Copy TDK BTS – Won + Promoted, +$39,711/mo");
  assert.equal(changesText(changes), ["**Changes to production**", "🚀 11/11 – Promoted New Homepage – line one; line two", "🚀 08/05 – Growth Angle V2 Copy TDK BTS – Won + Promoted, +$39,711/mo"].join("\n"));
  assert.equal(changesText(changes, new Set(["change:4", "change:3"])), "");
  assert.deepEqual(changesSince(entries, "2026-11-01").map((e) => e.row), [4]);
});

test("the speech sees no links, only what it could say out loud", () => {
  const growth = parseChangelog(ROWS)[1];
  assert.deepEqual(changeForSpeech(growth), {
    date: "2026-08-05",
    change: "Growth Angle V2 Copy TDK BTS",
    details: undefined,
    page: "firstday.com/pages/tdk-behind-the-science-lp",
    abTested: true,
    result: "Won + Promoted",
    additionalMonthlyRevenue: 39711,
  });
});

test("the service account signs an RS256 assertion its public key verifies", () => {
  const account = serviceAccountFrom(env);
  assert.equal(account.email, env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  const jwt = signedJwt(account, "scope-x", Date.UTC(2026, 10, 12));
  const [h, c, sig] = jwt.split(".");
  const verify = createVerify("RSA-SHA256");
  verify.update(`${h}.${c}`);
  assert.ok(verify.verify(publicKey, Buffer.from(sig, "base64url")));
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  assert.equal(claims.scope, "scope-x");
  assert.equal(claims.exp - claims.iat, 3600);
  assert.equal(serviceAccountFrom({}), null);
  assert.equal(serviceAccountFrom({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "a@b", private_key: "k" }) }).email, "a@b");
});

const config = {
  system: { timezone: "America/Chicago", changelog: { spreadsheetId: "SHEET", tabs: [{ gid: 1384691948, name: "Web Changelog Flow" }], lookbackDays: 14 } },
};

function fakeGoogle({ valuesStatus = 200, rows = ROWS, tabs = [{ sheetId: 0, title: "site_changelog" }, { sheetId: 1384691948, title: "Web Changelog Flow" }] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const json = (status, body) => new Response(JSON.stringify(body), { status });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json(200, { access_token: "ya29.x", expires_in: 3600 });
    if (url.includes("/values:batchGet")) {
      if (valuesStatus !== 200) return json(valuesStatus, { error: { message: "denied" } });
      const titles = [...new URL(url).searchParams.getAll("ranges")].map((r) => r.slice(1, -1));
      return json(200, { valueRanges: titles.map((title) => ({ range: title, values: (typeof rows === "function" ? rows(title) : rows) })) });
    }
    return json(200, { properties: { title: "firstday.com changelog" }, sheets: tabs.map((properties) => ({ properties })) });
  };
  return { calls, fetchImpl };
}

test("collect as a service account: the tab is found by gid, read unformatted, and only GETs touch the sheet", async () => {
  clearGoogleTokenCache();
  const g = fakeGoogle();
  const out = await collectChangelog({ config, env, fetchImpl: g.fetchImpl, now: new Date("2026-11-12T15:00:00Z") });
  assert.equal(out.sheet.tab, "Web Changelog Flow");
  assert.match(out.sheet.url, /#gid=1384691948$/);
  assert.equal(out.since, "2026-10-29");
  assert.equal(out.latest, "2026-11-11");
  assert.deepEqual(out.entries.map((e) => e.change), ["Promoted New Homepage"], "older rows fall outside the lookback");
  const sheetCalls = g.calls.filter((c) => c.url.startsWith("https://sheets.googleapis.com"));
  assert.ok(sheetCalls.every((c) => (c.init?.method ?? "GET") === "GET"));
  assert.match(sheetCalls[1].url, /Web%20Changelog%20Flow/);
  assert.doesNotMatch(sheetCalls[1].url, /site_changelog/, "with a gid, only that tab");
  assert.match(sheetCalls[1].url, /valueRenderOption=UNFORMATTED_VALUE/);
  assert.equal(sheetCalls[0].init.headers.authorization, "Bearer ya29.x");
});

test("collect: a sheet not shared with the service account says who to share it with", async () => {
  clearGoogleTokenCache();
  const g = fakeGoogle({ valuesStatus: 403 });
  await assert.rejects(collectChangelog({ config, env, fetchImpl: g.fetchImpl, sleep: async () => {} }), /Share it with reader@example/);
});

test("collect: a gid the sheet does not have names the tabs it does", async () => {
  clearGoogleTokenCache();
  const g = fakeGoogle({ tabs: [{ sheetId: 0, title: "site_changelog" }] });
  await assert.rejects(collectChangelog({ config, env, fetchImpl: g.fetchImpl }), /none of the configured tabs.*site_changelog/);
});

test("configured by tabs (public link) or by a service account", () => {
  assert.equal(changelogConfigured(config, {}), true);
  assert.equal(changelogConfigured({ system: { changelog: { spreadsheetId: "SHEET" } } }, {}), false);
  assert.equal(changelogConfigured({ system: { changelog: { spreadsheetId: "SHEET" } } }, env), true);
  assert.equal(changelogConfigured({ system: {} }, env), false);
});

test("the speech reads the sheet live, and falls back to the readout's copy", async () => {
  clearGoogleTokenCache();
  const now = new Date("2026-11-12T15:00:00Z");
  const live = await changesForSpeech({ config, env, now, fetchImpl: fakeGoogle().fetchImpl, report: null });
  assert.deepEqual(live.map((c) => c.change), ["Promoted New Homepage"]);

  const report = { detail: { changelog: { entries: [{ row: 9, date: "2026-11-10", change: "From the readout" }, { row: 8, date: "2026-10-01", change: "Too old" }] } } };
  const noSheet = { system: { ...config.system, changelog: { spreadsheetId: "SHEET" } } };
  const fallback = await changesForSpeech({ config: noSheet, env: {}, now, report });
  assert.deepEqual(fallback.map((c) => c.change), ["From the readout"]);
  assert.equal(await changesForSpeech({ config: noSheet, env: {}, now, report: {} }), null);
});

test("collect as a service account with no tabs listed: every changelog tab is read and merged; other tabs are passed over", async () => {
  clearGoogleTokenCache();
  const byTab = {
    site_changelog: [["Day", "Date", "", "", "", ""], ["Mon", "11/9/2026", "KDE buy box rolled out"], ["Tue", "11/10/2026", ""], ["Wed", "11/11/2026", "promoted new homepage"]],
    "Web Changelog Flow": ROWS,
    active_tests: [["start", "end", "will end by", "test"], ["11/1/2026", "", "", "Some test"]],
  };
  const g = fakeGoogle({ tabs: Object.keys(byTab).map((title, i) => ({ sheetId: i, title })), rows: (title) => byTab[title] });
  const out = await collectChangelog({ config: { system: { ...config.system, changelog: { spreadsheetId: "SHEET" } } }, env, fetchImpl: g.fetchImpl, now: new Date("2026-11-12T15:00:00Z") });
  assert.equal(out.sheet.tab, "site_changelog + Web Changelog Flow");
  assert.deepEqual(out.entries.map((e) => [e.date, e.change, e.tab]), [
    ["2026-11-11", "promoted new homepage", "site_changelog"],
    ["2026-11-09", "KDE buy box rolled out", "site_changelog"],
  ], "the same change on the same day in two tabs is one change");
  assert.equal(new Set(out.entries.map((e) => e.row)).size, out.entries.length, "row keys are unique across tabs");
});

test("CSV as Google exports it: quotes, doubled quotes, newlines inside a field", () => {
  assert.deepEqual(parseCsv('Date,Change\r\n"Nov 11, 2026, 6:11:00 AM","say ""hi""\nline two"\n2/1/2026,x'), [
    ["Date", "Change"],
    ["Nov 11, 2026, 6:11:00 AM", 'say "hi"\nline two'],
    ["2/1/2026", "x"],
  ]);
});

const csvOf = (rows) => rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");

test("collect from the public link: each configured tab's CSV export, no credentials", async () => {
  const calls = [];
  const csvRows = ROWS.map((r) => r.map((c) => (typeof c === "number" && c > 40000 ? "Aug 5, 2026, 2:24:00 PM" : c)));
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response(csvOf(csvRows), { status: 200, headers: { "content-type": "text/csv; charset=utf-8" } });
  };
  const out = await collectChangelog({ config, env: {}, fetchImpl, now: new Date("2026-11-12T15:00:00Z") });
  assert.deepEqual(calls, ["https://docs.google.com/spreadsheets/d/SHEET/export?format=csv&gid=1384691948"]);
  assert.equal(out.sheet.tab, "Web Changelog Flow");
  assert.deepEqual(out.entries.map((e) => [e.date, e.change, e.monthlyRevenue]), [["2026-11-11", "Promoted New Homepage", null]]);
});

test("collect from the public link: a sheet that is no longer public says so", async () => {
  const fetchImpl = async () => new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } });
  await assert.rejects(collectChangelog({ config, env: {}, fetchImpl }), /not readable from its public link/);
});

// The kudos page (Last week's wins → Kudos page). Alex, 2026-11-19: "i want something like
// this to be creatable based on last weeks wins". The page is Alex's own design, kept as
// public/kudos/template.html; this fills it with the ticked wins: one heading per ROCK, one
// line per ticket (its ClickUp name), and the ticket's ClickUp link on the ↗. Nothing is
// written that is not a ticket name or a rock name from ClickUp.

import { cleanName } from "./update-text.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Monday of the week a time falls in, local. */
export function mondayOf(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * The week the page shows, in the template's shape:
 * { id, label, at, rocks: [{ n, w: [{ k, t, u }] }] }. Unticked tickets are left out, and a
 * rock with nothing left goes too. The week is the one the earliest win was finished in.
 */
export function kudosWeek(wins, excluded = new Set(), { now = Date.now() } = {}) {
  const start = mondayOf(wins.from ?? now);
  const rocks = [];
  for (const r of wins.rocks ?? []) {
    const w = r.tasks
      .filter((t) => !excluded.has(String(t.id)))
      .map((t) => {
        const url = String(t.url ?? "");
        return { k: `t${String(t.id).replace(/[^A-Za-z0-9_.-]/g, "")}`.slice(0, 200), t: cleanName(t.plainName ?? t.name).slice(0, 240), ...(/^https:\/\//.test(url) ? { u: url } : {}) };
      })
      .filter((x) => x.t);
    if (w.length) rocks.push({ n: String(r.label).slice(0, 80), w });
  }
  return { id: isoDay(start), label: `Week of ${MONTHS[start.getMonth()]} ${start.getDate()}`, at: start.toISOString(), rocks };
}

const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The page: the template with the week, its title and the monster image filled in. */
export function kudosPage(template, week, monsterSrc) {
  // JSON inside a <script>: escape "<" so a ticket named "</script>" cannot end it.
  const json = JSON.stringify(week).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  const fill = (s, token, value) => {
    if (!s.includes(token)) throw new Error(`The kudos template is missing ${token}.`);
    return s.split(token).join(value);
  };
  let html = fill(template, "/*__WEEK__*/null", json);
  html = fill(html, "<title>__TITLE__</title>", `<title>${escHtml(`Ecom Team KUDOS: ${week.label}`)}</title>`);
  html = fill(html, 'src="__MONSTER__"', `src="${escHtml(monsterSrc)}"`);
  return html;
}

/** "ecom-kudos-2026-11-09.html". */
export const kudosFileName = (week) => `ecom-kudos-${week.id}.html`;

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

/** A win's key on the page: "t" and its ClickUp id. */
export const winKeyOf = (id) => `t${String(id).replace(/[^A-Za-z0-9_.-]/g, "")}`.slice(0, 200);

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
        return { k: winKeyOf(t.id), t: cleanName(t.plainName ?? t.name).slice(0, 240), ...(/^https:\/\//.test(url) ? { u: url } : {}) };
      })
      .filter((x) => x.t);
    if (w.length) rocks.push({ n: String(r.label).slice(0, 80), w });
  }
  placeColumns(rocks);
  return { id: isoDay(start), label: `Week of ${MONTHS[start.getMonth()]} ${start.getDate()}`, at: start.toISOString(), rocks };
}

const isBau = (name) => /^\s*(bau|business as usual)\b/i.test(String(name ?? ""));

/**
 * Which of the three columns each rock sits in (field c). Balanced the way the page balances
 * them (each rock to the shortest column), then BAU's column is swapped with the last one.
 * Alex, 2026-11-20: "switch column 1 with 3 of the kudos i never want bau at the front".
 */
export function placeColumns(rocks) {
  const h = [0, 0, 0];
  for (const r of rocks) {
    const i = h[0] <= h[1] && h[0] <= h[2] ? 0 : h[1] <= h[2] ? 1 : 2;
    r.c = i;
    h[i] += r.w.length + 1.6;
  }
  const bau = rocks.find((r) => isBau(r.n));
  if (bau && bau.c !== 2) {
    const from = bau.c;
    for (const r of rocks) r.c = r.c === from ? 2 : r.c === 2 ? from : r.c;
  }
  return rocks;
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

/** The ClickUp ticket id behind a win's key ("t86b7x" → "86b7x"). */
export const taskIdOf = (key) => String(key).replace(/^t/, "");

/**
 * Put each win's ticket image into the week as a data URL (field i), for the hover. `images`
 * maps a win key to a data URL; anything that is not a PNG, JPG, GIF or WebP data URL is
 * dropped. Returns how many wins got one.
 */
export function addImages(week, images) {
  let n = 0;
  for (const r of week.rocks) {
    for (const x of r.w) {
      const src = images.get(x.k);
      if (typeof src === "string" && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(src)) {
        x.i = src;
        n++;
      }
    }
  }
  return n;
}

/** "ecom-kudos-2026-11-09.html", or with a saved version's name: "ecom-kudos-2026-11-09-final-for-drew.html". */
export const kudosFileName = (week, name = "") => {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `ecom-kudos-${week.id}${slug ? `-${slug}` : ""}.html`;
};

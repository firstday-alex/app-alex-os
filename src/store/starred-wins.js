// Starred wins: the wins Alex grades A+, A or A- from the Daily wins list, kept for good
// under Kudos › Starred wins (Alex, 2026-11-20: "a separate list managed under KUDOS for
// starred wins where i can optionally flag a A+ A or A- Kudos"). Starring a win does not
// take it off the Daily wins list; only Called out does that.
//
// One document, kudos/starred.json: { items: { [winKey]: record } }. The record is a copy of
// the win as it stood when starred (title, link, ROCK, why, kudos), so it outlives the sprint.

export const STARRED_KEY = "kudos/starred.json";
export const GRADES = ["A+", "A", "A-"];
const WIN_KEY = /^(task|change):[A-Za-z0-9_-]{1,64}$/;

export class StarError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const str = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);
const httpsOrNull = (u) => (/^https:\/\//i.test(String(u ?? "")) ? String(u).slice(0, 500) : null);
const dayOrNull = (d) => {
  const t = Date.parse(d ?? "");
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** The record kept for a starred win: only the fields the list shows, cleaned. */
export function starRecord(win, grade, now = new Date(), before = null) {
  if (!GRADES.includes(grade)) throw new StarError("Pick A+, A or A-.");
  if (!WIN_KEY.test(String(win?.key ?? ""))) throw new StarError("Which win?");
  const title = str(win.title, 300);
  if (!title) throw new StarError("That win has no title.");
  return {
    key: win.key,
    grade,
    title,
    url: httpsOrNull(win.url),
    rock: str(win.rock, 200),
    tactic: str(win.tactic, 200),
    stage: str(win.stage, 120),
    why: str(win.why, 1200),
    kudos: (Array.isArray(win.kudos) ? win.kudos : [])
      .slice(0, 8)
      .map((k) => ({ name: str(k?.name, 80), for: str(k?.for, 300) }))
      .filter((k) => k.name),
    who: (Array.isArray(win.who) ? win.who : []).slice(0, 8).map((n) => str(n, 80)).filter(Boolean),
    // When the work was completed; the day it was starred if the win carries no date.
    completedAt: dayOrNull(win.date) ?? before?.completedAt ?? now.toISOString(),
    starredAt: before?.starredAt ?? now.toISOString(),
    gradedAt: now.toISOString(),
  };
}

export async function readStarred(backend) {
  const doc = (await backend.get(STARRED_KEY)) ?? {};
  return { items: doc.items ?? {} };
}

/** Star (or regrade) a win. */
export async function starWin(backend, { win, grade, now = new Date() }) {
  const doc = await readStarred(backend);
  const record = starRecord(win, grade, now, doc.items[win?.key] ?? null);
  doc.items[record.key] = record;
  await backend.set(STARRED_KEY, doc);
  return record;
}

/** Take a win off the starred list. */
export async function unstarWin(backend, { key }) {
  if (!WIN_KEY.test(String(key ?? ""))) throw new StarError("Which win?");
  const doc = await readStarred(backend);
  const had = Boolean(doc.items[key]);
  delete doc.items[key];
  if (had) await backend.set(STARRED_KEY, doc);
  return had;
}

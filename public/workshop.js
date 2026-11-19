// The rock workshop agenda (Team → Workshop). Alex, 2026-11-19: "prioritize rocks X tactic
// combinations or in some cases just rock updates, with a grayed out state if it's not worth
// going over (no work happening on it, no recent updates from last week's sprint and/or this
// week's sprint)."
//
// One item per rock × tactic, plus a "rock update" for work on a rock with no tactic (or a
// rock with no tactics). Each item reads its tickets' activity over two weekly sprints (from
// Monday of last week): done this sprint, done last sprint, and open tickets that moved or got
// a comment. An item with none of that is quiet and grayed. Live items are ranked: Workshop
// Priority tactics, tactics or rocks in trouble, and what there is to show. Everything is read
// from the readout; nothing is made up.

const THIS_SPRINT_DONE = new Set(["done (this sprint)", "done"]);
const LAST_SPRINT_DONE = new Set(["complete", "dont use", "closed (last sprint)"]);
const TROUBLE = { off_track: 3, overdue: 3, blocked: 3, at_risk: 2 };
const COURSE = { off: 3, drift: 2 };

/** Midnight on Monday of last week, local time: the start of last week's sprint. */
export function sprintWindowStart(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const sinceMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - sinceMonday - 7);
  return d.getTime();
}

const status = (t) => String(t.status ?? "").toLowerCase();
const lastTouch = (t) => Math.max(t.dateUpdated ?? 0, t.lastComment?.date ?? 0, t.dateDone ?? 0, t.dateClosed ?? 0);

/** What a set of tickets did in the window. */
export function activityOf(tickets, since) {
  const doneThis = [];
  const doneLast = [];
  const moving = [];
  let open = 0;
  for (const t of tickets) {
    const s = status(t);
    if (THIS_SPRINT_DONE.has(s)) doneThis.push(t);
    else if (LAST_SPRINT_DONE.has(s)) {
      if (Math.max(t.dateDone ?? 0, t.dateClosed ?? 0, t.dateUpdated ?? 0) >= since) doneLast.push(t);
    } else if (t.bucket !== "done") {
      open++;
      // A backlog ticket that was only edited is planning, not work moving.
      if (s !== "backlog" && !t.fromBacklog && lastTouch(t) >= since) moving.push(t);
    }
  }
  return { doneThis, doneLast, moving, open, live: doneThis.length + doneLast.length + moving.length > 0 };
}

/**
 * The agenda: live items ranked, then quiet ones (grayed), each with why it is or is not on.
 * `placeOf(task)` gives { rockId, tacticId } or null (the app's placeTicketOnRock).
 */
export function buildAgenda({ rocks = [], courses = new Map(), tasks = [], placeOf, now = new Date() }) {
  const since = sprintWindowStart(now);
  const byKey = new Map();
  for (const t of tasks) {
    if (t.archived) continue;
    const place = placeOf(t);
    if (!place) continue;
    const key = `${place.rockId}:${place.tacticId ?? ""}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(t);
  }
  const items = [];
  for (const rock of rocks) {
    const course = courses.get(rock.id)?.course ?? "on";
    const rows = (rock.tactics ?? []).map((tactic) => ({ tactic, tickets: byKey.get(`${rock.id}:${tactic.id}`) ?? [] }));
    const direct = byKey.get(`${rock.id}:`) ?? [];
    if (direct.length || !rows.length) rows.push({ tactic: null, tickets: direct });
    for (const { tactic, tickets } of rows) {
      const a = activityOf(tickets, since);
      const workshop = tactic?.kind === "Workshop Priority";
      const trouble = TROUBLE[tactic ? tactic.status : rock.status] ?? 0;
      const done = ["done", "shipped"].includes(tactic?.status);
      // Priority and trouble lead; activity counts but is capped, so a big pile of tickets
      // does not outrank a Workshop Priority tactic. Business as usual goes last.
      const activity = Math.min(a.doneThis.length * 2 + a.doneLast.length + a.moving.length, 4);
      const score = (rock.bau && !workshop ? -20 : 0) + (workshop ? 6 : 0) + trouble + (COURSE[course] ?? 0) + activity;
      const reasons = [];
      if (a.doneThis.length) reasons.push(`${a.doneThis.length} done this sprint`);
      if (a.doneLast.length) reasons.push(`${a.doneLast.length} done last sprint`);
      if (a.moving.length) reasons.push(`${a.moving.length} moving`);
      const sinceText = new Date(since).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const quietWhy = done ? "tactic is done" : !tickets.length ? "no tickets on it" : a.open ? `${a.open} open, none touched since ${sinceText}` : `nothing done or moving since ${sinceText}`;
      items.push({
        key: `${rock.id}:${tactic?.id ?? "rock"}`,
        rock: { id: rock.id, title: rock.title, owner: rock.owner?.name ?? rock.owner ?? null, status: rock.status, course },
        tactic: tactic ? { id: tactic.id, title: tactic.title, owner: tactic.owner?.name ?? tactic.owner ?? null, status: tactic.status ?? null, notes: tactic.notes ?? null } : null,
        workshop,
        bau: Boolean(rock.bau),
        trouble: trouble > 0,
        live: a.live,
        score,
        reasons,
        quietWhy: a.live ? null : quietWhy,
        // What to show: done this sprint first, then last sprint, then what is moving.
        show: [...a.doneThis, ...a.doneLast].map((t) => ({ name: t.plainName ?? t.name, url: t.url ?? null, done: true, who: (t.assignees ?? []).map((u) => String(u.username ?? "").split(/\s+/)[0]).filter(Boolean) })),
        moving: a.moving.map((t) => ({ name: t.plainName ?? t.name, url: t.url ?? null, status: t.status, who: (t.assignees ?? []).map((u) => String(u.username ?? "").split(/\s+/)[0]).filter(Boolean) })),
        open: a.open,
      });
    }
  }
  const live = items.filter((i) => i.live).sort((a, b) => b.score - a.score || String(a.rock.title).localeCompare(String(b.rock.title)));
  const quiet = items.filter((i) => !i.live).sort((a, b) => Number(b.trouble) - Number(a.trouble) || Number(b.workshop) - Number(a.workshop));
  return { since, live, quiet };
}

/** The agenda as text to paste: the live items in order, then what is skipped. */
export function agendaText({ live, quiet }, { include = new Set(), skip = new Set() } = {}) {
  const on = [...live.filter((i) => !skip.has(i.key)), ...quiet.filter((i) => include.has(i.key))];
  const off = [...live.filter((i) => skip.has(i.key)), ...quiet.filter((i) => !include.has(i.key))];
  const name = (i) => `${i.rock.title} → ${i.tactic ? i.tactic.title : "Rock update"}`;
  const lines = ["Workshop agenda", ""];
  on.forEach((i, n) => {
    lines.push(`${n + 1}. ${name(i)}${i.tactic?.owner ? ` (${String(i.tactic.owner).split(/\s+/)[0]})` : i.rock.owner ? ` (${String(i.rock.owner).split(/\s+/)[0]})` : ""}`);
    if (i.reasons.length) lines.push(`   ${i.reasons.join(" · ")}`);
    for (const s of i.show.slice(0, 3)) lines.push(`   ✓ ${s.name}`);
  });
  if (off.length) lines.push("", `Skipping: ${off.map(name).join("; ")}`);
  return lines.join("\n");
}

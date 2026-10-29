// Next steps: the checks across every sprint ticket that each end in something Alex does.
//
// Every flag here carries `values.action` (reply, nudge, decide or fix) and `values.who`,
// the person to reach, so the dashboard can list them as "Reply to Oleksandr", "Nudge
// Blake", and so on. They sit alongside the older ticket flags (stalled, stuck in a status,
// no owner, no Big Swing), which the dashboard files under the same four actions.
//
//   reply    it is waiting on Alex: an @mention, or something Alex owns waiting on Alex
//   nudge    ask the owner or the assignee: a question unanswered, bounced from QA, due
//   decide   a sprint call: commitment at risk, carried over, too much at once, idle,
//            a rock due this month with nothing moving, overdue
//   fix      the ticket is missing what the other checks read: no assignee, no due date
//
// The sprint-level checks raise one flag per person, not one per ticket, and key on the
// week, so handling one lasts the sprint and the readout does not grow a line per ticket.
//
// Everything is read off what the collectors already hold: the tickets (with their last
// comment, its @mentions and due dates), the status ledger (when a ticket was first seen
// and which status it moved from) and the rocks. Nothing is fetched here.

import { makeFlag } from "./flags.js";
import { zonedParts, shiftDateKey } from "../lib/time.js";
import { ownsSwing, swingIdsOf } from "../collectors/leadership.js";

const DAY_MS = 86_400_000;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const REVIEW = new Set(["qa", "vqa", "in review"]);
const DEPLOY = new Set(["ready for deploy"]);
const WORK = new Set(["in-progress", "in progress"]);
const TODO = new Set(["to do", "open", "not started"]);
// A ticket moved back from one of these into work has bounced: something failed.
const BOUNCE_FROM = new Set([...REVIEW, ...DEPLOY]);

const statusOf = (t) => String(t.status ?? "").toLowerCase();
const first = (name) => String(name ?? "someone").split(/\s+/)[0];
const names = (users) => (users ?? []).map((u) => first(u.username ?? u.name ?? u.id));
const quote = (text, n = 120) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const ago = (ms, now) => {
  const days = Math.floor((now - ms) / DAY_MS);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
};

/** Midnight at the start of `key` in the zone, as epoch ms. Accurate to the hour, which is enough here. */
function startOfKey(key, timeZone) {
  const [y, m, d] = key.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const parts = zonedParts(new Date(guess), timeZone);
  // How far the zone's wall clock is from UTC at that instant.
  const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - guess;
  return guess - offset;
}

/**
 * @param {object} args
 * @param {Array} args.tasks          the ClickUp delta's tasks
 * @param {object} [args.statusLedger] { entries: { [taskId]: { firstObserved, previousStatus, since, exact } } }
 * @param {object} [args.leadership]  the leadership snapshot, for the rocks
 * @param {object} args.config
 * @param {string} args.dateKey
 * @param {string} args.nowIso
 */
export function nextStepFlags({ tasks = [], statusLedger = null, leadership = null, config, dateKey, nowIso }) {
  const flags = [];
  const add = (spec) => flags.push(makeFlag({ layer: 2, ...spec }, { dateKey }));
  const now = new Date(nowIso).getTime();
  const tz = config.system?.timezone ?? "America/Chicago";
  const today = zonedParts(new Date(now), tz);
  const todayStart = startOfKey(today.dateKey, tz);
  // The sprint runs Monday to Friday. Its start, and a key that names the week.
  const mondayKey = shiftDateKey(today.dateKey, -((today.weekday + 6) % 7));
  const sprintStart = startOfKey(mondayKey, tz);
  const me = config.people?.alex?.clickupUserId == null ? null : String(config.people.alex.clickupUserId);
  const isMe = (u) => me != null && String(u?.id) === me;
  const roster = (config.people?.team ?? []).filter((p) => p.clickupUserId != null);
  const rules = config.clickup?.nextSteps ?? {};
  const unansweredAfterDays = rules.unansweredAfterDays ?? 2;
  const dueSoonDays = rules.dueSoonDays ?? 2;
  const tooManyInProgress = rules.tooManyInProgress ?? 3;
  const bouncedWithinDays = rules.bouncedWithinDays ?? 3;

  const open = tasks.filter((t) => t.bucket !== "done" && !t.archived);
  const subject = (t, suffix) => ({ type: "task", id: `${t.id}:${suffix}`, label: t.name, url: t.url });
  const owners = (t) => t.taskOwners ?? [];
  const doers = (t) => (t.assignees?.length ? t.assignees : owners(t));
  // Who to reach about a sprint ticket: whoever is assigned, doing the work now, rather
  // than the project owner. The owner only when nobody else is on it.
  const contact = (t) => {
    const a = (t.assignees ?? []).filter((u) => !isMe(u));
    return a.length ? a : owners(t).filter((u) => !isMe(u));
  };

  for (const t of open) {
    const s = statusOf(t);
    const c = t.lastComment;

    /* ---- reply: someone asked Alex ---- */
    if (c && me && String(c.userId) !== me && (c.mentions ?? []).some((m) => String(m.id) === me)) {
      add({
        rule: "nextstep.reply_owed",
        severity: "attention",
        advisable: false,
        subject: subject(t, "reply"),
        message: `Reply to ${first(c.user)} on "${t.name}": they @mentioned you ${ago(c.date, now)}${c.text ? `: "${quote(c.text)}"` : "."}`,
        values: { action: "reply", who: first(c.user), askedAt: c.date, status: t.status },
      });
    }

    /* ---- reply: Alex owns it and it is waiting for Alex to approve or deploy ---- */
    if ((REVIEW.has(s) || DEPLOY.has(s)) && owners(t).some(isMe) && !doers(t).every(isMe) && (t.statusAge?.days ?? 0) >= 1) {
      const step = DEPLOY.has(s) ? "deploy or approve it" : "review it";
      add({
        rule: "nextstep.awaiting_you",
        severity: "attention",
        subject: subject(t, "awaiting-you"),
        message: `"${t.name}" is in ${t.status} for ${t.statusAge.exact ? "" : "at least "}${t.statusAge.days} days and you own it: ${step}, or say who should.`,
        values: { action: "reply", who: "you", status: t.status, days: t.statusAge.days, doing: names(doers(t)) },
      });
    }

    /* ---- nudge: a question to someone else, unanswered ---- */
    if (c && c.date && now - c.date > unansweredAfterDays * DAY_MS) {
      const asked = (c.mentions ?? []).filter((m) => String(m.id) !== String(c.userId) && !isMe(m));
      // Nothing on the ticket since the question: ClickUp moves date_updated on any change.
      const untouchedSince = (t.dateUpdated ?? 0) - c.date < 3_600_000;
      if (asked.length && untouchedSince) {
        const who = asked.map((m) => first(m.username)).join(", ");
        add({
          rule: "nextstep.question_unanswered",
          severity: "attention",
          subject: subject(t, "unanswered"),
          message: `Nudge ${who} on "${t.name}": ${isMe({ id: c.userId }) ? "you" : first(c.user)} asked ${ago(c.date, now)} and nothing has moved since.`,
          values: { action: "nudge", who, askedBy: c.user, askedAt: c.date },
        });
      }
    }

    /* ---- nudge: bounced back out of QA or deploy ---- */
    const entry = statusLedger?.entries?.[String(t.id)];
    if (entry?.exact && BOUNCE_FROM.has(String(entry.previousStatus ?? "").toLowerCase()) && (WORK.has(s) || TODO.has(s)) && now - entry.since <= bouncedWithinDays * DAY_MS) {
      const who = names(contact(t)).join(", ") || "the owner";
      add({
        rule: "nextstep.bounced_back",
        severity: "attention",
        subject: subject(t, "bounced"),
        message: `Ask ${who} what failed on "${t.name}": it went back from ${entry.previousStatus} to ${t.status} ${ago(entry.since, now)}.`,
        values: { action: "nudge", who, from: entry.previousStatus, to: t.status, at: entry.since },
      });
    }

    /* ---- due dates ---- */
    if (t.dueDate) {
      const daysLeft = Math.floor((t.dueDate - todayStart) / DAY_MS);
      const who = names(contact(t)).join(", ") || "the owner";
      const due = new Date(t.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
      if (daysLeft < 0) {
        add({
          rule: "nextstep.overdue",
          severity: "attention",
          subject: subject(t, "overdue"),
          message: `"${t.name}" was due ${due} and is still ${t.status}. Agree a new date with ${who}, or cut it.`,
          values: { action: "decide", who, dueDate: t.dueDate, daysOver: -daysLeft, status: t.status },
        });
      } else if (TODO.has(s) && daysLeft <= dueSoonDays) {
        add({
          rule: "nextstep.due_not_started",
          severity: "attention",
          subject: subject(t, "due-soon"),
          message: `Nudge ${who}: "${t.name}" is due ${daysLeft === 0 ? "today" : daysLeft === 1 ? "tomorrow" : due} and has not been started.`,
          values: { action: "nudge", who, dueDate: t.dueDate, daysLeft },
        });
      }
    }

    /* ---- fix: nobody doing it ---- */
    if (!t.assignees?.length) {
      add({
        rule: "nextstep.no_assignee",
        severity: "info",
        advisable: false,
        subject: subject(t, "assignee"),
        message: `"${t.name}" has nobody assigned. Assign whoever is doing the current stage.`,
        values: { action: "fix", who: names(owners(t)).join(", ") || null, status: t.status },
      });
    }
  }

  /* ---- fix: in progress with no due date, once due dates are actually in use ---- */
  // Until a few tickets carry one, every in-progress ticket would be flagged for a field
  // the team does not use yet, which is noise rather than a next step.
  const dated = open.filter((t) => t.dueDate).length;
  if (dated >= (rules.dueDatesInUseAt ?? 3)) {
    for (const t of open.filter((t) => WORK.has(statusOf(t)) && !t.dueDate)) {
      add({
        rule: "nextstep.no_due_date",
        severity: "info",
        advisable: false,
        subject: subject(t, "due"),
        message: `"${t.name}" is in progress with no due date. Set one with ${names(contact(t)).join(", ") || "the owner"}.`,
        values: { action: "fix", who: names(contact(t)).join(", ") || null },
      });
    }
  }

  /* ---- decide: sprint-level, one flag per person per week ---- */
  const byPerson = (list, pick) => {
    const map = new Map();
    for (const t of list) {
      for (const u of pick(t)) {
        if (isMe(u)) continue;
        const id = String(u.id);
        if (!map.has(id)) map.set(id, { id, name: u.username ?? id, tasks: [] });
        map.get(id).tasks.push(t);
      }
    }
    return [...map.values()];
  };
  const listOf = (ts, n = 4) => `${ts.slice(0, n).map((t) => `"${t.name}"`).join(", ")}${ts.length > n ? ` and ${ts.length - n} more` : ""}`;
  const personSubject = (p, what) => ({ type: "person", id: `${p.id}:${what}:${mondayKey}`, label: p.name });

  // Wednesday or later and still not started: keep it this sprint, or move it out.
  if (today.weekday >= 3 && today.weekday <= 5) {
    for (const p of byPerson(open.filter((t) => TODO.has(statusOf(t))), owners)) {
      add({
        rule: "nextstep.commitment_at_risk",
        severity: "attention",
        subject: personSubject(p, "not-started"),
        message: `It is ${DAY_NAMES[today.weekday]} and ${first(p.name)} has ${p.tasks.length} ticket${p.tasks.length === 1 ? "" : "s"} not started: ${listOf(p.tasks)}. Keep ${p.tasks.length === 1 ? "it" : "them"} this sprint, or move ${p.tasks.length === 1 ? "it" : "them"} out.`,
        values: { action: "decide", who: first(p.name), tickets: p.tasks.map((t) => ({ id: t.id, name: t.name, url: t.url })) },
      });
    }
  }

  // Open since before this sprint began: carried over. Cut, split or re-scope.
  const carried = open.filter((t) => {
    const e = statusLedger?.entries?.[String(t.id)];
    return e?.firstObserved != null && e.firstObserved < sprintStart;
  });
  for (const p of byPerson(carried, owners)) {
    add({
      rule: "nextstep.carried_over",
      severity: "attention",
      subject: personSubject(p, "carried"),
      message: `${first(p.name)} carried ${p.tasks.length} ticket${p.tasks.length === 1 ? "" : "s"} over from before this sprint: ${listOf(p.tasks)}. Cut, split or re-scope ${p.tasks.length === 1 ? "it" : "them"}.`,
      values: { action: "decide", who: first(p.name), tickets: p.tasks.map((t) => ({ id: t.id, name: t.name, url: t.url })) },
    });
  }

  // Too much in flight at once: finish one first.
  for (const p of byPerson(open.filter((t) => WORK.has(statusOf(t))), doers)) {
    if (p.tasks.length < tooManyInProgress) continue;
    add({
      rule: "nextstep.too_much_in_progress",
      severity: "attention",
      subject: personSubject(p, "wip"),
      message: `${first(p.name)} has ${p.tasks.length} tickets in progress at once: ${listOf(p.tasks)}. Ask which one gets finished first.`,
      values: { action: "decide", who: first(p.name), count: p.tasks.length, limit: tooManyInProgress },
    });
  }

  // Nothing in flight but work waiting: start one.
  const counted = roster.filter((p) => p.countsTowardCapacity !== false && String(p.clickupUserId) !== me);
  for (const person of counted) {
    const id = String(person.clickupUserId);
    const mine = open.filter((t) => doers(t).some((u) => String(u.id) === id));
    const moving = mine.filter((t) => !TODO.has(statusOf(t)));
    const waiting = mine.filter((t) => TODO.has(statusOf(t)));
    if (moving.length || !waiting.length) continue;
    add({
      rule: "nextstep.idle",
      severity: "attention",
      subject: { type: "person", id: `${id}:idle`, label: person.name },
      message: `${first(person.name)} has nothing in progress and ${waiting.length} ticket${waiting.length === 1 ? "" : "s"} to do: ${listOf(waiting)}. Nudge them to start one.`,
      values: { action: "nudge", who: first(person.name), waiting: waiting.length },
    });
  }

  // A rock due this month with no ticket moving on it.
  const monthKey = today.dateKey.slice(0, 7);
  for (const rock of (leadership?.queue ?? []).filter((r) => r.state === "active" && r.targetMonth === monthKey)) {
    const linked = open.filter((t) => {
      const swing = t.bigSwing;
      if (!swing) return false;
      if (swingIdsOf(rock).length && swing.optionId) return ownsSwing(rock, swing.optionId);
      return String(swing.label ?? "").trim().toLowerCase() === String(rock.title).trim().toLowerCase();
    });
    if (linked.some((t) => !TODO.has(statusOf(t)))) continue;
    const owner = rock.owner?.name ?? null;
    add({
      rule: "nextstep.rock_due_not_moving",
      severity: "attention",
      subject: { type: "priority", id: `${rock.id}:due-${monthKey}`, label: rock.title },
      message: `"${rock.title}" is due this month and no ticket on it is in progress${linked.length ? ` (${linked.length} still to do)` : " (none on the sprint)"}. Decide with ${owner ? first(owner) : "its owner"}: start the work, or move the month.`,
      values: { action: "decide", who: owner ? first(owner) : null, targetMonth: rock.targetMonth, tickets: linked.length },
    });
  }

  return flags;
}

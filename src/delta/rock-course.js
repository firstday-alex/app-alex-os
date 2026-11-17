// Rock course check: is each rock actually on course, whatever its status says?
//
// The status in the standup is the owner's word. On 2026-11-13 every rock read On Track
// while one had half its tactics past their check-in date, and no rule said a thing,
// because the only rock rule that raised a P1 waited for the owner to say At Risk. This
// reads the evidence instead, rock by rock, and says which signal is off and what the
// decision is:
//
//   milestones  one from an earlier month still not done; this month's still open late
//               in the month, or open with nothing moving on it
//   tactics     past their check-in date and not done; half or more of them is off course
//   work        open tickets on the rock with none moved in a week; no ticket at all
//   plan        weeks planned on the Quarter plan whose items were not done
//
// A signal is "off" (the rock is off course), "drift" (drifting) or "gap" (something we
// cannot see, listed so it can be fixed, but never on its own a reason to raise a flag).
//
// One flag per rock: off course is a P1, drifting a P2 that escalates after a working
// week like any other. It replaces the separate stalled-work, due-not-moving and At Risk
// flags for that rock, so a rock in trouble is one line with every reason on it.
//
// Plain counting over what the readout already holds. No model.

import { makeFlag } from "./flags.js";
import { ownsSwing, swingIdsOf } from "../collectors/leadership.js";
import { ownsTactic } from "../collectors/clickup-names.js";
import { dateKey as zonedDateKey } from "../lib/time.js";
import { monthShare, daysLeftInMonth, daysFrom, weekStartOf, monthName, shortDay } from "../../public/quarter.js";

export const COURSE_DEFAULTS = {
  /** A rock whose open tickets have all sat this long has stalled. */
  stalledAfterDays: 7,
  /** This far into the month, an open milestone with nothing moving is off course. */
  nothingMovingAfterShare: 0.25,
  /** This far into the month, an open milestone is worth a word even with work moving. */
  lateInMonthShare: 0.75,
  /** Days past a tactic's check-in date before it counts: the standup is often a day late. */
  checkInGraceDays: 2,
};

const first = (name) => String(name ?? "").trim().split(/\s+/)[0] || null;
const quote = (s, max = 60) => {
  const t = String(s ?? "").trim();
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const LEVEL_RANK = { off: 0, drift: 1, gap: 2 };

/**
 * Which rock, and which of its tactics, a ticket serves: a TACTIC value naming one of the
 * rock's tactics, else a ROCK (Big Swing) option the rock or a tactic is linked through,
 * else a ROCK label equal to the rock's title. `tacticId` is null for work on the rock
 * itself.
 */
export function placeTicket(rocks, task) {
  const tacticOpt = task?.leadershipPriority?.optionId == null ? null : String(task.leadershipPriority.optionId);
  const swingOpt = task?.bigSwing?.optionId == null ? null : String(task.bigSwing.optionId);
  const swingLabel = String(task?.bigSwing?.label ?? "").trim().toLowerCase();
  const rock =
    rocks.find((r) => ownsTactic(r, task)) ??
    (swingOpt ? rocks.find((r) => ownsSwing(r, swingOpt)) : null) ??
    (swingLabel ? rocks.find((r) => String(r.title ?? "").trim().toLowerCase() === swingLabel) : null);
  if (!rock) return null;
  const tactic = (rock.tactics ?? []).find(
    (t) => (tacticOpt && String(t.clickupTacticOptionId ?? "") === tacticOpt) || (swingOpt && String(t.clickupBigSwingOptionId ?? "") === swingOpt),
  );
  return { rockId: rock.id, tacticId: tactic?.id ?? null };
}

/**
 * @param {object} args
 * @param {object[]} args.rocks       the leadership queue (Supabase rocks, linked)
 * @param {object[]} [args.tasks]     sprint and backlog tickets as the readout holds them
 * @param {object[]} [args.history]   the quarter's ticket ledger (QuarterPlanStore), for work done earlier
 * @param {object[]} [args.plan]      the Quarter plan's items
 * @param {string}   args.dateKey
 * @param {string}   [args.timeZone]
 * @param {string}   [args.alexName]  so Alex's own rocks say "Decide:", not "Decide with Alex:"
 * @param {object}   [args.opts]
 * @returns {{ rocks: object[], flags: object[] }}
 */
export function rockCourse({ rocks = [], tasks = [], history = [], plan = [], dateKey, timeZone, alexName = null, opts = {} }) {
  const o = { ...COURSE_DEFAULTS, ...opts };
  const month = dateKey.slice(0, 7);
  const share = monthShare(dateKey);
  const left = daysLeftInMonth(dateKey);
  const thisWeek = weekStartOf(dateKey);
  const keyOf = (ms) => (ms ? zonedDateKey(new Date(Number(ms)), timeZone) : null);

  const live = rocks.filter((r) => r.state === "active" && !r.bau);
  const out = [];
  const flags = [];

  for (const rock of live) {
    const mine = tasks.filter((t) => !t.archived && placeTicket([rock], t));
    const open = mine.filter((t) => t.bucket !== "done");
    const moving = open.filter((t) => t.bucket === "inProgress" && (t.idleDays == null || t.idleDays < o.stalledAfterDays));
    const doneRecently = history.filter((h) => h.rockId === rock.id && h.doneOn && daysFrom(h.doneOn, dateKey) <= o.stalledAfterDays);
    const workMoving = moving.length > 0 || doneRecently.length > 0;
    const idleKnown = open.filter((t) => t.idleDays != null);
    const freshest = idleKnown.length ? idleKnown.reduce((a, b) => (a.idleDays <= b.idleDays ? a : b)) : null;

    const signals = [];
    const add = (level, kind, text, fix) => signals.push({ level, kind, text, fix });

    /* ---- milestones ---- */
    const milestones = rock.milestones ?? [];
    for (const m of milestones.filter((m) => m.month < month && !m.done)) {
      add("off", "milestone_late", `${monthName(m.month)}'s milestone ${quote(m.deliverable)} is not done`, "finish it, or move it into this month in the standup and say what slips");
    }
    const current = milestones.filter((m) => m.month === month && !m.done);
    for (const m of current) {
      if (m.blocker) add("off", "milestone_blocked", `this month's milestone ${quote(m.deliverable)} is blocked: ${m.blocker}`, "clear the blocker or re-scope the milestone");
      else if (!workMoving && share >= o.nothingMovingAfterShare) {
        add("off", "milestone_nothing_moving", `${Math.round(share * 100)}% of ${monthName(month)} is gone and nothing on this rock is moving toward ${quote(m.deliverable)}`, "put a ticket in progress this week, or move the milestone");
      } else if (share >= o.lateInMonthShare) {
        add("drift", "milestone_late_in_month", `${plural(left, "day", "days")} left in ${monthName(month)} and ${quote(m.deliverable)} is still open`, "confirm it lands this month, or move it now rather than on the last day");
      }
    }

    /* ---- tactics ---- */
    const liveTactics = (rock.tactics ?? []).filter((t) => t.status !== "done");
    const pastCheckIn = liveTactics.filter((t) => t.checkInDate && daysFrom(t.checkInDate, dateKey) > o.checkInGraceDays);
    if (pastCheckIn.length) {
      const list = pastCheckIn
        .map((t) => `${quote(t.title, 40)}${t.checkInDate ? ` (${plural(daysFrom(t.checkInDate, dateKey), "day", "days")} past ${shortDay(t.checkInDate)})` : ""}`)
        .join(", ");
      const half = liveTactics.length >= 2 && pastCheckIn.length * 2 >= liveTactics.length;
      add(
        half ? "off" : "drift",
        "tactics_past_checkin",
        `${pastCheckIn.length} of ${liveTactics.length} ${liveTactics.length === 1 ? "tactic" : "tactics"} ${pastCheckIn.length === 1 ? "is" : "are"} past the check-in date: ${list}`,
        `check in on ${pastCheckIn.length === 1 ? "it" : "each"} in the standup: mark it done, or set a new date and say why`,
      );
    }
    const blind = liveTactics.filter((t) => !t.clickupBigSwingOptionId && !t.clickupTacticOptionId && !mine.some((x) => placeTicket([rock], x)?.tacticId === t.id));
    if (blind.length) {
      add("gap", "tactics_unlinked", `${plural(blind.length, "tactic has", "tactics have")} no ClickUp link, so ${blind.length === 1 ? "its" : "their"} work cannot be seen: ${blind.map((t) => quote(t.title, 40)).join(", ")}`, "give each a ROCK or TACTIC value in ClickUp, or link it on the Rocks tab");
    }

    /* ---- work ---- */
    if (open.length && !moving.length && freshest && freshest.idleDays >= o.stalledAfterDays && !doneRecently.length) {
      add("drift", "work_stalled", `none of its ${plural(open.length, "open ticket has", "open tickets have")} moved in ${freshest.idleDays} days (most recent: ${quote(freshest.name, 50)})`, "ask the owner what is blocking it");
    }
    if (!open.length && swingIdsOf(rock).length && (current.length || milestones.some((m) => m.month > month && !m.done))) {
      add("off", "no_work", "no open ticket on the sprint or in the backlog, with milestones still to deliver", "plan the next tickets for it, or decide the milestones are not happening this quarter");
    }

    /* ---- plan ---- */
    const planned = plan.filter((p) => p.rockId === rock.id);
    const slipped = planned.filter((p) => !p.done && p.week < thisWeek);
    if (slipped.length) {
      add("drift", "plan_slipped", `${plural(slipped.length, "planned item", "planned items")} from earlier weeks not done: ${slipped.slice(0, 3).map((p) => quote(p.text, 40)).join(", ")}${slipped.length > 3 ? "…" : ""}`, "re-plan them into a week on the Quarter plan, or drop them");
    }

    signals.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
    const ownerSays = rock.status === "at_risk";
    const course = ownerSays || signals.some((s) => s.level === "off") ? "off" : signals.some((s) => s.level === "drift") ? "drift" : "on";

    const counts = {
      tactics: liveTactics.length,
      tacticsPastCheckIn: pastCheckIn.length,
      ticketsOpen: open.length,
      ticketsMoving: moving.length,
      doneLastWeek: doneRecently.length,
      milestonesThisMonth: milestones.filter((m) => m.month === month).length,
      milestonesThisMonthDone: milestones.filter((m) => m.month === month && m.done).length,
      planned: planned.length,
      plannedDone: planned.filter((p) => p.done).length,
    };
    const summary = { id: rock.id, title: rock.title, owner: rock.owner?.name ?? null, statusColor: rock.statusColor ?? null, course, signals, counts };
    out.push(summary);

    if (course === "on") continue;
    const reasons = signals.filter((s) => s.level !== "gap");
    const lead = reasons[0] ?? null;
    const statusWord = { green: "On Track", amber: "At Risk", red: "Off Track" }[rock.statusColor] ?? null;
    const said = ownerSays
      ? `is marked ${statusWord ?? "At Risk"}${rock.statusReason ? ` (${rock.statusReason})` : ""}`
      : `is marked ${statusWord ?? "with no status"}, but ${course === "off" ? "looks off course" : "is drifting"}`;
    const owner = rock.owner?.name ?? null;
    const isAlex = owner && (/^you$/i.test(owner) || (alexName && first(owner).toLowerCase() === first(alexName).toLowerCase()));
    flags.push(
      makeFlag(
        {
          layer: 1,
          rule: "leadership.rock_off_course",
          severity: course === "off" ? "p1" : "attention",
          subject: { type: "priority", id: `${rock.id}:course`, label: rock.title },
          message: `"${rock.title}" ${said}${reasons.length ? `: ${reasons.slice(0, 3).map((s) => s.text).join("; ")}${reasons.length > 3 ? `; and ${reasons.length - 3} more` : ""}` : ""}. ${
            lead ? `Decide${owner && !isAlex ? ` with ${first(owner)}` : ""}: ${lead.fix}.` : "Decide where it goes from here."
          }`,
          values: {
            course,
            status: rock.status ?? null,
            statusColor: rock.statusColor ?? null,
            owner,
            who: owner ? first(owner) : null,
            signals,
            counts,
            monthShare: Math.round(share * 100) / 100,
          },
        },
        { dateKey },
      ),
    );
  }

  return { rocks: out, flags };
}

/** The rock flags a course flag stands in for, so a rock in trouble is one line, not three. */
export const SUPERSEDED_BY_COURSE = new Set(["leadership.rock_at_risk", "crosslayer.rock_work_stalled", "nextstep.rock_due_not_moving"]);

/** The rock id a rock flag is about: subject ids are "<rock id>:<suffix>". */
export const rockIdOfFlag = (f) => String(f.subject?.id ?? "").split(":")[0];

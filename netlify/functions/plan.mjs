// The Quarter plan API.
//
//   GET  /plan[?quarter=2026-Q4]   the quarter's weeks, its rocks and tactics (from the
//                                  latest readout), the planned items, the tickets per
//                                  rock with the week each landed or is due in, and each
//                                  rock's course worked out live against the plan
//   POST /plan                     { quarter, version, change: {add|update|remove} }
//                                  applies one change and answers as GET does
//
// Rocks, tactics and milestones are as of the latest readout (a Refresh brings them up to
// date); they are read from Supabase there and never written. The plan is this app's.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";
import { dateKey as zonedDateKey } from "../../src/lib/time.js";
import { QuarterPlanStore, PlanError } from "../../src/store/quarter-plan.js";
import { rockCourse } from "../../src/delta/rock-course.js";
import { quarterOfKey, quarterWeeks, monthsOf } from "../../public/quarter.js";

const nameOf = (p) => p?.name ?? null;

async function payload({ config, store, planStore, quarter, logger }) {
  const tz = config.system.timezone;
  const today = zonedDateKey(new Date(), tz);
  const report = await store.getLatestReport({});
  const queue = (report?.detail?.leadership?.queue ?? []).filter((r) => !r.bau && r.state === "active");
  const tasks = report?.detail?.clickup?.tasks ?? [];
  const backlog = report?.detail?.backlog?.available ? report.detail.backlog.items ?? [] : [];
  const sprintIds = new Set(tasks.map((t) => String(t.id)));
  const allTasks = [...tasks, ...backlog.filter((t) => !sprintIds.has(String(t.id)))];

  const plan = await planStore.read(quarter);
  let ledger = await planStore.readTickets(quarter);
  // Today's tickets laid over the stored record without saving, so a ticket moved since
  // the 8 AM run shows where it is now.
  if (report?.dateKey && quarterOfKey(report.dateKey) === quarter) ledger = QuarterPlanStore.fold(ledger, allTasks, queue, report.dateKey, tz);

  const course = report
    ? rockCourse({
        rocks: queue,
        tasks: allTasks,
        history: Object.values(ledger.tickets),
        plan: plan.items,
        dateKey: today,
        timeZone: tz,
        alexName: config.people?.alex?.name ?? null,
        opts: config.system.rockCourse ?? {},
      }).rocks
    : [];

  const live = report?.dateKey ?? null;
  const tickets = Object.values(ledger.tickets)
    // A ticket last seen before the latest readout and never seen done left the sprint
    // and the backlog some other way; it is not work on the plan any more.
    .filter((t) => t.rockId && (t.doneOn || t.lastSeen === live))
    .map((t) => ({ ...t, onSprint: sprintIds.has(String(t.id)) }));

  return {
    quarter,
    today,
    months: monthsOf(quarter),
    weeks: quarterWeeks(quarter),
    readoutAt: report?.generatedAt ?? null,
    readoutDate: live,
    rocks: queue.map((r) => ({
      id: r.id,
      title: r.title,
      owner: nameOf(r.owner),
      status: r.status,
      statusColor: r.statusColor ?? null,
      kpi: r.kpi ?? null,
      milestones: r.milestones ?? [],
      tactics: (r.tactics ?? []).map((t) => ({ id: t.id, title: t.title, status: t.status, startDate: t.startDate, checkInDate: t.checkInDate, owner: nameOf(t.owner) })),
    })),
    course,
    plan,
    tickets,
    backfilled: ledger.backfilled ?? false,
  };
}

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "plan" } });
  const store = await Store.open({ config, logger });
  const planStore = new QuarterPlanStore(store.backend, logger);
  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      const quarter = url.searchParams.get("quarter") || quarterOfKey(zonedDateKey(new Date(), config.system.timezone));
      QuarterPlanStore.key(quarter);
      return json(await payload({ config, store, planStore, quarter, logger }));
    }
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const quarter = body.quarter || quarterOfKey(zonedDateKey(new Date(), config.system.timezone));
      await planStore.apply(quarter, body.change ?? {}, { expectedVersion: body.version, actor: "dashboard" });
      return json(await payload({ config, store, planStore, quarter, logger }));
    }
    return json({ error: "GET or POST." }, 405);
  } catch (err) {
    if (err instanceof PlanError) return json({ error: err.message }, err.status);
    logger.error("plan.failed", { err });
    return json({ error: err.message }, 500);
  }
};

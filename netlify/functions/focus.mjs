// Today's rock moves. See src/focus/moves.js.
//
//   GET  /focus                 today's picked moves, suggestions for more, this week's
//                               tally and the tickets on rocks Alex shipped this week
//   POST /focus  { change }     { pick: {id} }               a suggestion, looked up here
//                               { pick: {text, rockId} }     Alex's own move on a rock
//                               either with start: true      picked and started at once
//                               { start: id }                started now
//                               { done: id, note? } | { undo: id } | { remove: id }
//
// A picked suggestion is resolved on the server from the latest readout, so what is
// stored as its impact is what the rocks and ClickUp say, never what the page sent.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";
import { dateKey as zonedDateKey } from "../../src/lib/time.js";
import { QuarterPlanStore } from "../../src/store/quarter-plan.js";
import { FocusStore, FocusError, suggestions, shippedOnRocks, impactOf } from "../../src/focus/moves.js";
import { quarterOfKey, weekStartOf } from "../../public/quarter.js";

async function context({ config, store, today }) {
  const report = await store.getLatestReport({});
  const plan = await new QuarterPlanStore(store.backend).read(quarterOfKey(today)).catch(() => ({ items: [] }));
  return { report, plan };
}

async function payload({ config, store, focus, today }) {
  const tz = config.system.timezone;
  const alex = config.people?.alex ?? {};
  const { report, plan } = await context({ config, store, today });
  const day = await focus.read(today);
  const rocks = (report?.detail?.leadership?.queue ?? []).filter((r) => r.state === "active" && !r.bau);
  return {
    today,
    readoutAt: report?.generatedAt ?? null,
    picks: day.picks,
    suggestions: suggestions({ report, plan, dateKey: today, timeZone: tz, alex, picked: day.picks }),
    week: await focus.week(today),
    shipped: shippedOnRocks({ report, from: weekStartOf(today), to: today, timeZone: tz, alex }),
    rocks: rocks.map((r) => ({ id: r.id, title: r.title })),
  };
}

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "focus" } });
  const store = await Store.open({ config, logger });
  const focus = new FocusStore(store.backend, logger);
  const tz = config.system.timezone;
  const today = zonedDateKey(new Date(), tz);

  try {
    if (req.method === "GET") return json(await payload({ config, store, focus, today }));
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const change = body.change ?? {};
      if (change.pick) {
        const { report, plan } = await context({ config, store, today });
        const rocks = (report?.detail?.leadership?.queue ?? []).filter((r) => r.state === "active" && !r.bau);
        if (change.pick.id && !String(change.pick.id).startsWith("own:")) {
          const day = await focus.read(today);
          const all = suggestions({ report, plan, dateKey: today, timeZone: tz, alex: config.people?.alex ?? {}, picked: day.picks, limit: 100 });
          const move = all.find((m) => m.id === String(change.pick.id));
          if (!move) throw new FocusError("That suggestion is no longer on offer. Reload and try again.", 409);
          await focus.apply(today, { pick: move, start: Boolean(change.start) });
        } else {
          const rock = rocks.find((r) => r.id === String(change.pick.rockId ?? ""));
          if (!rock) throw new FocusError("Which rock does it move?");
          const course = (report?.detail?.rockCourse ?? []).find((c) => c.id === rock.id) ?? null;
          await focus.apply(today, { pick: { text: change.pick.text, source: "own", why: "Your own move", impact: impactOf(rock, course, today) }, start: Boolean(change.start) });
        }
      } else {
        await focus.apply(today, change);
      }
      logger.info("focus.changed", { kind: Object.keys(change)[0] ?? null });
      return json(await payload({ config, store, focus, today }));
    }
    return json({ error: "GET or POST." }, 405);
  } catch (err) {
    if (err instanceof FocusError) return json({ error: err.message }, err.status);
    logger.error("focus.failed", { err });
    return json({ error: err.message }, 500);
  }
};

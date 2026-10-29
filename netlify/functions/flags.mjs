// Triage on a flag: done, snoozed, waiting on someone, or not a problem.
//
//   GET  /flags   { today, entries }   every flag's age and triage as it stands
//   POST /flags   { key, layer, status, workingDays?, calendarDays?, waitingOn?, note? }
//                 status null clears the triage (undo)
//
// Writes only to this system's own storage. Nothing here touches ClickUp, Intelligems or
// Slack.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { dateKey } from "../../src/lib/time.js";
import { FlagLedger, FlagLedgerError } from "../../src/store/flag-ledger.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "flags" } });
  const store = await Store.open({ config, logger });
  const ledger = new FlagLedger(store.backend, logger);
  const today = dateKey(new Date(), config.system.timezone);

  try {
    if (req.method === "GET") {
      const doc = await ledger.read();
      return json({ today, entries: doc.entries });
    }
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const entry = await ledger.setTriage(String(body.key ?? ""), {
        status: body.status ?? null,
        workingDays: body.workingDays,
        calendarDays: body.calendarDays,
        waitingOn: body.waitingOn,
        note: body.note,
      }, {
        today,
        workingWeekdays: config.system.schedule?.workingWeekdays,
        layer: body.layer ?? null,
        defaultWaitingDays: config.system.flags?.waitingCheckBackWorkingDays ?? 2,
      });
      logger.info("flags.triaged", { key: body.key, status: body.status ?? null });
      return json({ ok: true, key: body.key, entry, today });
    }
    return json({ error: "method not allowed" }, 405);
  } catch (err) {
    if (err instanceof FlagLedgerError) return json({ error: err.message }, 409);
    logger.error("flags.failed", { err });
    return json({ error: err.message }, 500);
  }
};

// Sets a ticket's due date in ClickUp, from "Set due date" on a flag card.
//
//   POST /ticket-due   { taskId, date: "YYYY-MM-DD" }
//
// Narrow on purpose: only the due date, only on an open ticket the latest readout holds,
// only today through a year out. Every write is recorded under clickup/writes/.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";
import { setDueDate } from "../../src/send/clickup-due.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  if (req.method !== "POST") return json({ error: "POST only." }, 405);
  const config = loadConfig();
  const logger = createLogger({ base: { fn: "ticket-due" } });
  const store = await Store.open({ config, logger });
  const body = await req.json().catch(() => ({}));
  try {
    return json(await setDueDate({ config, store, logger, token: process.env.CLICKUP_TOKEN, taskId: body.taskId, date: body.date }));
  } catch (err) {
    logger.warn("ticket_due.refused", { err });
    return json({ error: err.message }, err.status ?? 500);
  }
};

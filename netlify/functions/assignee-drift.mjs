// Done tickets that changed hands this sprint, and putting one back.
//
//   GET  /assignee-drift                 { since, snapshots, tickets: [{ id, name, url, firstSeen, was, now }] }
//   POST /assignee-drift { taskId }      put that ticket back on who it had when it came onto
//                                        the sprint (only a ticket the check flags right now)
//
// See src/delta/assignee-drift.js and restoreAssignees in src/send/clickup-assignee.js.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";
import { sprintDriftFromStore } from "../../src/delta/assignee-drift.js";
import { restoreAssignees } from "../../src/send/clickup-assignee.js";
import { zonedParts, shiftDateKey } from "../../src/lib/time.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  const config = loadConfig();
  const logger = createLogger({ base: { fn: "assignee-drift" } });
  const store = await Store.open({ config, logger });
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      return json(await restoreAssignees({ config, store, logger, token: process.env.CLICKUP_TOKEN, taskId: body.taskId }));
    }
    return json(await sprintDriftFromStore({ store, config, zonedParts, shiftDateKey }));
  } catch (err) {
    logger.warn("assignee_drift.failed", { err });
    return json({ error: err.message }, err.status ?? 500);
  }
};

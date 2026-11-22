// Sets a ticket's TACTIC field in ClickUp, from Done Tickets Hygiene.
//
//   GET  /ticket-tactic                                   { fieldId, options: [{ id, label }] }
//   POST /ticket-tactic { taskIds: [...], optionId }      set TACTIC to that option
//
// See src/send/clickup-tactic.js for what it may and may not do.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";
import { setTactic, tacticOptions } from "../../src/send/clickup-tactic.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  const config = loadConfig();
  const logger = createLogger({ base: { fn: "ticket-tactic" } });
  const store = await Store.open({ config, logger });
  const token = process.env.CLICKUP_TOKEN;
  try {
    if (req.method === "GET") return json(await tacticOptions({ config, store, logger, token }));
    if (req.method !== "POST") return json({ error: "GET or POST." }, 405);
    const body = await req.json().catch(() => ({}));
    const result = await setTactic({ config, store, logger, token, taskIds: body.taskIds, optionId: body.optionId });
    return json({ ok: result.failed.length === 0, ...result }, result.set.length ? 200 : 502);
  } catch (err) {
    logger.warn("ticket_tactic.refused", { err });
    return json({ error: err.message }, err.status ?? 500);
  }
};

// Sets a ticket's Task Owner in ClickUp, from the "no Task Owner" card on What needs you.
//
//   POST /ticket-owner   { taskIds: ["abc", ...], ownerId: "<ClickUp user id>" }
//
// The one ClickUp write this app makes, and deliberately narrow: only the Task Owner
// field, only to add a person, only someone on the roster in config/people.json, and only
// on tickets that the latest readout shows with no Task Owner. Nothing is removed, so a
// ticket that gained an owner in the meantime keeps it and gets a second one rather than
// losing the first. Every write is recorded in this app's storage with who it was set to.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";
import { setTaskOwner } from "../../src/send/clickup-owner.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  if (req.method !== "POST") return json({ error: "POST only." }, 405);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "ticket-owner" } });
  const store = await Store.open({ config, logger });
  const body = await req.json().catch(() => ({}));

  try {
    const result = await setTaskOwner({ config, store, logger, token: process.env.CLICKUP_TOKEN, taskIds: body.taskIds, ownerId: body.ownerId });
    return json({ ok: result.failed.length === 0, ...result }, result.set.length ? 200 : 502);
  } catch (err) {
    logger.warn("ticket_owner.refused", { err });
    return json({ error: err.message }, err.status ?? 500);
  }
};

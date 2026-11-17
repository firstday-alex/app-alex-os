// Assigns someone to a ticket in ClickUp, from the "nobody assigned" card on What needs you.
//
//   POST /ticket-assignee   { taskIds: ["abc", ...], assigneeId: "<ClickUp user id>" }
//
// The one ClickUp write this app makes, and deliberately narrow: only adds an assignee,
// only someone on the roster in config/people.json, and only on tickets that the latest
// readout shows with nobody assigned. Nothing is removed, so a ticket that gained an
// assignee in the meantime keeps them. Every write is recorded in this app's storage.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";
import { setAssignee } from "../../src/send/clickup-assignee.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  if (req.method !== "POST") return json({ error: "POST only." }, 405);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "ticket-assignee" } });
  const store = await Store.open({ config, logger });
  const body = await req.json().catch(() => ({}));

  try {
    const result = await setAssignee({ config, store, logger, token: process.env.CLICKUP_TOKEN, taskIds: body.taskIds, assigneeId: body.assigneeId });
    return json({ ok: result.failed.length === 0, ...result }, result.set.length ? 200 : 502);
  } catch (err) {
    logger.warn("ticket_assignee.refused", { err });
    return json({ error: err.message }, err.status ?? 500);
  }
};

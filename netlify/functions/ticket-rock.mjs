// Sets a ticket's ROCK field in ClickUp, from "Set ROCK" on a flag card in the dashboard.
//
//   POST /ticket-rock   { taskIds: ["abc", ...], rockId: "<rock id from the readout>" }
//
// Narrow on purpose: only the ROCK field, only to a rock that is active in the latest
// readout and has a ClickUp option, and only on tickets the latest readout holds. Every
// write is recorded under clickup/writes/ in this app's storage.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";
import { setRock } from "../../src/send/clickup-rock.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  if (req.method !== "POST") return json({ error: "POST only." }, 405);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "ticket-rock" } });
  const store = await Store.open({ config, logger });
  const body = await req.json().catch(() => ({}));

  try {
    const result = await setRock({ config, store, logger, token: process.env.CLICKUP_TOKEN, taskIds: body.taskIds, rockId: body.rockId });
    return json({ ok: result.failed.length === 0, ...result }, result.set.length ? 200 : 502);
  } catch (err) {
    logger.warn("ticket_rock.refused", { err });
    return json({ error: err.message }, err.status ?? 500);
  }
};

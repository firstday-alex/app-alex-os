// The rocks API. Layer 1's data, read and written from the dashboard.
//
//   GET    /rocks              list, with the current version for optimistic concurrency
//   GET    /rocks?audit=true   the change trail
//   POST   /rocks              create or update one rock
//   DELETE /rocks?id=...       remove one
//
// Every write carries the version it was based on. A stale version is rejected rather
// than silently overwriting someone else's change.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { RocksStore, RockValidationError, STATES } from "../../src/store/rocks.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "rocks" } });
  const store = await Store.open({ config, logger });
  const rocks = new RocksStore(store.backend, logger);
  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      if (url.searchParams.get("audit") === "true") {
        return json({ audit: await rocks.auditTrail({ limit: 30 }) });
      }
      const seed = [...(config.leadershipQueue?.queue ?? []), ...(config.leadershipQueue?.backlog ?? [])];
      const listed = await rocks.list({ seed });
      return json({
        ...listed,
        states: STATES,
        // The roster and the ClickUp dropdown options, so the dashboard can offer real
        // choices instead of free text.
        people: (config.people?.team ?? []).filter((p) => p.clickupUserId).map((p) => ({ id: String(p.clickupUserId), name: p.name })),
      });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const rock = await rocks.upsert(body.rock ?? body, { expectedVersion: body.version, actor: "dashboard" });
      const listed = await rocks.list();
      return json({ ok: true, rock, version: listed.version, rocks: listed.rocks });
    }

    if (req.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id is required" }, 400);
      const version = url.searchParams.get("version");
      await rocks.remove(id, { expectedVersion: version == null ? undefined : Number(version) });
      const listed = await rocks.list();
      return json({ ok: true, version: listed.version, rocks: listed.rocks });
    }

    return json({ error: "method not allowed" }, 405);
  } catch (err) {
    if (err instanceof RockValidationError) {
      logger.warn("rocks.rejected", { field: err.field, message: err.message });
      return json({ error: err.message, field: err.field }, 409);
    }
    logger.error("rocks.failed", { err });
    return json({ error: err.message }, 500);
  }
};

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
import { RocksStore, RockValidationError, STATES, STATUSES, STATUS_LABELS } from "../../src/store/rocks.js";
import { fetchFieldMap } from "../../src/collectors/clickup.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";

/**
 * The options on the ClickUp dropdown a rock can be linked to.
 *
 * Read through the cached field map, so this costs one ClickUp request a day rather than
 * one per dashboard load. Failure is not fatal: without the options the editor falls back
 * to a plain text id, which is worse but still works.
 */
async function clickupOptionsFor(which, { config, store, logger }) {
  try {
    const map = await fetchFieldMap({ config, token: process.env.CLICKUP_TOKEN, store, logger });
    const field = map[which];
    if (!field) return { available: false, reason: `No ${which} field found on the sprint list.`, fieldId: null, options: [] };
    return {
      available: true,
      fieldId: field.id,
      fieldName: field.name,
      // The option table is indexed by uuid AND orderindex, so de-duplicate.
      options: [...new Map(Object.values(map.options?.[field.id] ?? {}).map((o) => [String(o.id), o])).values()]
        .sort((a, b) => (a.orderindex ?? 0) - (b.orderindex ?? 0))
        .map((o) => ({ id: String(o.id), label: o.label })),
    };
  } catch (err) {
    logger?.warn("rocks.clickup_options_failed", { which, err });
    return { available: false, reason: err.message, fieldId: null, options: [] };
  }
}

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
        statuses: STATUSES,
        statusLabels: STATUS_LABELS,
        // Real choices instead of free text: the roster for owners, and the live Rock
        // Reference options for the ClickUp link.
        people: (config.people?.team ?? []).filter((p) => p.clickupUserId).map((p) => ({ id: String(p.clickupUserId), name: p.name })),
        clickupOptions: await clickupOptionsFor("leadershipPriority", { config, store, logger }),
        bigSwingOptions: await clickupOptionsFor("bigSwing", { config, store, logger }),
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

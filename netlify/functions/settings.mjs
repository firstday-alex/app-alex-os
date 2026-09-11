// App-level settings: the LTV references the future-value projection rests on, and the
// significance thresholds the experiment tree judges against.
//
//   GET    /settings              current values, plus the schema that describes them
//   GET    /settings?audit=true   the change trail
//   POST   /settings              write, with optimistic concurrency

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { SettingsStore, SettingsValidationError } from "../../src/store/settings.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "settings" } });
  const store = await Store.open({ config, logger });
  const settings = new SettingsStore(store.backend, logger);
  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      if (url.searchParams.get("audit") === "true") {
        return json({ audit: await settings.auditTrail() });
      }
      return json(await settings.read());
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const written = await settings.write(body.settings ?? body, { expectedVersion: body.version });
      return json({ ok: true, ...written });
    }

    return json({ error: "method not allowed" }, 405);
  } catch (err) {
    if (err instanceof SettingsValidationError) {
      logger.warn("settings.rejected", { field: err.field, message: err.message });
      return json({ error: err.message, field: err.field }, 409);
    }
    logger.error("settings.failed", { err });
    return json({ error: err.message }, 500);
  }
};

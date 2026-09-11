// Exchanges the shared dashboard password for a signed session cookie.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { checkPassword, issueSession, json } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const logger = createLogger({ base: { fn: "login" } });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const expected = process.env.DASHBOARD_PASSWORD;
  const secret = process.env.DASHBOARD_COOKIE_SECRET;
  if (!expected || !secret) {
    return json({ error: "Dashboard auth is not configured. Set DASHBOARD_PASSWORD and DASHBOARD_COOKIE_SECRET." }, 500);
  }

  const { password } = await req.json().catch(() => ({}));
  if (!checkPassword(password, expected)) {
    logger.warn("login.rejected", {});
    return json({ error: "wrong password" }, 401);
  }

  const ttl = loadConfig().system.dashboard?.sessionTtlHours ?? 12;
  logger.info("login.ok", {});
  return json({ ok: true }, 200, { "set-cookie": issueSession(secret, ttl).header });
};

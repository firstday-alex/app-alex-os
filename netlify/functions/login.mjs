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
    // Naming the context matters more than it looks. These variables are commonly set
    // on production only, so the usual cause of this is a deploy-preview or
    // branch-deploy URL rather than anything actually being unset — and "not
    // configured" sends you to the settings page to look at a value that is already
    // there. Which variable is missing is safe to say; neither value is.
    const context = process.env.CONTEXT ?? "unknown";
    const missing = [!expected && "DASHBOARD_PASSWORD", !secret && "DASHBOARD_COOKIE_SECRET"].filter(Boolean);
    logger.error("login.not_configured", { context, missing });
    return json(
      {
        error: `Dashboard auth is not configured for the '${context}' deploy context: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set there.${context !== "production" ? " If you meant to use the live dashboard, open the production URL rather than this preview." : ""}`,
      },
      500,
    );
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

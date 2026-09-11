// Measure the LTV references from Shopify's cohort analysis, on demand.
//
// A button rather than part of the daily pipeline: it is two heavy cohort queries, the
// answer moves slowly, and Alex should see what it measured before it replaces the
// numbers every projection rests on. Measuring and saving are separate steps.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { measureLtv } from "../../src/collectors/ltv.js";
import { getAccessToken } from "../../src/collectors/shopify.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "measure-ltv" } });
  const store = await Store.open({ config, logger });

  try {
    const { horizonMonths } = await req.json().catch(() => ({}));
    const { token } = await getAccessToken({ config, store, logger });
    const result = await measureLtv({ config, token, store, logger, horizonMonths });

    logger.info("ltv.measured", {
      horizonMonths: result.horizonMonths,
      subscription: result.subscription.value,
      oneTime: result.oneTime.value,
      cohorts: result.subscription.cohorts,
    });
    return json(result);
  } catch (err) {
    logger.error("ltv.measure_failed", { err });
    return json({ error: err.message }, 500);
  }
};

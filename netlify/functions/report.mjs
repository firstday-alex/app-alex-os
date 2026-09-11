// Serves the latest report from storage. The dashboard's read path.
//
// Blobs has no query, so this reads the `reports/latest.json` pointer rather than listing
// the store.

import { loadConfig, openItems } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "report" } });
  const store = await Store.open({ config, logger });

  const url = new URL(req.url);
  const officialOnly = url.searchParams.get("official") === "true";

  const report = await store.getLatestReport({ officialOnly });
  if (!report) {
    return json({
      empty: true,
      message: "No readout has been produced yet. Run a refresh, or wait for the 8 AM send.",
      openItems: openItems(config),
    });
  }

  return json({
    empty: false,
    report,
    openItems: openItems(config),
    advisorButtonText: config.system.slack?.advisorButtonText ?? "Ask for recommendation",
  });
};

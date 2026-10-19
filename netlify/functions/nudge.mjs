// Nudge owner, from the dashboard.
//
//   POST /nudge   { key, layer, to, text }
//
// Posts the message, records it against the flag, and marks the flag as waiting on that
// person, so it leaves the list until the wait runs out and comes back if still raised.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { dateKey } from "../../src/lib/time.js";
import { FlagLedger } from "../../src/store/flag-ledger.js";
import { sendNudge, NudgeError } from "../../src/send/nudge.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "nudge" } });
  const store = await Store.open({ config, logger });
  const ledger = new FlagLedger(store.backend, logger);
  const today = dateKey(new Date(), config.system.timezone);
  const body = await req.json().catch(() => ({}));
  if (!body.key) return json({ error: "key is required" }, 400);

  try {
    const sent = await sendNudge({ config, env: process.env, store, logger, to: body.to, text: body.text, flagKey: body.key });
    await ledger.recordNudge(body.key, { at: new Date().toISOString(), to: sent.to, channel: sent.channel, ts: sent.ts }, { today, layer: body.layer ?? null });
    const entry = await ledger.setTriage(body.key, { status: "waiting", waitingOn: sent.to }, {
      today,
      workingWeekdays: config.system.schedule?.workingWeekdays,
      layer: body.layer ?? null,
      defaultWaitingDays: config.system.flags?.waitingCheckBackWorkingDays ?? 2,
    });
    return json({ ok: true, key: body.key, entry, sent, today });
  } catch (err) {
    if (err instanceof NudgeError) return json({ error: err.message }, 409);
    logger.error("nudge.failed", { err });
    return json({ error: err.message }, 502);
  }
};

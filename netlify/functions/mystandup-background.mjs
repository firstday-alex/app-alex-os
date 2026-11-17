// Writes My stand-up. A background function, so the Anthropic call has its 15 minute
// budget. Started only by /mystandup, on Alex's click. The 8 AM readout writes one by itself (morningStandup).

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { writeMyStandup as writeSpeech, MY_STANDUP_STATUS_KEY as SPEECH_STATUS_KEY } from "../../src/agents/my-standup.js";
import { isInternalCall } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const config = loadConfig();
  const logger = createLogger({ base: { fn: "mystandup-background" } });

  if (!isInternalCall(req)) {
    logger.warn("mystandup.unauthorized_invoke", {});
    return new Response("forbidden", { status: 403 });
  }

  const { startedAt } = await req.json().catch(() => ({}));
  const store = await Store.open({ config, logger });
  try {
    const result = await writeSpeech({ store, config, logger });
    await store.backend.set(
      SPEECH_STATUS_KEY,
      result.error ? { state: "failed", startedAt, error: result.error } : { state: "done", startedAt, finishedAt: result.generatedAt },
    );
  } catch (err) {
    logger.error("mystandup.failed", { err });
    await store.backend.set(SPEECH_STATUS_KEY, { state: "failed", startedAt, error: err.message });
  }
  return new Response("accepted", { status: 202 });
};

// The dashboard's "send a test readout" button.
//
// It exists because the parts of the 8 AM send that break are the parts a dry run cannot
// reach: whether the bot is still in the channel, whether a scope survived a reinstall,
// whether the rendered blocks are ones Slack will accept. Those only fail against the
// real Slack API, and finding out at 8 AM is finding out too late.
//
// So this posts for real, through the same sender the scheduled run uses, and differs in
// exactly two ways — both of which protect tomorrow morning:
//
//   1. mode is "test", never "official". Only an official snapshot enters the baseline
//      index, so a test at 3 PM cannot leave tomorrow comparing against this afternoon.
//   2. A non-official report neither checks nor claims the per-date Slack idempotence
//      key, so a test send cannot suppress the real 8 AM readout, and can be repeated.
//
// The message is labelled as a test in the header, the banner and the fallback text. It
// is going to a channel other people read, so it says what it is before it says anything
// else.

import { loadConfig } from "../../src/config.js";
import { createLogger, newRunId } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const config = loadConfig();
  const now = new Date();
  const runId = newRunId(now);
  const logger = createLogger({ runId, base: { fn: "test-readout" } });

  // Named rather than inferred: a button that posts to a shared channel should be
  // impossible to trigger by a stray request that merely reaches the URL.
  const payload = await req.json().catch(() => ({}));
  if (payload.confirm !== "send-test-readout") {
    return json({ started: false, reason: "This posts to Slack for real. Confirm from the dashboard." }, 400);
  }

  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_READOUT_CHANNEL) {
    return json(
      {
        started: false,
        reason: "Slack is not configured. SLACK_BOT_TOKEN and SLACK_READOUT_CHANNEL must both be set.",
      },
      400,
    );
  }

  // A posted message cannot be unposted, so the throttle is tighter than the refresh
  // button's and is about the channel rather than the API.
  const store = await Store.open({ config, logger });
  const minInterval = config.system.dashboard?.testReadoutMinIntervalSeconds ?? 300;
  const last = await store.backend.get("test-readout/last.json");
  if (last && now.getTime() - new Date(last.at).getTime() < minInterval * 1000) {
    const waitSeconds = Math.ceil((minInterval * 1000 - (now.getTime() - new Date(last.at).getTime())) / 1000);
    return json(
      {
        started: false,
        reason: `A test readout was sent ${Math.round((now - new Date(last.at)) / 1000)}s ago. Wait ${waitSeconds}s before posting to the channel again.`,
        runId: last.runId,
      },
      429,
    );
  }
  await store.backend.set("test-readout/last.json", { at: now.toISOString(), runId });

  const base = process.env.URL ?? process.env.DEPLOY_PRIME_URL ?? "http://localhost:8888";
  try {
    const response = await fetch(`${base}/.netlify/functions/run-pipeline-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mos-internal": process.env.DASHBOARD_COOKIE_SECRET ?? "" },
      body: JSON.stringify({ mode: "test", runId }),
      signal: AbortSignal.timeout(10000),
    });
    logger.info("test_readout.handed_off", { status: response.status, runId });
    return json(
      {
        started: true,
        runId,
        channel: process.env.SLACK_READOUT_CHANNEL,
        note: "Posting now. It takes as long as a refresh, because it pulls live data rather than replaying the last report.",
      },
      202,
    );
  } catch (err) {
    logger.error("test_readout.handoff_failed", { err });
    return json({ started: false, reason: err.message, runId }, 500);
  }
};

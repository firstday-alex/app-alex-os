// The Daily Speech tab's API.
//
//   GET  /speech   the last speech, and whether one is being written
//   POST /speech                       write a new one
//   POST /speech { called: key }       tick a win as called out (left off later lists)
//   POST /speech { uncalled: key }     untick it
//
// One Anthropic call, which can run past a normal function's limit, so POST hands it to
// speech-background and the tab polls GET until the stored speech is newer than the start.

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { SPEECH_KEY, SPEECH_STATUS_KEY, CELEBRATED_KEY } from "../../src/agents/daily-speech.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";

// A run that has not finished in this long has died. Let the button work again.
const RUNNING_FOR_AT_MOST_MS = 10 * 60 * 1000;

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "speech" } });
  const store = await Store.open({ config, logger });
  const [latest, status, celebrated] = await Promise.all([store.backend.get(SPEECH_KEY), store.backend.get(SPEECH_STATUS_KEY), store.backend.get(CELEBRATED_KEY)]);
  const running = status?.state === "running" && Date.now() - new Date(status.startedAt).getTime() < RUNNING_FOR_AT_MOST_MS;

  if (req.method === "GET") return json({ latest: latest ?? null, status: status ? { ...status, running } : null, celebrated: celebrated?.items ?? {} });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const body = await req.json().catch(() => ({}));
  const key = String(body.called ?? body.uncalled ?? "");
  if (key) {
    if (!/^(task|change):[A-Za-z0-9]{1,40}$/.test(key)) return json({ error: "Which win?" }, 400);
    const doc = celebrated ?? { items: {} };
    doc.items ??= {};
    if (body.called) {
      const win = (latest?.wins ?? []).find((w) => w.key === key);
      doc.items[key] = { at: new Date().toISOString(), title: win?.title ?? null };
    } else delete doc.items[key];
    // A sprint is two weeks; older ticks are dropped.
    const cutoff = Date.now() - 45 * 86_400_000;
    for (const [k, v] of Object.entries(doc.items)) if (Date.parse(v.at) < cutoff) delete doc.items[k];
    await store.backend.set(CELEBRATED_KEY, doc);
    return json({ ok: true, celebrated: doc.items });
  }

  if (running) return json({ started: false, reason: "A speech is already being written.", status }, 409);

  const startedAt = new Date().toISOString();
  await store.backend.set(SPEECH_STATUS_KEY, { state: "running", startedAt });
  const base = process.env.URL ?? process.env.DEPLOY_PRIME_URL ?? "http://localhost:8888";
  try {
    const response = await fetch(`${base}/.netlify/functions/speech-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mos-internal": process.env.DASHBOARD_COOKIE_SECRET ?? "" },
      body: JSON.stringify({ startedAt }),
      signal: AbortSignal.timeout(10000),
    });
    logger.info("speech.handed_off", { status: response.status });
    return json({ started: true, startedAt }, 202);
  } catch (err) {
    logger.error("speech.handoff_failed", { err });
    await store.backend.set(SPEECH_STATUS_KEY, { state: "failed", startedAt, error: err.message });
    return json({ started: false, reason: err.message }, 500);
  }
};

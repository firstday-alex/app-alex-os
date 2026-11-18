// Alex's to-dos from Slack for Today's moves. See src/collectors/slack-todos.js.
//
//   GET  /slack-todos                       asks, reminders and saved messages, read live
//   POST /slack-todos  { done: key }        hide one here (only its hash is kept)
//   POST /slack-todos  { done: key, reminderId }   also complete the reminder in Slack
//   POST /slack-todos  { undo: key }        bring one back

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";
import { slackTodos, completeReminder } from "../../src/collectors/slack-todos.js";

const DONE_KEY = "slack/todos-done.json";
const KEEP_DAYS = 30;

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  const config = loadConfig();
  const logger = createLogger({ base: { fn: "slack-todos" } });
  const store = await Store.open({ config, logger });
  const read = async () => (await store.backend.get(DONE_KEY)) ?? { done: {} };

  try {
    if (req.method === "GET") {
      const doc = await read();
      return json(await slackTodos({ config, logger, done: new Set(Object.keys(doc.done ?? {})) }));
    }
    if (req.method !== "POST") return json({ error: "GET or POST." }, 405);
    const body = await req.json().catch(() => ({}));
    const doc = await read();
    const key = String(body.done ?? body.undo ?? "");
    if (!/^(ask|reminder|saved|list):[0-9a-f]{16}$/.test(key)) return json({ error: "Which item?" }, 400);
    if (body.done) {
      if (body.reminderId) await completeReminder({ config, logger, reminderId: body.reminderId });
      doc.done[key] = new Date().toISOString();
    } else delete doc.done[key];
    // Old marks fall away: an item past its window is not shown again anyway.
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
    for (const [k, at] of Object.entries(doc.done)) if (Date.parse(at) < cutoff) delete doc.done[k];
    await store.backend.set(DONE_KEY, doc);
    return json({ ok: true });
  } catch (err) {
    logger.warn("slack_todos.failed", { err });
    return json({ error: err.message }, err.status ?? 500);
  }
};

// Alex's to-dos from Slack for Today's moves. See src/collectors/slack-todos.js.
//
//   GET  /slack-todos                              reminders, the ECOM list and saved messages, read live
//   POST /slack-todos  { dismiss: key }            hide one here for today; it is back tomorrow
//   POST /slack-todos  { done: key, reminderId }   complete the reminder in Slack
//   POST /slack-todos  { done: key }               hide one here for good (only its hash is kept)
//   POST /slack-todos  { undo: key }               bring one back
//   POST /slack-todos  { edit: { key, action, value } }   change an ECOM list row in Slack:
//                      action due | checkIn (a date), assignee (a roster name), complete
//                      (src/send/slack-list-edit.js)

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";
import { slackTodos, completeReminder } from "../../src/collectors/slack-todos.js";
import { editListItem } from "../../src/send/slack-list-edit.js";

const DONE_KEY = "slack/todos-done.json";
const KEEP_DAYS = 30;
const KEY = /^(todo|reminder|saved|list):[0-9a-f]{16}$/;

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);
  const config = loadConfig();
  const logger = createLogger({ base: { fn: "slack-todos" } });
  const store = await Store.open({ config, logger });
  const read = async () => {
    const doc = (await store.backend.get(DONE_KEY)) ?? {};
    return { done: doc.done ?? {}, dismissed: doc.dismissed ?? {} };
  };
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: config.system?.timezone ?? "UTC" }).format(new Date());

  try {
    if (req.method === "GET") {
      const doc = await read();
      const hidden = [...Object.keys(doc.done), ...Object.entries(doc.dismissed).filter(([, day]) => day === today).map(([k]) => k)];
      return json(await slackTodos({ config, logger, done: new Set(hidden) }));
    }
    if (req.method !== "POST") return json({ error: "GET or POST." }, 405);
    const body = await req.json().catch(() => ({}));
    if (body.edit) return json(await editListItem({ config, logger, store, key: body.edit.key, action: body.edit.action, value: body.edit.value }));

    const doc = await read();
    const key = String(body.done ?? body.dismiss ?? body.undo ?? "");
    if (!KEY.test(key)) return json({ error: "Which item?" }, 400);
    if (body.dismiss) doc.dismissed[key] = today;
    else if (body.done) {
      if (body.reminderId) await completeReminder({ config, logger, reminderId: body.reminderId });
      doc.done[key] = new Date().toISOString();
    } else {
      delete doc.done[key];
      delete doc.dismissed[key];
    }
    // Old marks fall away: an item past its window is not shown again anyway.
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
    for (const [k, at] of Object.entries(doc.done)) if (Date.parse(at) < cutoff) delete doc.done[k];
    for (const [k, day] of Object.entries(doc.dismissed)) if (day < today) delete doc.dismissed[k];
    await store.backend.set(DONE_KEY, doc);
    return json({ ok: true });
  } catch (err) {
    logger.warn("slack_todos.failed", { err });
    return json({ error: err.message }, err.status ?? 500);
  }
};

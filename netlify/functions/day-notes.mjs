// Notes from the day, for the Daily Speech.
//
//   GET    /day-notes                 the notes the next speech will read
//   POST   /day-notes   { text }      add one, dated today (Central)
//   DELETE /day-notes   { id, dateKey }  remove one

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { addNote, removeNote, notesForSpeech, noteKeysForSpeech, DayNoteError } from "../../src/store/day-notes.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "day-notes" } });
  const store = await Store.open({ config, logger });
  const now = new Date();

  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const note = await addNote(store.backend, { text: body.text, now, config });
      return json({ ok: true, note });
    }
    if (req.method === "DELETE") {
      const body = await req.json().catch(() => ({}));
      if (!body.id || !body.dateKey) return json({ error: "id and dateKey are required" }, 400);
      return json({ ok: await removeNote(store.backend, body) });
    }
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    const keys = noteKeysForSpeech(now, config);
    return json({ from: keys[0], to: keys[keys.length - 1], notes: await notesForSpeech(store.backend, { now, config }) });
  } catch (err) {
    if (err instanceof DayNoteError) return json({ error: err.message }, 400);
    logger.error("day_notes.failed", { err });
    return json({ error: err.message }, 500);
  }
};

// Per-test metadata. One document for every test, so a page load costs one fetch.
//
//   GET  /test-notes            every note, plus the version for optimistic concurrency
//   POST /test-notes            { experienceId, note: {...}, version }

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { TestNotesStore, TestNoteError, FIELDS } from "../../src/store/test-notes.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";

export default async (req) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return unauthorized(auth.reason);

  const config = loadConfig();
  const logger = createLogger({ base: { fn: "test-notes" } });
  const store = await Store.open({ config, logger });
  const notes = new TestNotesStore(store.backend, logger);

  try {
    if (req.method === "GET") {
      const doc = await notes.readAll();
      return json({ version: doc.version ?? 0, notes: doc.notes ?? {}, fields: FIELDS });
    }
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (!body.experienceId) return json({ error: "experienceId is required" }, 400);
      const result = await notes.put(body.experienceId, body.note ?? {}, { expectedVersion: body.version });
      return json({ ok: true, ...result });
    }
    return json({ error: "method not allowed" }, 405);
  } catch (err) {
    if (err instanceof TestNoteError) {
      logger.warn("test_notes.rejected", { field: err.field, message: err.message });
      return json({ error: err.message, field: err.field }, 409);
    }
    logger.error("test_notes.failed", { err });
    return json({ error: err.message }, 500);
  }
};

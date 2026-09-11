// Per-test metadata. One document for every test, so a page load costs one fetch.
//
//   GET  /test-notes            every note, plus the version for optimistic concurrency
//   POST /test-notes            { experienceId, note: {...}, version }

import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/lib/logger.js";
import { Store } from "../../src/lib/storage.js";
import { TestNotesStore, TestNoteError, FIELDS } from "../../src/store/test-notes.js";
import { fetchTeamMembers } from "../../src/collectors/clickup.js";
import { isAuthorized, unauthorized, json } from "../../src/lib/dashboard-auth.js";

/**
 * Who a test can be assigned to.
 *
 * config/people.json first, because that is the curated sprint team. Falling back to the
 * whole ClickUp workspace gives 54 names, which is a worse list but a better outcome than
 * an empty dropdown that makes the feature look broken.
 */
async function rosterFor({ config, store, logger }) {
  const team = (config.people?.team ?? []).filter((p) => p.clickupUserId != null);
  if (team.length) {
    return team.map((p) => ({ id: String(p.clickupUserId), name: p.name, source: "roster" }));
  }
  try {
    const members = await fetchTeamMembers({ config, token: process.env.CLICKUP_TOKEN, logger });
    return members.map((m) => ({ id: String(m.id), name: m.username ?? m.email ?? m.id, source: "workspace" }));
  } catch (err) {
    logger?.warn?.("test_notes.roster_failed", { err });
    return [];
  }
}

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
      return json({
        version: doc.version ?? 0,
        notes: doc.notes ?? {},
        fields: FIELDS,
        // The people a test can be assigned to. From config when the roster is filled in,
        // otherwise from the ClickUp workspace, so the dropdown is never empty.
        assignees: await rosterFor({ config, store, logger }),
      });
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

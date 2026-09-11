// Per-test metadata: what you thought before the test, what you noticed during it, and
// what you decided.
//
// Deliberately small. All notes for all tests live in ONE document, so reading them costs
// one storage fetch on a page that already makes several, and a test with no note costs
// nothing at all — absent keys, not empty rows.
//
// This is the one place in the system that holds something Intelligems cannot: the
// reasoning. A verdict tells you a variant lost. Only the hypothesis tells you what you
// believed would happen, which is the difference between a result and a lesson.

const DOC_KEY = "test-notes/index.json";
const MAX_FIELD = 4000;

export class TestNoteError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "TestNoteError";
    this.field = field;
  }
}

export const FIELDS = {
  hypothesis: { label: "Hypothesis", help: "What you expected to happen, written before you looked." },
  notes: { label: "Notes", help: "What you have noticed while it runs." },
  decision: { label: "Decision", help: "What you decided, and why. Filled in when the test ends." },
};

const TAG_RE = /^[a-z0-9][a-z0-9 _-]{0,28}$/i;

export function normalizeNote(input, existing = {}) {
  const out = {};
  for (const key of Object.keys(FIELDS)) {
    const raw = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : existing[key];
    const text = raw == null ? "" : String(raw).trim();
    if (text.length > MAX_FIELD) {
      throw new TestNoteError(`${FIELDS[key].label} is longer than ${MAX_FIELD} characters.`, key);
    }
    // Empty means absent. Storing "" for every field on every test is how a small
    // document stops being small.
    if (text) out[key] = text;
  }

  const rawTags = Array.isArray(input.tags) ? input.tags : existing.tags ?? [];
  const tags = [...new Set(rawTags.map((t) => String(t).trim()).filter(Boolean))];
  for (const tag of tags) {
    if (!TAG_RE.test(tag)) throw new TestNoteError(`"${tag}" is not a usable tag. Letters, numbers, spaces, - and _ only.`, "tags");
  }
  if (tags.length > 8) throw new TestNoteError("At most 8 tags.", "tags");
  if (tags.length) out.tags = tags;

  if (Object.keys(out).length === 0) return null; // nothing to store
  out.updatedAt = new Date().toISOString();
  out.updatedBy = input.updatedBy ?? existing.updatedBy ?? "dashboard";
  return out;
}

export class TestNotesStore {
  constructor(backend, logger) {
    this.backend = backend;
    this.logger = logger;
  }

  /** { version, notes: { [experienceId]: note } } */
  async readAll() {
    return (await this.backend.get(DOC_KEY)) ?? { version: 0, notes: {}, updatedAt: null };
  }

  async get(experienceId) {
    const doc = await this.readAll();
    return doc.notes?.[String(experienceId)] ?? null;
  }

  async put(experienceId, input, { expectedVersion, actor = "dashboard" } = {}) {
    const id = String(experienceId);
    if (!id) throw new TestNoteError("An experiment id is required.", "experienceId");

    const doc = await this.readAll();
    if (expectedVersion != null && doc.version !== expectedVersion) {
      throw new TestNoteError(
        `Notes changed since you loaded them (you had version ${expectedVersion}, the store is on ${doc.version}). Reload and reapply.`,
        "version",
      );
    }

    const note = normalizeNote({ ...input, updatedBy: actor }, doc.notes?.[id] ?? {});
    const notes = { ...(doc.notes ?? {}) };
    if (note) notes[id] = note;
    else delete notes[id]; // cleared to empty: remove the key rather than keep a husk

    const next = { version: (doc.version ?? 0) + 1, notes, updatedAt: new Date().toISOString() };
    await this.backend.set(DOC_KEY, next);
    this.logger?.info?.("test_notes.written", { experienceId: id, version: next.version, cleared: !note });
    return { version: next.version, note };
  }
}

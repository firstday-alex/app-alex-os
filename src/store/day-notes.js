// Notes from the day: whatever Alex jots or pastes (a Slack ask, a meeting takeaway, a
// hallway comment), one document per Central date. The Daily Speech reads every note from
// local midnight of the previous working day up to the moment it is written, so a note
// added Thursday afternoon is in Friday's speech, and Monday's reaches back to Friday.

import { dateKey, previousWorkingDayKey, shiftDateKey } from "../lib/time.js";

export const MAX_NOTE = 4000;
export const dayNotesKey = (key) => `notes/${key}.json`;

export class DayNoteError extends Error {}

/** The date keys a speech written at `now` reads: the previous working day through today. */
export function noteKeysForSpeech(now, config) {
  const today = dateKey(now, config.system.timezone);
  const keys = [];
  for (let k = previousWorkingDayKey(today, config.system.schedule?.workingWeekdays); k <= today; k = shiftDateKey(k, 1)) keys.push(k);
  return keys;
}

export async function addNote(backend, { text, source = null, now = new Date(), config }) {
  const clean = String(text ?? "").trim();
  if (!clean) throw new DayNoteError("The note is empty.");
  if (clean.length > MAX_NOTE) throw new DayNoteError(`A note can be at most ${MAX_NOTE} characters.`);
  const key = dateKey(now, config.system.timezone);
  const doc = (await backend.get(dayNotesKey(key))) ?? { dateKey: key, items: [] };
  const note = { id: `${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: now.toISOString(), text: clean, ...(source ? { source } : {}) };
  doc.items.push(note);
  await backend.set(dayNotesKey(key), doc);
  return { ...note, dateKey: key };
}

export async function removeNote(backend, { id, dateKey: key }) {
  const doc = await backend.get(dayNotesKey(key));
  if (!doc) return false;
  const before = doc.items.length;
  doc.items = doc.items.filter((n) => n.id !== id);
  if (doc.items.length === before) return false;
  await backend.set(dayNotesKey(key), doc);
  return true;
}

/** Every note the speech written now would read, oldest first. */
export async function notesForSpeech(backend, { now = new Date(), config }) {
  const docs = await Promise.all(noteKeysForSpeech(now, config).map((k) => backend.get(dayNotesKey(k)).catch(() => null)));
  return docs
    .filter(Boolean)
    .flatMap((d) => d.items.map((n) => ({ ...n, dateKey: d.dateKey })))
    .filter((n) => new Date(n.at) <= now)
    .sort((a, b) => a.at.localeCompare(b.at));
}

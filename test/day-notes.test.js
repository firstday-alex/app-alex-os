// Notes from the day: dated in Central time, and a speech reads from midnight of the
// previous working day up to the moment it is written.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createBackend } from "../src/lib/storage.js";
import { addNote, removeNote, notesForSpeech, noteKeysForSpeech } from "../src/store/day-notes.js";

const config = { system: { timezone: "America/Chicago", schedule: { workingWeekdays: [1, 2, 3, 4, 5] } } };

test("a speech reads the previous working day through today; Monday reaches back to Friday", () => {
  assert.deepEqual(noteKeysForSpeech(new Date("2026-11-06T15:00:00Z"), config), ["2026-11-05", "2026-11-06"]);
  assert.deepEqual(noteKeysForSpeech(new Date("2026-11-09T15:00:00Z"), config), ["2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"]);
});

test("notes are dated in Central time, read in order, and the day before yesterday drops off", async () => {
  const backend = await createBackend({ mode: "memory" });
  await addNote(backend, { text: "old", now: new Date("2026-11-04T18:00:00Z"), config });
  await addNote(backend, { text: "Sam asked for the holiday offer on bundles", now: new Date("2026-11-05T20:00:00Z"), config });
  // 10:30 PM Central on the 5th is still the 5th, though it is the 6th in UTC.
  const late = await addNote(backend, { text: "late one", now: new Date("2026-11-06T04:30:00Z"), config });
  assert.equal(late.dateKey, "2026-11-05");
  await addNote(backend, { text: "  today  ", now: new Date("2026-11-06T13:00:00Z"), config });

  const notes = await notesForSpeech(backend, { now: new Date("2026-11-06T15:00:00Z"), config });
  assert.deepEqual(notes.map((n) => n.text), ["Sam asked for the holiday offer on bundles", "late one", "today"]);

  assert.equal(await removeNote(backend, { id: late.id, dateKey: late.dateKey }), true);
  assert.equal((await notesForSpeech(backend, { now: new Date("2026-11-06T15:00:00Z"), config })).length, 2);
});

test("an empty or oversized note is refused", async () => {
  const backend = await createBackend({ mode: "memory" });
  await assert.rejects(addNote(backend, { text: "  ", config }), /empty/);
  await assert.rejects(addNote(backend, { text: "x".repeat(4001), config }), /at most/);
});

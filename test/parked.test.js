// Parked tickets: a marker in the title or a tag parks a ticket, its flags are dropped,
// and the marker stays out of the update text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { markParked, parkedMarkers, parkedReason, withoutMarkers } from "../src/delta/parked.js";

const markers = parkedMarkers({ system: { parked: { markers: ["waiting for test slot", "on track"] } } });

test("a marker in brackets or parentheses parks a ticket, in any case", () => {
  for (const name of [
    "[Waiting for Test Slot] benefits + offer",
    "(waiting for test slot) benefits + offer",
    "Benefits + offer (On Track)",
    "Benefits [ON TRACK]",
    "[ Waiting  for test slot ] spaced",
  ]) {
    assert.ok(parkedReason({ name }, markers), name);
  }
  assert.equal(parkedReason({ name: "[Waiting for Test Slot] benefits" }, markers), "Waiting for Test Slot");
});

test("the words without brackets, and other bracket labels, do not park", () => {
  for (const name of ["Get the funnel on track", "[DEV] Gifts at checkout", "[PEACHY] Bundle", "waiting for test slot"]) {
    assert.equal(parkedReason({ name }, markers), null, name);
  }
});

test("a ClickUp tag with the same words parks a ticket", () => {
  assert.equal(parkedReason({ name: "Benefits", tags: ["Waiting for test slot"] }, markers), "Waiting for test slot");
  assert.equal(parkedReason({ name: "Benefits", tags: ["urgent"] }, markers), null);
});

test("the markers come out of the title for the update text", () => {
  assert.equal(
    withoutMarkers("[Waiting for Test Slot] benefits + offer in the first image (on track)", markers),
    "benefits + offer in the first image",
  );
});

test("markParked labels the parked tickets and returns their ids", () => {
  const tasks = [{ id: "1", name: "[Waiting for Test Slot] A" }, { id: "2", name: "B" }];
  const ids = markParked(tasks, { system: {} });
  assert.deepEqual([...ids], ["1"]);
  assert.equal(tasks[0].parked, "Waiting for Test Slot");
  assert.equal(tasks[0].plainName, "A");
  assert.equal(tasks[1].parked, undefined);
});

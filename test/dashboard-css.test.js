// The dashboard stamps data straight into class attributes: a flag's severity, a task's
// signal, a significance tone. Those values are not class names anyone chose, so they can
// silently collide with a real rule — and a collision does not throw, it just renders
// wrong. `.info` did exactly that: every hygiene flag is `severity: "info"`, the tooltip
// button was `.info`, and so every hygiene flag rendered as a 14px circle with its text
// piled on top of itself.
//
// These tests assert the two things that keep that from recurring: data-derived classes
// are namespaced, and no bare rule in the stylesheet matches a value the data can take.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../src/config.js";

const app = fs.readFileSync(path.join(repoRoot, "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(repoRoot, "public", "styles.css"), "utf8");

/** Every bare single-class selector: `.foo { }` or `.foo,` but not `.a .b` or `.a.b`. */
function bareClasses(source) {
  const found = new Set();
  for (const match of source.matchAll(/(^|\n)\s*\.([a-z][a-z0-9_-]*)\s*(?=[{,])/gi)) {
    found.add(match[2]);
  }
  return found;
}

// The values the renderer can stamp into a class attribute.
const SEVERITIES = ["p1", "attention", "prompt", "info"];
const SIGNALS = ["moving", "waiting", "stalled", "idle"];
const TONES = ["good", "bad", "win", "loss", "flat", "none"];
const ROCK_STATUSES = ["on_track", "at_risk", "done"];

test("a flag's severity is namespaced, so it cannot collide with a global rule", () => {
  // Both places that build a flag element.
  const emitters = [...app.matchAll(/class="flag ([^"]*)"/g)].map((m) => m[1]);
  assert.ok(emitters.length >= 2, "expected every flag emitter to be found");

  for (const emitter of emitters) {
    for (const severity of SEVERITIES) {
      // `"prompt"` unprefixed is the bug; `sev-prompt` is the fix.
      const bare = new RegExp(`["\\s]${severity}["\\s]`);
      assert.ok(!bare.test(emitter), `flag class "${emitter}" stamps a bare severity`);
    }
  }
  assert.match(app, /class="flag sev-\$\{esc\(flag\.severity\)\}"/);
});

test("no bare stylesheet rule matches a value the data can take", () => {
  const bare = bareClasses(css);
  const dataValues = [...SEVERITIES, ...SIGNALS, ...TONES, ...ROCK_STATUSES];

  const collisions = dataValues.filter((value) => bare.has(value));
  assert.deepEqual(
    collisions,
    [],
    `these stylesheet rules would be applied to elements merely because the data said so: ${collisions.join(", ")}`,
  );
});

test("every class the stylesheet styles under .flag is one a flag can actually have", () => {
  // The other half of the rename: a rule for a severity that is never stamped is dead,
  // and dead severity rules are how a renamed class goes unnoticed.
  for (const match of css.matchAll(/\.flag\.sev-([a-z0-9_-]+)/g)) {
    assert.ok(SEVERITIES.includes(match[1]), `.flag.sev-${match[1]} matches no severity the pipeline emits`);
  }
});

/* --------------------------- the info popover clamp ---------------------------
   The popover is deliberately wider than the metric tile it hangs off, which means it
   can run off the right edge of the screen. Headless Chrome will not give a true narrow
   layout viewport, so the arithmetic is tested directly — against the block lifted out
   of the shipped file, so the test cannot drift from the code. */

function clampBlock() {
  const marker = "  // The popover is wider than its tile on purpose";
  const start = app.indexOf(marker);
  assert.ok(start > 0, "the clamp block is still in app.js");
  const end = app.indexOf("$(\"new-rock-btn\")");
  const body = app.slice(start, end).replace(/\}\);\s*$/, "");

  // `pop` and `document` are the only things the block touches.
  return new Function("pop", "document", body);
}

/** A popover `width` wide whose tile sits `tileLeft` from the left of a `room`-wide page. */
function runClamp({ room, tileLeft, width }) {
  const style = { left: "" };
  const pop = {
    style,
    getBoundingClientRect() {
      const offset = parseFloat(style.left) || 0;
      return { left: tileLeft + offset, right: tileLeft + offset + width };
    },
  };
  clampBlock()(pop, { documentElement: { clientWidth: room } });
  return pop.getBoundingClientRect();
}

test("a popover on a right-hand tile is pulled back inside the viewport", () => {
  // 340px popover hanging off a tile near the right edge of a 1000px page.
  const rect = runClamp({ room: 1000, tileLeft: 820, width: 340 });
  assert.ok(rect.right <= 1000 - 12, `right edge ${rect.right} is inside the 12px margin`);
  assert.ok(rect.left >= 0, "and it did not get yanked off the left");
});

test("a popover wider than the viewport pins to the left rather than off the other side", () => {
  // The order of the two corrections is the point: right first, then left. Reversed,
  // this case ends up hanging off the left edge instead of the right.
  const rect = runClamp({ room: 360, tileLeft: 150, width: 400 });
  assert.equal(rect.left, 12, "pinned to the left margin");
});

test("a popover with room to spare is left where it is", () => {
  const rect = runClamp({ room: 1400, tileLeft: 100, width: 340 });
  assert.equal(rect.left, 100, "no needless nudging");
});

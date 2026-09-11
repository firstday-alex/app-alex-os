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

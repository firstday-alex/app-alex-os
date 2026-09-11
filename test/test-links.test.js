// Linking out to Intelligems, and linking in to a specific test.
//
// The console path is not a guess: the Intelligems app's own bundle builds
// `/experiment/${id}` for an experiment and `/personalization/${id}` for a
// personalization. These tests pin that, and pin the deep-link parsing that lets a rock
// point at the readout for the test meant to prove it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { consoleUrl } from "../src/collectors/intelligems.js";
import { loadConfig, repoRoot } from "../src/config.js";

const config = loadConfig();

test("an experiment links to /experiment/<id> and a personalization to /personalization/<id>", () => {
  assert.equal(
    consoleUrl({ id: "ea60bd2d-bbc3-4438-8a03-bca2c090cd44", category: "experiment" }, config),
    "https://app.intelligems.io/experiment/ea60bd2d-bbc3-4438-8a03-bca2c090cd44",
  );
  assert.equal(
    consoleUrl({ id: "abc-123", category: "personalization" }, config),
    "https://app.intelligems.io/personalization/abc-123",
  );
});

test("the link never carries action=edit", () => {
  // The app appends it when opening its editor. A readout links you to look at a test,
  // never to change one, and this system does not write to any platform.
  const url = consoleUrl({ id: "abc-123", category: "experiment" }, config);
  assert.ok(!url.includes("action=edit"));
  assert.ok(!url.includes("?"));
});

test("an unknown category falls back to the experiment path rather than to nothing", () => {
  const url = consoleUrl({ id: "abc-123", category: "something-new" }, config);
  assert.equal(url, "https://app.intelligems.io/experiment/abc-123");
});

test("no id and no base produce no link, never a broken one", () => {
  assert.equal(consoleUrl({ category: "experiment" }, config), null);
  assert.equal(consoleUrl({ id: "abc" }, { intelligems: {} }), null);
});

test("an id is escaped into the path", () => {
  assert.match(consoleUrl({ id: "a b/c", category: "experiment" }, config), /a%20b%2Fc$/);
});

/* ------------------------------- deep links ------------------------------- */

const app = fs.readFileSync(path.join(repoRoot, "public", "app.js"), "utf8");

function parseHash() {
  const start = app.indexOf("function parseHash(hash) {");
  assert.ok(start > 0, "parseHash is still where the test expects it");
  const end = app.indexOf("\n}", start) + 2;
  return new Function(`${app.slice(start, end)}\n return parseHash;`)();
}

test("a bare view hash and a deep link both parse", () => {
  const parse = parseHash();
  assert.deepEqual(parse("#tests"), { name: "tests", target: null });
  assert.deepEqual(parse("#tests/ea60bd2d-bbc3"), { name: "tests", target: "ea60bd2d-bbc3" });
  assert.deepEqual(parse(""), { name: "readout", target: null });
  assert.deepEqual(parse("#"), { name: "readout", target: null });
});

test("an encoded id round-trips, so an id with a slash still resolves", () => {
  const parse = parseHash();
  assert.equal(parse(`#tests/${encodeURIComponent("a b/c")}`).target, "a b/c");
});

test("every test card carries its experience id, which is what a deep link resolves", () => {
  // Position would break the moment a test starts or ends. The id does not.
  assert.match(app, /data-test-id="\$\{esc\(test\.id\)\}"/);
  assert.match(app, /\.test-card\[data-test-id=/);
});

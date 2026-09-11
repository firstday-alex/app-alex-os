// Redaction at the logger level, Slack signature verification, and dashboard session
// handling. These guard the boundaries, so they get tested even though the spec's list
// only names redaction.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createLogger, redact, collectSecrets } from "../src/lib/logger.js";
import { verifySlackSignature } from "../src/send/slack.js";
import { issueSession, isAuthorized, checkPassword, isInternalCall } from "../src/lib/dashboard-auth.js";

const TOKEN = "pk_31415_TOKENVALUEGOESHERE";

test("a credential-shaped key is redacted by name", () => {
  const out = redact({ headers: { authorization: TOKEN, "intelligems-access-token": "x", accept: "application/json" } }, []);
  assert.equal(out.headers.authorization, "[REDACTED]");
  assert.equal(out.headers["intelligems-access-token"], "[REDACTED]");
  assert.equal(out.headers.accept, "application/json", "a harmless header is left alone");
});

test("a registered secret is scrubbed wherever it appears, including inside a URL", () => {
  const out = redact({ url: `https://api.example/x?token=${TOKEN}` }, [TOKEN]);
  assert.equal(out.url.includes(TOKEN), false);
});

test("an Error's message is scrubbed too, which is where a token usually escapes", () => {
  const out = redact({ err: new Error(`401 for ${TOKEN}`) }, [TOKEN]);
  assert.equal(out.err.message.includes(TOKEN), false);
  assert.equal(out.err.name, "Error");
});

test("a circular object does not break the logger", () => {
  const node = { name: "a" };
  node.self = node;
  const lines = [];
  const logger = createLogger({ sink: (line) => lines.push(line), secrets: [] });
  logger.info("cycle", { node });
  assert.ok(lines[0].includes("[Circular]"));
});

test("secrets are collected from the environment, and short values are ignored", () => {
  const secrets = collectSecrets({ CLICKUP_TOKEN: TOKEN, ANTHROPIC_API_KEY: "short", GITHUB_TOKEN: "ghp_abcdefghijkl" });
  assert.ok(secrets.includes(TOKEN));
  assert.ok(secrets.includes("ghp_abcdefghijkl"));
  assert.equal(secrets.includes("short"), false, "a 5-character value would scrub half the log");
});

/* ------------------------------ slack signing ------------------------------ */

function signed(secret, body, timestamp) {
  return `v0=${crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

test("a correctly signed Slack request is accepted", () => {
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000));
  const body = "payload=%7B%7D";
  const result = verifySlackSignature({ signingSecret: "s3cret", signature: signed("s3cret", body, timestamp), timestamp, rawBody: body, now });
  assert.equal(result.ok, true);
});

test("a tampered body is rejected", () => {
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000));
  const result = verifySlackSignature({
    signingSecret: "s3cret",
    signature: signed("s3cret", "original", timestamp),
    timestamp,
    rawBody: "tampered",
    now,
  });
  assert.equal(result.ok, false);
});

test("a replayed request outside the five minute window is rejected", () => {
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000) - 3600);
  const result = verifySlackSignature({ signingSecret: "s3cret", signature: signed("s3cret", "b", timestamp), timestamp, rawBody: "b", now });
  assert.equal(result.ok, false);
  assert.match(result.reason, /five minute window/);
});

test("a missing signing secret fails closed", () => {
  assert.equal(verifySlackSignature({ signingSecret: undefined, signature: "v0=x", timestamp: "1", rawBody: "b" }).ok, false);
});

/* ----------------------------- dashboard auth ----------------------------- */

const asRequest = (headers) => ({ headers: { get: (name) => headers[name.toLowerCase()] ?? null } });

test("a valid session cookie is authorized", () => {
  const session = issueSession("cookie-secret", 12);
  assert.equal(isAuthorized(asRequest({ cookie: `mos_session=${session.value}` }), { DASHBOARD_COOKIE_SECRET: "cookie-secret" }).ok, true);
});

test("a forged session cookie is rejected", () => {
  const forged = `${Date.now() + 100000}.notarealsignature`;
  assert.equal(isAuthorized(asRequest({ cookie: `mos_session=${forged}` }), { DASHBOARD_COOKIE_SECRET: "cookie-secret" }).ok, false);
});

test("an expired session is rejected", () => {
  const expired = issueSession("cookie-secret", -1);
  const result = isAuthorized(asRequest({ cookie: `mos_session=${expired.value}` }), { DASHBOARD_COOKIE_SECRET: "cookie-secret" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /expired/);
});

test("no session, and no configured secret, both fail closed", () => {
  assert.equal(isAuthorized(asRequest({}), { DASHBOARD_COOKIE_SECRET: "s" }).ok, false);
  assert.equal(isAuthorized(asRequest({ cookie: "mos_session=x.y" }), {}).ok, false);
});

test("the password check is length-safe against a wrong-length guess", () => {
  assert.equal(checkPassword("hunter2", "hunter2"), true);
  assert.equal(checkPassword("hunter", "hunter2"), false);
  assert.equal(checkPassword("hunter2", undefined), false);
});

test("the internal pipeline invoke cannot be triggered from outside", () => {
  const env = { DASHBOARD_COOKIE_SECRET: "internal-secret" };
  assert.equal(isInternalCall(asRequest({ "x-mos-internal": "internal-secret" }), env), true);
  assert.equal(isInternalCall(asRequest({ "x-mos-internal": "guess" }), env), false);
  assert.equal(isInternalCall(asRequest({}), env), false);
  assert.equal(isInternalCall(asRequest({ "x-mos-internal": "anything" }), {}), false, "no secret set means nobody gets in");
});

/* --------------------------- config path resolution --------------------------- */

test("the repo root is discovered by finding config, not by counting directories", async () => {
  // This broke production. src/config.js computed the root as one level up from its own
  // file, which is right from source and wrong once esbuild inlines it into
  // netlify/functions/*.mjs: the same arithmetic landed on /var/task/netlify while the
  // config had shipped to /var/task/config. Every function 502'd on the first config read.
  const { repoRoot, loadConfig } = await import("../src/config.js");
  const fs = await import("node:fs");
  const path = await import("node:path");

  assert.ok(
    fs.existsSync(path.join(repoRoot, "config", "system.json")),
    "repoRoot must actually contain config/system.json, whatever layout this file is running in",
  );
  assert.equal(Object.keys(loadConfig()).length, 7);
});

test("every function bundle can reach the config and the skill files", async () => {
  // included_files in netlify.toml ships config/ and skills/ next to the bundle. If the
  // root is wrong, the advisor and the learning skill fail the same way the dashboard did.
  const { repoRoot } = await import("../src/config.js");
  const fs = await import("node:fs");
  const path = await import("node:path");

  for (const skill of ["clickup-manager", "intelligems-manager", "leadership-priority-manager", "strategic-advisor", "learning-skill"]) {
    assert.ok(
      fs.existsSync(path.join(repoRoot, "skills", skill, "SKILL.md")),
      `skills/${skill}/SKILL.md must be reachable from repoRoot`,
    );
  }
});

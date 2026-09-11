// Retry and pagination. A 429 then a 200 succeeds. Four 500s then a 200 succeeds. Five
// 500s fails. A 401 fails immediately with no retry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { httpJson, paginate, serverRetryDelayMs, HttpError } from "../src/lib/http.js";

/** A fetch stand-in that replays a scripted list of responses and counts calls. */
function scriptedFetch(script) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    if (next.throw) throw Object.assign(new Error(next.throw), { name: next.throw });
    return {
      status: next.status,
      headers: new Headers(next.headers ?? {}),
      text: async () => (next.body === undefined ? "" : JSON.stringify(next.body)),
    };
  };
  impl.calls = calls;
  return impl;
}

const nowait = async () => {};
const opts = (fetchImpl) => ({ fetchImpl, sleep: nowait, label: "test" });

test("a 429 then a 200 succeeds", async () => {
  const fetchImpl = scriptedFetch([{ status: 429 }, { status: 200, body: { ok: true } }]);
  const result = await httpJson("https://x/y", opts(fetchImpl));
  assert.equal(result.status, 200);
  assert.equal(fetchImpl.calls.length, 2);
});

test("four 500s then a 200 succeeds", async () => {
  const fetchImpl = scriptedFetch([
    { status: 500 },
    { status: 500 },
    { status: 500 },
    { status: 500 },
    { status: 200, body: { ok: true } },
  ]);
  const result = await httpJson("https://x/y", opts(fetchImpl));
  assert.equal(result.body.ok, true);
  assert.equal(fetchImpl.calls.length, 5);
});

test("five 500s fails", async () => {
  const fetchImpl = scriptedFetch([{ status: 500 }]);
  await assert.rejects(() => httpJson("https://x/y", opts(fetchImpl)), (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 500);
    assert.equal(err.attempts, 5);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 5, "five attempts, then give up");
});

test("a 401 fails immediately with no retry", async () => {
  const fetchImpl = scriptedFetch([{ status: 401, body: { err: "Token invalid" } }]);
  await assert.rejects(() => httpJson("https://x/y", opts(fetchImpl)), (err) => {
    assert.equal(err.status, 401);
    assert.equal(err.retryable, false);
    assert.equal(err.attempts, 1);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1, "a bad token does not get better on the second try");
});

test("a 404 fails immediately too", async () => {
  const fetchImpl = scriptedFetch([{ status: 404 }]);
  await assert.rejects(() => httpJson("https://x/y", opts(fetchImpl)));
  assert.equal(fetchImpl.calls.length, 1);
});

test("a timeout is retried, because it is transient", async () => {
  const fetchImpl = scriptedFetch([{ throw: "TimeoutError" }, { status: 200, body: { ok: true } }]);
  const result = await httpJson("https://x/y", opts(fetchImpl));
  assert.equal(result.status, 200);
});

test("a repeated timeout gives up and says it timed out", async () => {
  const fetchImpl = scriptedFetch([{ throw: "TimeoutError" }]);
  await assert.rejects(() => httpJson("https://x/y", { ...opts(fetchImpl), timeoutMs: 30000 }), /timed out after 30000ms/);
});

test("the two upstreams' different rate-limit headers are each read correctly", () => {
  const now = Date.parse("2026-09-10T13:00:00Z");

  // The standard: Retry-After in seconds.
  assert.equal(serverRetryDelayMs(new Headers({ "retry-after": "12" }), now), 12000);

  // ClickUp: X-RateLimit-Reset as a unix epoch in seconds.
  assert.equal(serverRetryDelayMs(new Headers({ "x-ratelimit-reset": String(now / 1000 + 30) }), now), 30000);

  // Intelligems: x-ratelimit-reset as MILLISECONDS UNTIL RESET, not an epoch.
  // Read as an epoch this lands in 1970; read as seconds it sleeps for eight hours.
  assert.equal(serverRetryDelayMs(new Headers({ "x-ratelimit-reset": "30000" }), now), 30000);

  // Intelligems 429 body: retryAfter in seconds. Takes precedence over any header.
  assert.equal(serverRetryDelayMs(new Headers({ "x-ratelimit-reset": "30000" }), now, { retryAfter: 5 }), 5000);

  // Nothing said, and nonsense, both yield null rather than a wild sleep.
  assert.equal(serverRetryDelayMs(new Headers({}), now), null);
  assert.equal(serverRetryDelayMs(new Headers({ "retry-after": "99999" }), now), null, "a delay past the cap is ignored, not slept through");
});

test("the server's delay wins when it is longer than our backoff", async () => {
  const slept = [];
  const fetchImpl = scriptedFetch([{ status: 429, headers: { "retry-after": "7" } }, { status: 200, body: {} }]);
  await httpJson("https://x/y", { fetchImpl, sleep: async (ms) => slept.push(ms), label: "test" });
  assert.equal(slept[0], 7000, "1s backoff would have hit the limit again");
});

/* -------------------------------- pagination -------------------------------- */

test("three pages of tasks assemble into one list", async () => {
  const pages = [
    { tasks: [{ id: "a" }, { id: "b" }], last_page: false },
    { tasks: [{ id: "c" }], last_page: false },
    { tasks: [{ id: "d" }], last_page: true },
  ];
  const result = await paginate({
    fetchPage: async (page) => pages[page],
    extract: (body) => body.tasks,
    isLastPage: (body) => body.last_page === true,
  });
  assert.equal(result.items.length, 4);
  assert.equal(result.pages, 3);
  assert.equal(result.truncated, false);
});

test("pagination stops on last_page", async () => {
  let requested = 0;
  await paginate({
    fetchPage: async () => {
      requested += 1;
      return { tasks: [{ id: requested }], last_page: true };
    },
    extract: (body) => body.tasks,
    isLastPage: (body) => body.last_page === true,
  });
  assert.equal(requested, 1);
});

test("pagination stops on an empty page even if last_page never arrives", async () => {
  let requested = 0;
  const result = await paginate({
    fetchPage: async (page) => {
      requested += 1;
      return { tasks: page < 2 ? [{ id: page }] : [], last_page: false };
    },
    extract: (body) => body.tasks,
    isLastPage: () => false,
  });
  assert.equal(requested, 3);
  assert.equal(result.items.length, 2);
});

test("pagination cannot spin past the hard page cap", async () => {
  const lines = [];
  const result = await paginate({
    fetchPage: async (page) => ({ tasks: [{ id: page }], last_page: false }),
    extract: (body) => body.tasks,
    isLastPage: () => false, // a source that never admits it is done
    maxPages: 5,
    logger: { warn: (event, fields) => lines.push({ event, fields }) },
  });
  assert.equal(result.items.length, 5);
  assert.equal(result.truncated, true);
  assert.equal(lines[0].event, "paginate.capped");
});

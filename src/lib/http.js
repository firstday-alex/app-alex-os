// One HTTP client for every outbound call, so the retry policy exists in exactly one place.
//
// Policy from the spec:
//   - Retry 429 and 5xx with exponential backoff: 1s, 2s, 4s, 8s, then give up.
//     Five failed attempts total. Four 500s followed by a 200 succeeds.
//   - Respect Retry-After and X-RateLimit-Reset when present.
//   - Do NOT retry any other 4xx. A 401 means the token is bad, a 404 means the id is
//     wrong. Retrying fixes neither. Fail fast and say why.
//   - 30 second timeout on every call. A hung call must not stall the 8 AM send.

export class HttpError extends Error {
  constructor(message, { status, url, method, body, attempts, retryable }) {
    super(message);
    this.name = "HttpError";
    this.status = status ?? null;
    this.url = url;
    this.method = method;
    this.responseBody = body ?? null;
    this.attempts = attempts;
    this.retryable = Boolean(retryable);
  }
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * How long the server told us to wait, in ms, or null if it did not say.
 *
 * Three shapes, because the two upstreams disagree:
 *   - `Retry-After`: seconds, or an HTTP date. The standard.
 *   - ClickUp's `X-RateLimit-Reset`: a unix epoch, in seconds.
 *   - Intelligems' `x-ratelimit-reset`: MILLISECONDS UNTIL RESET, not an epoch, and its
 *     429 body carries `retryAfter` in seconds.
 *
 * Getting this wrong is quiet and expensive: reading Intelligems' 30000 as epoch seconds
 * would schedule a retry in 1970, and reading it as "seconds" would sleep for eight hours
 * and blow through the 8 AM send.
 */
export function serverRetryDelayMs(headers, now = Date.now(), body = null) {
  const cap = 5 * 60 * 1000;
  const clamp = (ms) => (ms > 0 && ms <= cap ? ms : null);

  // A 429 body may name the wait directly.
  const fromBody = body && typeof body === "object" ? Number(body.retryAfter ?? body.retry_after) : NaN;
  if (Number.isFinite(fromBody) && fromBody > 0) return clamp(fromBody * 1000);

  if (!headers) return null;
  const get = (name) => (typeof headers.get === "function" ? headers.get(name) : headers[name]);

  const retryAfter = get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return clamp(seconds * 1000);
    const asDate = Date.parse(retryAfter);
    if (!Number.isNaN(asDate)) return clamp(asDate - now);
  }

  const reset = get("x-ratelimit-reset");
  if (reset) {
    const value = Number(reset);
    if (!Number.isFinite(value) || value <= 0) return null;

    // An epoch, in seconds or ms: resolve against now and take it if it lands in the
    // near future.
    if (value > 1e9) {
      const asMs = value > 1e12 ? value : value * 1000;
      const delta = clamp(asMs - now);
      if (delta != null) return delta;
    }
    // Otherwise it is a duration. Intelligems documents ms; anything under 300 is far
    // more likely to be seconds than a third of a second.
    return clamp(value < 300 ? value * 1000 : value);
  }
  return null;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} url
 * @param {object} opts
 * @param {'GET'|'POST'|'PUT'} [opts.method]
 * @param {Record<string,string>} [opts.headers]
 * @param {any} [opts.body] JSON-serialized unless already a string
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxAttempts]
 * @param {number[]} [opts.backoffMsSchedule]
 * @param {object} [opts.logger]
 * @param {string} [opts.label] what to call this endpoint in the log
 * @param {Function} [opts.fetchImpl] injected for tests
 * @param {Function} [opts.sleep] injected for tests
 */
export async function httpJson(url, opts = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 30000,
    maxAttempts = 5,
    backoffMsSchedule = [1000, 2000, 4000, 8000],
    logger,
    label = url,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    now = () => Date.now(),
  } = opts;

  const payload =
    body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const finalHeaders = { accept: "application/json", ...headers };
  if (payload !== undefined && !finalHeaders["content-type"]) {
    finalHeaders["content-type"] = "application/json";
  }

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = now();
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: finalHeaders,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Network failure, DNS failure, or the 30s timeout tripping. Transient by nature.
      lastError = new HttpError(`${label}: ${err.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : err.message}`, {
        status: null,
        url,
        method,
        attempts: attempt,
        retryable: true,
      });
      logger?.apiCall?.({ label, method, status: null, durationMs: now() - startedAt, attempt, error: err.name || "network_error" });
      if (attempt === maxAttempts) throw lastError;
      await sleep(backoffMsSchedule[Math.min(attempt - 1, backoffMsSchedule.length - 1)]);
      continue;
    }

    const durationMs = now() - startedAt;
    const status = response.status;
    const text = await response.text().catch(() => "");
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    const rows = Array.isArray(parsed)
      ? parsed.length
      : Array.isArray(parsed?.tasks)
        ? parsed.tasks.length
        : Array.isArray(parsed?.data)
          ? parsed.data.length
          : undefined;

    logger?.apiCall?.({ label, method, status, durationMs, attempt, rows });

    if (status >= 200 && status < 300) {
      return { status, headers: response.headers, body: parsed, rawLength: text.length };
    }

    const snippet = text.slice(0, 300);

    if (!isRetryableStatus(status)) {
      // 401 bad token, 404 wrong id, 400 bad request. Fail fast and say why.
      throw new HttpError(`${label}: HTTP ${status} (not retryable) ${snippet}`, {
        status,
        url,
        method,
        body: parsed ?? snippet,
        attempts: attempt,
        retryable: false,
      });
    }

    lastError = new HttpError(`${label}: HTTP ${status} after ${attempt} attempt(s) ${snippet}`, {
      status,
      url,
      method,
      body: parsed ?? snippet,
      attempts: attempt,
      retryable: true,
    });

    if (attempt === maxAttempts) throw lastError;

    const serverDelay = serverRetryDelayMs(response.headers, now(), parsed);
    const backoff = backoffMsSchedule[Math.min(attempt - 1, backoffMsSchedule.length - 1)];
    await sleep(serverDelay != null ? Math.max(serverDelay, backoff) : backoff);
  }

  throw lastError ?? new HttpError(`${label}: exhausted attempts`, { url, method, attempts: maxAttempts, retryable: true });
}

/**
 * Page through an endpoint until the source says it is done.
 * Terminates on `isLastPage`, on an empty page, or at the hard page cap. Never spins.
 */
export async function paginate({ fetchPage, isLastPage, extract, maxPages = 50, logger, label = "paginate" }) {
  const items = [];
  let page = 0;
  let truncated = false;

  for (; page < maxPages; page += 1) {
    const result = await fetchPage(page);
    const batch = extract(result) ?? [];
    items.push(...batch);
    if (batch.length === 0) break;
    if (isLastPage(result, batch)) {
      page += 1;
      break;
    }
    if (page === maxPages - 1) {
      truncated = true;
      page += 1;
    }
  }

  if (truncated) {
    logger?.warn?.("paginate.capped", { label, maxPages, collected: items.length });
  }
  return { items, pages: page, truncated };
}

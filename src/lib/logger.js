// Structured logging. One JSON object per line, grep friendly, no prose.
//
// Redaction happens HERE, at the logger level, so that no caller can forget. Two passes:
//   1. Any key that looks like a credential is replaced by value.
//   2. Any string containing a registered secret has that substring replaced, which
//      catches a token that arrives inside a URL, an error message or a header dump.
//
// The spec's requirement is a test: log output never contains the token string.

const CREDENTIAL_KEY = /^(authorization|cookie|set-cookie|x-api-key|api[-_]?key|token|access[-_]?token|secret|password|signing[-_]?secret|intelligems-access-token|x-slack-signature)$/i;
const CREDENTIAL_KEY_SUBSTRING = /(token|secret|password|apikey|api_key)/i;
const REDACTED = "[REDACTED]";
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** Values registered here are scrubbed out of every string the logger ever writes. */
export function collectSecrets(env = process.env) {
  const names = [
    "CLICKUP_TOKEN",
    "INTELLIGEMS_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
    "ANTHROPIC_API_KEY",
    "GITHUB_TOKEN",
    "DASHBOARD_PASSWORD",
    "DASHBOARD_COOKIE_SECRET",
  ];
  return names
    .map((name) => env[name])
    .filter((value) => typeof value === "string" && value.length >= 8);
}

function scrubString(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

export function redact(value, secrets = [], seen = new WeakSet()) {
  if (typeof value === "string") return scrubString(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, secrets, seen));

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message, secrets),
      code: value.code,
      status: value.status,
    };
  }

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (CREDENTIAL_KEY.test(key) || CREDENTIAL_KEY_SUBSTRING.test(key)) {
      out[key] = item == null ? item : REDACTED;
    } else {
      out[key] = redact(item, secrets, seen);
    }
  }
  return out;
}

export function createLogger(options = {}) {
  const {
    level = process.env.MOS_LOG_LEVEL || "info",
    runId = null,
    sink = (line) => process.stdout.write(`${line}\n`),
    secrets = collectSecrets(),
    now = () => new Date().toISOString(),
    base = {},
    buffer = [],
  } = options;

  const threshold = LEVELS[level] ?? LEVELS.info;

  function emit(lvl, event, fields) {
    if ((LEVELS[lvl] ?? 20) < threshold) return;
    const record = {
      ts: now(),
      level: lvl,
      event,
      ...(runId ? { runId } : {}),
      ...base,
      ...redact(fields ?? {}, secrets),
    };
    buffer.push(record);
    try {
      sink(JSON.stringify(record));
    } catch {
      sink(JSON.stringify({ ts: record.ts, level: "error", event: "log.serialize_failed", origEvent: event }));
    }
    return record;
  }

  return {
    runId,
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),

    /** Every API call: endpoint, status, duration, rows. Never the payload. */
    apiCall: (fields) => emit("info", "api.call", fields),

    /** Every flag: the rule that raised it and the values that tripped it. */
    flag: (flag) =>
      emit("info", "flag.raised", {
        rule: flag.rule,
        layer: flag.layer,
        severity: flag.severity,
        subject: flag.subject,
        values: flag.values,
      }),

    child: (extra) => createLogger({ ...options, base: { ...base, ...extra }, buffer }),
    records: () => buffer.slice(),
  };
}

export function newRunId(now = new Date(), random = () => Math.random()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = random().toString(36).slice(2, 8);
  return `run_${stamp}_${suffix}`;
}

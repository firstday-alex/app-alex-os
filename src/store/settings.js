// App-level settings, edited in the dashboard.
//
// Same reasoning as rocks: these are DATA, not rules. The LTV reference values change
// when someone re-runs a cohort analysis, not when the logic changes, and waiting on a
// pull request to update a number Alex measured this morning is the wrong shape.
//
// Config still owns the rules that use them. This owns the values themselves, with an
// audit trail, because "why did the projected value of every test move last Tuesday" has
// to have an answer.

const DOC_KEY = "settings/index.json";
const AUDIT_PREFIX = "settings/audit";

export class SettingsValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "SettingsValidationError";
    this.field = field;
  }
}

/**
 * The settings this system understands, with their defaults and how to check them.
 *
 * Everything here is nullable on purpose. An unset LTV reference renders as "not
 * configured" and suppresses the projection; it never silently becomes zero, which would
 * value every subscriber at nothing and make every test look neutral.
 */
export const SCHEMA = {
  subscriptionLtv6mo: {
    label: "Subscription LTV, 6 month",
    help: "Revenue a customer acquired on a subscription is worth over six months, including the first order.",
    type: "money",
    default: null,
  },
  oneTimeLtv6mo: {
    label: "One-time LTV, 6 month",
    help: "Revenue a customer acquired on a one-time purchase is worth over six months, including the first order.",
    type: "money",
    default: null,
  },
  ltvHorizonMonths: {
    label: "Horizon (months)",
    help: "The window both LTV figures are measured over. Only used for labelling; changing it does not rescale the numbers.",
    type: "integer",
    default: 6,
  },
  ltvAsOf: {
    label: "Measured as of",
    help: "When these figures were last computed. Past staleAfterDays the projection is still shown, but flagged as old.",
    type: "date",
    default: null,
  },
  ltvStaleAfterDays: {
    label: "Stale after (days)",
    help: "How long an LTV measurement is trusted before the readout starts saying it is old.",
    type: "integer",
    default: 90,
  },
  significanceStrong: {
    label: "Strong significance at",
    help: "Probability to beat control at or above this counts as a strong signal. 0.95 is the conventional bar.",
    type: "probability",
    default: 0.95,
  },
  significanceDirectional: {
    label: "Directional significance at",
    help: "Probability to beat control at or above this counts as directional: worth watching, not worth acting on.",
    type: "probability",
    default: 0.8,
  },
};

function coerce(key, raw) {
  const spec = SCHEMA[key];
  if (!spec) throw new SettingsValidationError(`Unknown setting "${key}".`, key);
  if (raw == null || raw === "") return null;

  if (spec.type === "date") {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) throw new SettingsValidationError(`${spec.label} is not a date.`, key);
    return date.toISOString().slice(0, 10);
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) throw new SettingsValidationError(`${spec.label} must be a number.`, key);
  if (spec.type === "money" && value < 0) throw new SettingsValidationError(`${spec.label} cannot be negative.`, key);
  if (spec.type === "integer" && (!Number.isInteger(value) || value <= 0)) {
    throw new SettingsValidationError(`${spec.label} must be a whole number above zero.`, key);
  }
  if (spec.type === "probability" && (value <= 0 || value >= 1)) {
    throw new SettingsValidationError(`${spec.label} must be between 0 and 1, exclusive.`, key);
  }
  return value;
}

export function normalizeSettings(input, existing = {}) {
  const out = {};
  for (const key of Object.keys(SCHEMA)) {
    const provided = Object.prototype.hasOwnProperty.call(input, key);
    out[key] = provided ? coerce(key, input[key]) : (existing[key] ?? SCHEMA[key].default);
  }

  // A one-time customer worth more than a subscriber is possible, but it is almost always
  // a transposed pair, and it inverts every projection silently.
  if (out.subscriptionLtv6mo != null && out.oneTimeLtv6mo != null && out.oneTimeLtv6mo > out.subscriptionLtv6mo) {
    out._warning =
      "One-time LTV is higher than subscription LTV. That is possible, but it is usually the two values transposed, and it reverses the sign of every future-value projection.";
  }

  if (out.significanceDirectional != null && out.significanceStrong != null && out.significanceDirectional >= out.significanceStrong) {
    throw new SettingsValidationError(
      "Directional significance must be below strong significance, or nothing can ever be merely directional.",
      "significanceDirectional",
    );
  }
  return out;
}

export class SettingsStore {
  constructor(backend, logger) {
    this.backend = backend;
    this.logger = logger;
  }

  async read() {
    const doc = (await this.backend.get(DOC_KEY)) ?? { version: 0, settings: {}, updatedAt: null };
    return {
      version: doc.version ?? 0,
      updatedAt: doc.updatedAt ?? null,
      settings: normalizeSettings(doc.settings ?? {}),
      schema: SCHEMA,
    };
  }

  async write(input, { expectedVersion, actor = "dashboard" } = {}) {
    const current = (await this.backend.get(DOC_KEY)) ?? { version: 0, settings: {} };
    if (expectedVersion != null && current.version !== expectedVersion) {
      throw new SettingsValidationError(
        `Settings changed since you loaded them (you had version ${expectedVersion}, the store is on ${current.version}). Reload and reapply.`,
        "version",
      );
    }

    const settings = normalizeSettings(input, current.settings ?? {});
    const doc = { version: (current.version ?? 0) + 1, settings, updatedAt: new Date().toISOString() };
    await this.backend.set(DOC_KEY, doc);

    const diff = {};
    for (const key of Object.keys(SCHEMA)) {
      if ((current.settings ?? {})[key] !== settings[key]) {
        diff[key] = { from: (current.settings ?? {})[key] ?? null, to: settings[key] };
      }
    }
    const entry = { at: doc.updatedAt, version: doc.version, actor, changes: diff };
    await this.backend.set(`${AUDIT_PREFIX}/${entry.at}-v${doc.version}.json`, entry);
    this.logger?.info?.("settings.written", { version: doc.version, actor, changed: Object.keys(diff) });

    return { ...doc, schema: SCHEMA };
  }

  async auditTrail({ limit = 20 } = {}) {
    const keys = await this.backend.keys(`${AUDIT_PREFIX}/`);
    const recent = keys.sort().reverse().slice(0, limit);
    const entries = [];
    for (const key of recent) {
      const entry = await this.backend.get(key);
      if (entry) entries.push(entry);
    }
    return entries;
  }
}

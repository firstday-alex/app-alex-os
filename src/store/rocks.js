// The rocks store. Layer 1's data.
//
// Rocks are DATA, not configuration. They gain owners, change state and ship, week to
// week. Config holds the rules that judge them — the tolerance window, the one-big-swing
// capacity — and those still live in git and still change by pull request. The rocks
// themselves live here, in Netlify Blobs, and are edited from the dashboard.
//
// What git history was really providing was "who changed what, when". That is kept, as an
// explicit audit trail, which is a better fit for data than a commit log is.
//
// The whole queue is one document. It is a couple of dozen items at most, the pipeline
// wants an atomic read of all of them, and Blobs has no query. A document per rock would
// buy nothing and cost a listing on every run.

const DOC_KEY = "rocks/index.json";
const AUDIT_PREFIX = "rocks/audit";

/** Where a rock sits in the queue. Drives the Layer 1 rules. */
export const STATES = ["active", "shipped", "backlog"];

/**
 * How a rock is actually going. This is the EOS-style health field, and it is separate
 * from `state` on purpose:
 *
 *   state  - structural. Is this on the board, has it shipped, is it parked? The capacity
 *            rule, the backlog-overflow rule and the mini readout check all read this.
 *   status - editorial. Is it going well? A rock can be `active` and `off_track` at the
 *            same time, and that combination is the single most useful thing Layer 1 can
 *            tell Alex.
 *
 * Collapsing them would mean losing either "this shipped" or "this is in trouble".
 */
export const STATUSES = ["on_track", "at_risk", "off_track", "done"];

export const STATUS_LABELS = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
  done: "Done",
};

export class RockValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "RockValidationError";
    this.field = field;
  }
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "rock";
}

function nowIso() {
  return new Date().toISOString();
}

export const MAX_EXPERIMENT_LINKS = 3;
export const MAX_REPORT_LINKS = 3;

/**
 * Intelligems identifies an experience by uuid, and its app URLs carry that uuid in the
 * path. Pulling it out of a pasted link means the readout can be wired up by pasting the
 * URL you were already looking at, rather than hunting for an id.
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

export function experienceIdFromUrl(url) {
  const match = String(url ?? "").match(UUID_RE);
  return match ? match[0].toLowerCase() : null;
}

function cleanUrl(value, field) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  // Accept a bare domain; a link nobody can click is worse than a pedantic error.
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new RockValidationError(`${field} is not a URL.`, field);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new RockValidationError(`${field} must be an http or https URL.`, field);
  }
  return parsed.toString();
}

/** A list of {url,label}, capped, with blanks dropped rather than stored as empties. */
function linkList(value, { max, field, deriveExperienceId = false }) {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  for (const entry of raw) {
    const url = cleanUrl(typeof entry === "string" ? entry : entry?.url, field);
    if (!url) continue;
    const link = {
      url,
      label: (typeof entry === "object" && entry?.label ? String(entry.label).trim() : "") || null,
    };
    if (deriveExperienceId) link.experienceId = experienceIdFromUrl(url);
    out.push(link);
  }
  if (out.length > max) {
    throw new RockValidationError(`At most ${max} ${field} are allowed. You gave ${out.length}.`, field);
  }
  return out;
}

function isoOrNull(value, field) {
  if (value == null || value === "") return null;
  const asDate = new Date(value);
  if (Number.isNaN(asDate.getTime())) throw new RockValidationError(`${field} is not a date.`, field);
  return asDate.toISOString().slice(0, 10);
}

/** Everything the rest of the system is allowed to assume about a rock. */
export function normalizeRock(input, existing = null) {
  const title = String(input.title ?? existing?.title ?? "").trim();
  if (!title) throw new RockValidationError("A rock needs a title.", "title");

  const state = input.state ?? existing?.state ?? "active";
  if (!STATES.includes(state)) {
    throw new RockValidationError(`state must be one of ${STATES.join(", ")}.`, "state");
  }

  const status = input.status ?? existing?.status ?? "on_track";
  if (!STATUSES.includes(status)) {
    throw new RockValidationError(`status must be one of ${STATUSES.join(", ")}.`, "status");
  }

  const shippedAt = input.shippedAt ?? existing?.shippedAt ?? null;
  if (state === "shipped" && !shippedAt) {
    // The check-in window is measured from this date. Without it the overdue check can
    // never fire, and a shipped rock would go unchased forever.
    throw new RockValidationError("A rock marked shipped needs a shippedAt date.", "shippedAt");
  }

  const startDate = isoOrNull(input.startDate ?? existing?.startDate, "startDate");
  // "Check-In Date" and the spec's "mini readout" are the same thing: the last time a
  // human looked at this rock and said something about it. lastMiniReadoutAt is accepted
  // as an alias so older data and the config seed still load.
  const checkInDate = isoOrNull(
    input.checkInDate ?? input.lastMiniReadoutAt ?? existing?.checkInDate ?? existing?.lastMiniReadoutAt,
    "checkInDate",
  );

  if (startDate && shippedAt && startDate > shippedAt) {
    throw new RockValidationError("startDate is after shippedAt.", "startDate");
  }

  const str = (v, fallback = null) => (v == null || v === "" ? fallback : String(v));

  return {
    id: String(input.id ?? existing?.id ?? slugify(title)),
    title,
    status,
    state,
    owner: str(input.owner ?? existing?.owner),
    // What number this rock is supposed to move. Free text, but naming an Intelligems
    // metric key here lets a recommendation talk about the right number.
    kpi: str(input.kpi ?? existing?.kpi),
    startDate,
    checkInDate,
    shippedAt,
    notes: str(input.notes ?? existing?.notes),
    // The link to ClickUp. `clickupOptionId` is the option id on the Rock Reference
    // dropdown; the id is stable across renames, which is why the label is not stored.
    clickupOptionId: str(input.clickupOptionId ?? existing?.clickupOptionId),
    clickupFieldId: str(input.clickupFieldId ?? existing?.clickupFieldId),
    // The Big Swing option this rock is delivered through, when there is one. A rock is
    // the outcome; a big swing is the project meant to produce it.
    clickupBigSwingOptionId: str(input.clickupBigSwingOptionId ?? existing?.clickupBigSwingOptionId),
    intelligemsExperienceId: str(input.intelligemsExperienceId ?? existing?.intelligemsExperienceId),

    // Links. Up to three Intelligems experiments, one live page, and up to three other
    // reports for quick reference. The experiment links carry the experience id pulled
    // out of the URL, which is what the per-rock readout is built from.
    experimentLinks: linkList(input.experimentLinks ?? existing?.experimentLinks, {
      max: MAX_EXPERIMENT_LINKS,
      field: "experimentLinks",
      deriveExperienceId: true,
    }),
    websiteUrl: cleanUrl(input.websiteUrl ?? existing?.websiteUrl, "websiteUrl"),
    reportLinks: linkList(input.reportLinks ?? existing?.reportLinks, {
      max: MAX_REPORT_LINKS,
      field: "reportLinks",
    }),
    createdAt: existing?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    updatedBy: input.updatedBy ?? "dashboard",
  };
}

export class RocksStore {
  constructor(backend, logger) {
    this.backend = backend;
    this.logger = logger;
  }

  async readDoc() {
    return (await this.backend.get(DOC_KEY)) ?? { version: 0, rocks: [], updatedAt: null };
  }

  /**
   * The queue, split the way Layer 1 wants it.
   *
   * `seed` is used once: if the store has never been written and config still carries a
   * real queue, import it so switching to the store does not lose anything. An example
   * placeholder is not imported.
   */
  async list({ seed = null } = {}) {
    let doc = await this.readDoc();

    if (doc.version === 0 && doc.rocks.length === 0 && Array.isArray(seed) && seed.length) {
      const importable = seed.filter((item) => !String(item.id ?? "").startsWith("example"));
      if (importable.length) {
        this.logger?.info("rocks.seeded_from_config", { count: importable.length });
        doc = await this.writeAll(importable.map((item) => normalizeRock({ ...item, updatedBy: "config-import" })), {
          expectedVersion: 0,
          reason: "imported from config/leadership-queue.json on first read",
          actor: "system",
        });
      }
    }

    const rocks = doc.rocks ?? [];
    return {
      version: doc.version ?? 0,
      updatedAt: doc.updatedAt ?? null,
      rocks,
      queue: rocks.filter((r) => r.state === "active" || r.state === "shipped"),
      backlog: rocks.filter((r) => r.state === "backlog"),
    };
  }

  async writeAll(rocks, { expectedVersion, reason, actor = "dashboard" } = {}) {
    const current = await this.readDoc();

    // Optimistic concurrency. One person and a background job can still collide, and a
    // lost write here means a priority silently reverts.
    if (expectedVersion != null && current.version !== expectedVersion) {
      throw new RockValidationError(
        `The rocks changed since you loaded them (you had version ${expectedVersion}, the store is on ${current.version}). Reload and reapply.`,
        "version",
      );
    }

    const doc = {
      version: (current.version ?? 0) + 1,
      rocks,
      updatedAt: nowIso(),
    };
    await this.backend.set(DOC_KEY, doc);
    await this.#audit({ version: doc.version, reason, actor, before: current.rocks ?? [], after: rocks });
    return doc;
  }

  async upsert(input, { expectedVersion, actor = "dashboard" } = {}) {
    const doc = await this.readDoc();
    const rocks = [...(doc.rocks ?? [])];
    const index = input.id ? rocks.findIndex((r) => r.id === input.id) : -1;
    const existing = index >= 0 ? rocks[index] : null;
    const rock = normalizeRock({ ...input, updatedBy: actor }, existing);

    if (index >= 0) rocks[index] = rock;
    else {
      if (rocks.some((r) => r.id === rock.id)) {
        throw new RockValidationError(`A rock with id "${rock.id}" already exists.`, "id");
      }
      rocks.push(rock);
    }

    await this.writeAll(rocks, {
      expectedVersion: expectedVersion ?? doc.version,
      reason: existing ? `updated "${rock.title}"` : `created "${rock.title}"`,
      actor,
    });
    return rock;
  }

  async remove(id, { expectedVersion, actor = "dashboard" } = {}) {
    const doc = await this.readDoc();
    const rocks = (doc.rocks ?? []).filter((r) => r.id !== id);
    if (rocks.length === (doc.rocks ?? []).length) {
      throw new RockValidationError(`No rock with id "${id}".`, "id");
    }
    await this.writeAll(rocks, {
      expectedVersion: expectedVersion ?? doc.version,
      reason: `removed "${id}"`,
      actor,
    });
    return { removed: id };
  }

  /** Records what changed, so "why is this a P1 now" has an answer. */
  async #audit({ version, reason, actor, before, after }) {
    const beforeById = new Map(before.map((r) => [r.id, r]));
    const afterById = new Map(after.map((r) => [r.id, r]));
    const changes = [];

    for (const [id, rock] of afterById) {
      const prior = beforeById.get(id);
      if (!prior) {
        changes.push({ id, change: "created", title: rock.title });
        continue;
      }
      const fields = ["title", "status", "state", "owner", "kpi", "startDate", "checkInDate", "shippedAt", "clickupOptionId", "clickupBigSwingOptionId", "intelligemsExperienceId", "websiteUrl", "notes"];
      const diff = {};
      for (const field of fields) {
        if (prior[field] !== rock[field]) diff[field] = { from: prior[field], to: rock[field] };
      }
      if (Object.keys(diff).length) changes.push({ id, change: "updated", title: rock.title, diff });
    }
    for (const [id, rock] of beforeById) {
      if (!afterById.has(id)) changes.push({ id, change: "removed", title: rock.title });
    }

    const entry = { at: nowIso(), version, actor, reason: reason ?? null, changes };
    await this.backend.set(`${AUDIT_PREFIX}/${entry.at}-v${version}.json`, entry);
    this.logger?.info("rocks.written", { version, actor, reason, changed: changes.length });
    return entry;
  }

  async auditTrail({ limit = 25 } = {}) {
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

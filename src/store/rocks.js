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

export const STATES = ["active", "shipped", "backlog"];

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

/** Everything the rest of the system is allowed to assume about a rock. */
export function normalizeRock(input, existing = null) {
  const title = String(input.title ?? existing?.title ?? "").trim();
  if (!title) throw new RockValidationError("A rock needs a title.", "title");

  const state = input.state ?? existing?.state ?? "active";
  if (!STATES.includes(state)) {
    throw new RockValidationError(`state must be one of ${STATES.join(", ")}.`, "state");
  }

  const shippedAt = input.shippedAt ?? existing?.shippedAt ?? null;
  if (state === "shipped" && !shippedAt) {
    // The mini readout window is measured from this date. Without it the check cannot
    // run, and a shipped rock with no date would silently never be chased.
    throw new RockValidationError("A rock marked shipped needs a shippedAt date.", "shippedAt");
  }

  const isoOrNull = (value, field) => {
    if (value == null || value === "") return null;
    const asDate = new Date(value);
    if (Number.isNaN(asDate.getTime())) throw new RockValidationError(`${field} is not a date.`, field);
    return asDate.toISOString().slice(0, 10);
  };

  return {
    id: String(input.id ?? existing?.id ?? slugify(title)),
    title,
    type: input.type ?? existing?.type ?? null,
    state,
    owner: input.owner == null || input.owner === "" ? null : String(input.owner),
    clickupOptionId:
      input.clickupOptionId == null || input.clickupOptionId === "" ? null : String(input.clickupOptionId),
    intelligemsExperienceId:
      input.intelligemsExperienceId == null || input.intelligemsExperienceId === ""
        ? null
        : String(input.intelligemsExperienceId),
    shippedAt: isoOrNull(shippedAt, "shippedAt"),
    lastMiniReadoutAt: isoOrNull(input.lastMiniReadoutAt ?? existing?.lastMiniReadoutAt, "lastMiniReadoutAt"),
    notes: input.notes ?? existing?.notes ?? null,
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
      const fields = ["title", "state", "owner", "type", "clickupOptionId", "shippedAt", "lastMiniReadoutAt", "intelligemsExperienceId", "notes"];
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

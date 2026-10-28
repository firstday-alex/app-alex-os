// What this app holds about a Supabase rock or tactic that Supabase does not.
//
// The rocks and tactics themselves (title, status, check-ins, milestones) are read from
// Supabase and never written back. What only matters here stays here, keyed by the
// Supabase id so a rename there does not lose it:
//
//   owner                    the ClickUp person who owns it, for capacity and "who to reach"
//   clickupBigSwingOptionId  the Big Swing option tickets reach it through
//   experimentLinks, reportLinks, websiteUrl, notes   quick references, as before
//
// One document, like the rocks store, with the same optimistic version check and an
// entry in the same audit trail for every change.

import { cleanUrl, linkList, MAX_EXPERIMENT_LINKS, MAX_REPORT_LINKS, RockValidationError } from "./rocks.js";
import { titleSimilarity, ROCK_MATCH_THRESHOLD } from "./rock-import.js";

const DOC_KEY = "rocks/links.json";
const AUDIT_PREFIX = "rocks/audit";
const FIELDS = ["owner", "clickupBigSwingOptionId", "experimentLinks", "reportLinks", "websiteUrl", "notes"];

const str = (v) => (v == null || String(v).trim() === "" ? null : String(v).trim());

/** One entry's fields, validated. Only the fields given are changed. */
export function normalizeLinks(input, existing = {}) {
  const has = (f) => Object.prototype.hasOwnProperty.call(input, f);
  return {
    owner: has("owner") ? str(input.owner) : existing.owner ?? null,
    clickupBigSwingOptionId: has("clickupBigSwingOptionId") ? str(input.clickupBigSwingOptionId) : existing.clickupBigSwingOptionId ?? null,
    experimentLinks: has("experimentLinks")
      ? linkList(input.experimentLinks, { max: MAX_EXPERIMENT_LINKS, field: "experimentLinks", deriveExperienceId: true })
      : existing.experimentLinks ?? [],
    reportLinks: has("reportLinks") ? linkList(input.reportLinks, { max: MAX_REPORT_LINKS, field: "reportLinks" }) : existing.reportLinks ?? [],
    websiteUrl: has("websiteUrl") ? cleanUrl(input.websiteUrl, "websiteUrl") : existing.websiteUrl ?? null,
    notes: has("notes") ? str(input.notes) : existing.notes ?? null,
  };
}

/**
 * Carries the old dashboard rocks' links over to the Supabase rocks and tactics they
 * name. A match is by title, at the same threshold the standup import used; each
 * Supabase id takes at most one old rock, the closest. Returns the links and what did
 * not carry over, so it can be reported rather than lost quietly.
 */
export function planSeed(oldRocks, source) {
  const targets = source.rocks.flatMap((r) => [
    { id: r.id, title: r.title, kind: "rock" },
    ...r.tactics.filter((t) => t.status !== "done").map((t) => ({ id: t.id, title: t.title, kind: "tactic" })),
  ]);
  const pairs = [];
  for (const old of oldRocks) {
    for (const t of targets) {
      const score = titleSimilarity(old.title, t.title);
      if (score >= ROCK_MATCH_THRESHOLD) pairs.push({ old, target: t, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const links = {};
  const used = new Set();
  const matched = [];
  for (const { old, target, score } of pairs) {
    if (links[target.id] || used.has(old.id)) continue;
    used.add(old.id);
    links[target.id] = normalizeLinks(
      {
        owner: old.owner,
        clickupBigSwingOptionId: old.clickupBigSwingOptionId,
        experimentLinks: old.experimentLinks,
        reportLinks: old.reportLinks,
        websiteUrl: old.websiteUrl,
        notes: old.notes,
      },
      {},
    );
    matched.push({ from: old.title, to: target.title, kind: target.kind, score: Math.round(score * 100) / 100 });
  }
  const unmatched = oldRocks.filter((r) => !used.has(r.id)).map((r) => ({ title: r.title, clickupBigSwingOptionId: r.clickupBigSwingOptionId ?? null }));
  return { links, matched, unmatched };
}

export class RockLinksStore {
  constructor(backend, logger) {
    this.backend = backend;
    this.logger = logger;
  }

  async read() {
    return (await this.backend.get(DOC_KEY)) ?? { version: 0, links: {}, updatedAt: null, seed: null };
  }

  /**
   * The links, seeded once from the old dashboard rocks the first time Supabase is the
   * source. `oldRocks` and `source` are only used for that first read.
   */
  async list({ oldRocks = null, source = null } = {}) {
    const doc = await this.read();
    if (doc.version === 0 && source && oldRocks?.length) {
      const seed = planSeed(oldRocks, source);
      const written = await this.#write(seed.links, doc, {
        actor: "system",
        reason: `carried ${seed.matched.length} old rocks' links over to Supabase; ${seed.unmatched.length} did not match`,
        seed: { at: new Date().toISOString(), matched: seed.matched, unmatched: seed.unmatched },
      });
      this.logger?.info?.("rock_links.seeded", { matched: seed.matched.length, unmatched: seed.unmatched.length });
      return written;
    }
    return doc;
  }

  /** Changes one rock's or tactic's links. `title` is only for the audit trail. */
  async set(id, patch, { expectedVersion, actor = "dashboard", title = null } = {}) {
    if (!id) throw new RockValidationError("Which rock or tactic is this for?", "id");
    const doc = await this.read();
    if (expectedVersion != null && doc.version !== expectedVersion) {
      throw new RockValidationError(
        `The links changed since you loaded them (you had version ${expectedVersion}, the store is on ${doc.version}). Reload and reapply.`,
        "version",
      );
    }
    const links = { ...doc.links, [id]: normalizeLinks(patch, doc.links[id] ?? {}) };
    return this.#write(links, doc, { actor, reason: `updated the links on "${title ?? id}"`, titles: { [id]: title } });
  }

  async #write(links, current, { actor, reason, seed, titles = {} }) {
    const doc = {
      version: (current.version ?? 0) + 1,
      links,
      updatedAt: new Date().toISOString(),
      seed: seed ?? current.seed ?? null,
    };
    await this.backend.set(DOC_KEY, doc);

    const changes = [];
    for (const [id, after] of Object.entries(links)) {
      const before = current.links?.[id] ?? {};
      const diff = {};
      for (const f of FIELDS) {
        if (JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null)) diff[f] = { from: before[f] ?? null, to: after[f] ?? null };
      }
      if (Object.keys(diff).length) changes.push({ id, change: "updated", title: titles[id] ?? id, diff });
    }
    const entry = { at: doc.updatedAt, version: doc.version, actor, reason, changes, store: "links" };
    await this.backend.set(`${AUDIT_PREFIX}/${entry.at}-links-v${doc.version}.json`, entry);
    return doc;
  }
}

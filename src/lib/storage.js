// Snapshot and report storage.
//
// Netlify Blobs in production, a local directory for `netlify dev` and an in-memory store
// for tests. Blobs has no query, so the spec's rule applies: design the keys so the latest
// snapshot and the previous working day's snapshot are computable from the date alone, and
// keep a small index so we never list the whole store.
//
// Key layout:
//   snapshots/<source>/<YYYY-MM-DD>T<HH-MM>-<official|refresh>.json
//   snapshots/<source>/index.json      -> { officialByDate, recent[] }
//   reports/<YYYY-MM-DD>-<official|refresh>-<runId>.json
//   reports/latest.json                -> pointer to the most recent report of any mode
//   reports/sent/<YYYY-MM-DD>.json     -> the idempotence guard for the Slack post
//   runs/<YYYY-MM-DD>/<runId>.json     -> structured run log

import fs from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "../config.js";

/* ------------------------------- backends ------------------------------- */

function memoryBackend(seed = new Map()) {
  const map = seed;
  return {
    name: "memory",
    async get(key) {
      return map.has(key) ? JSON.parse(map.get(key)) : null;
    },
    async set(key, value) {
      map.set(key, JSON.stringify(value));
    },
    async del(key) {
      map.delete(key);
    },
    async keys(prefix = "") {
      return [...map.keys()].filter((k) => k.startsWith(prefix));
    },
    _map: map,
  };
}

function fsBackend(dir) {
  const root = path.isAbsolute(dir) ? dir : path.join(repoRoot, dir);
  const fileFor = (key) => path.join(root, `${key.replace(/[^a-zA-Z0-9/_.-]/g, "_")}`);
  return {
    name: "fs",
    root,
    async get(key) {
      try {
        return JSON.parse(await fs.readFile(fileFor(key), "utf8"));
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },
    async set(key, value) {
      const file = fileFor(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    },
    async del(key) {
      await fs.rm(fileFor(key), { force: true });
    },
    async keys(prefix = "") {
      const out = [];
      const walk = async (rel) => {
        const abs = path.join(root, rel);
        let entries;
        try {
          entries = await fs.readdir(abs, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const next = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(next);
          else if (next.startsWith(prefix)) out.push(next);
        }
      };
      await walk("");
      return out;
    },
  };
}

async function blobsBackend(storeName = "turnpups-mos") {
  const { getStore } = await import("@netlify/blobs");
  const store = getStore({ name: storeName, consistency: "strong" });
  return {
    name: "blobs",
    async get(key) {
      return (await store.get(key, { type: "json" })) ?? null;
    },
    async set(key, value) {
      await store.setJSON(key, value);
    },
    async del(key) {
      await store.delete(key);
    },
    async keys(prefix = "") {
      const { blobs } = await store.list({ prefix });
      return blobs.map((b) => b.key);
    },
  };
}

/** Chooses a backend. Blobs on Netlify, a local folder otherwise, memory in tests. */
export async function createBackend(options = {}) {
  const mode =
    options.mode ??
    process.env.MOS_STORAGE ??
    (process.env.NETLIFY || process.env.NETLIFY_BLOBS_CONTEXT ? "blobs" : "fs");

  if (options.backend) return options.backend;
  if (mode === "memory") return memoryBackend(options.seed);
  if (mode === "fs") return fsBackend(options.dir ?? process.env.MOS_DATA_DIR ?? ".data");
  return blobsBackend(options.storeName);
}

/* ------------------------------- store API ------------------------------- */

export class Store {
  constructor(backend, config, logger) {
    this.backend = backend;
    this.config = config;
    this.logger = logger;
    this.prefixes = config?.system?.storage ?? {};
  }

  static async open({ config, logger, ...backendOptions } = {}) {
    const backend = await createBackend(backendOptions);
    return new Store(backend, config, logger);
  }

  snapshotKey(source, dateKey, timeKey, mode) {
    const prefix = this.prefixes.snapshotPrefix ?? "snapshots";
    return `${prefix}/${source}/${dateKey}T${timeKey}-${mode}.json`;
  }

  indexKey(source) {
    const prefix = this.prefixes.snapshotPrefix ?? "snapshots";
    return `${prefix}/${source}/${this.prefixes.indexKey ?? "index.json"}`;
  }

  async readIndex(source) {
    return (await this.backend.get(this.indexKey(source))) ?? { officialByDate: {}, recent: [] };
  }

  /**
   * Writes a snapshot and updates the index.
   *
   * Never overwrite a good snapshot with an empty one. But "empty" has to mean a pull that
   * collapsed, not a pull that legitimately found nothing: zero tests running and an empty
   * leadership queue are both real answers, and refusing to store them would leave those
   * sources without a baseline forever.
   *
   * A collector that fails outright throws, so reaching this function means the pull
   * succeeded. What is left to catch is the partial collapse: no items AND recorded
   * failures. That, and an explicit `empty: true` from a collector that knows something is
   * wrong, are the two cases refused.
   */
  async putSnapshot(source, snapshot, { dateKey, timeKey, mode, runId, allowEmpty = false }) {
    const noItems = (snapshot?.items?.length ?? 0) === 0;
    const failures = (snapshot?.failures?.length ?? 0) || (snapshot?.meta?.failed ?? 0);
    const collapsed = snapshot?.empty === true || (noItems && failures > 0);

    if (collapsed && !allowEmpty) {
      this.logger?.warn?.("snapshot.empty_not_stored", {
        source,
        dateKey,
        mode,
        runId,
        reason: snapshot?.empty === true ? "collector reported the snapshot as empty" : "no items and recorded failures",
        failures,
      });
      return { stored: false, key: null, reason: "a collapsed pull is not stored, so the previous baseline stands" };
    }
    if (noItems) {
      // Legitimately nothing to report. Stored, but said out loud.
      this.logger?.info?.("snapshot.no_items", { source, dateKey, mode, runId });
    }

    const key = this.snapshotKey(source, dateKey, timeKey, mode);
    await this.backend.set(key, snapshot);

    const index = await this.readIndex(source);
    const entry = { key, dateKey, timeKey, mode, runId, takenAt: snapshot?.takenAt ?? null, count: snapshot?.items?.length ?? null };
    index.recent = [entry, ...index.recent.filter((e) => e.key !== key)].slice(
      0,
      this.prefixes.keepSnapshotIndexEntries ?? 400,
    );
    if (mode === "official") {
      index.officialByDate = { ...index.officialByDate, [dateKey]: key };
    }
    index.latest = key;
    index.latestByDate = { ...(index.latestByDate ?? {}), [dateKey]: key };
    await this.backend.set(this.indexKey(source), index);

    this.logger?.info?.("snapshot.stored", { source, key, mode, count: entry.count });
    return { stored: true, key };
  }

  async getSnapshot(key) {
    if (!key) return null;
    return this.backend.get(key);
  }

  /**
   * The pinned baseline: the official 8 AM snapshot of the most recent working day that
   * has one. Walks back through the candidate keys so a missed day (holiday, outage)
   * does not leave the readout with no baseline at all.
   */
  async getBaseline(source, candidateDateKeys) {
    const index = await this.readIndex(source);
    for (const dateKey of candidateDateKeys) {
      const key = index.officialByDate?.[dateKey];
      if (!key) continue;
      const snapshot = await this.getSnapshot(key);
      if (snapshot) return { snapshot, key, dateKey, stale: dateKey !== candidateDateKeys[0] };
    }
    return { snapshot: null, key: null, dateKey: null, stale: false };
  }

  /** The newest snapshot of any mode for today. Used by the dashboard's "as of" line. */
  async getLatestSnapshot(source) {
    const index = await this.readIndex(source);
    if (!index.latest) return { snapshot: null, key: null };
    return { snapshot: await this.getSnapshot(index.latest), key: index.latest };
  }

  async putReport(report) {
    const prefix = this.prefixes.reportPrefix ?? "reports";
    const key = `${prefix}/${report.dateKey}-${report.mode}-${report.runId}.json`;
    await this.backend.set(key, report);
    await this.backend.set(`${prefix}/latest.json`, { key, ...report });
    if (report.mode === "official") {
      await this.backend.set(`${prefix}/latest-official.json`, { key, ...report });
    }
    this.logger?.info?.("report.stored", { key, mode: report.mode, flags: report.flags?.length ?? 0 });
    return key;
  }

  async getLatestReport({ officialOnly = false } = {}) {
    const prefix = this.prefixes.reportPrefix ?? "reports";
    return this.backend.get(officialOnly ? `${prefix}/latest-official.json` : `${prefix}/latest.json`);
  }

  async getReportByKey(key) {
    return this.backend.get(key);
  }

  /* Idempotence guard for the Slack post. Keyed on the run date, checked before sending,
     so a Netlify background-function retry cannot double post. */
  sentKey(dateKey) {
    return `${this.prefixes.sentKeyPrefix ?? "reports/sent"}/${dateKey}.json`;
  }

  async wasSent(dateKey) {
    return this.backend.get(this.sentKey(dateKey));
  }

  async markSent(dateKey, receipt) {
    await this.backend.set(this.sentKey(dateKey), receipt);
  }

  async putRunLog(runId, dateKey, records) {
    await this.backend.set(`runs/${dateKey}/${runId}.json`, records);
  }

  /* Cached lookups that are stable but not free: the ClickUp custom-field id map, the
     per-test Intelligems metric config. Read once, reuse, refresh past ttl. */
  async getCached(key, { ttlSeconds, now = Date.now() } = {}) {
    const wrapper = await this.backend.get(`cache/${key}.json`);
    if (!wrapper) return null;
    if (ttlSeconds && now - new Date(wrapper.storedAt).getTime() > ttlSeconds * 1000) return null;
    return wrapper.value;
  }

  async setCached(key, value, { now = new Date() } = {}) {
    await this.backend.set(`cache/${key}.json`, { storedAt: now.toISOString(), value });
  }

  /** Advisor answers, keyed by flag, so clicking twice does not pay twice. */
  async getAdvice(flagId) {
    return this.backend.get(`advice/${flagId}.json`);
  }

  async putAdvice(flagId, advice) {
    await this.backend.set(`advice/${flagId}.json`, advice);
  }
}

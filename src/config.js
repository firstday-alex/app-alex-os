// Config loader. The config folder is the single source of truth (DECIDED in the spec):
// every threshold, metric list, field id and rule lives there, the skill files describe
// the logic in plain language and point at it, and the code reads it. Nothing is
// hardcoded in either place.
//
// Loaded once per process and frozen, so a long-lived function cannot mutate a threshold
// halfway through a run and produce two different answers from one snapshot.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..");
const configDir = path.join(repoRoot, "config");

const FILES = {
  system: "system.json",
  clickup: "clickup.json",
  intelligems: "intelligems.json",
  leadership: "leadership.json",
  leadershipQueue: "leadership-queue.json",
  people: "people.json",
  references: "references.json",
};

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function readJson(file) {
  const full = path.join(configDir, file);
  try {
    return JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (err) {
    throw new Error(`config: cannot read ${file}: ${err.message}`);
  }
}

let cached = null;

/**
 * @param {{dir?: string, reload?: boolean, overrides?: object}} [opts]
 */
export function loadConfig(opts = {}) {
  if (cached && !opts.reload && !opts.dir && !opts.overrides) return cached;

  const dir = opts.dir ?? configDir;
  const loaded = {};
  for (const [key, file] of Object.entries(FILES)) {
    const full = path.join(dir, file);
    loaded[key] = JSON.parse(fs.readFileSync(full, "utf8"));
  }
  const merged = { ...loaded, ...(opts.overrides ?? {}) };
  const frozen = deepFreeze(merged);
  if (!opts.dir && !opts.overrides) cached = frozen;
  return frozen;
}

/** Reads a config file straight off disk without the cache. Used by the Learning Skill. */
export function readConfigFile(name) {
  const file = FILES[name] ?? name;
  return readJson(file);
}

export function configPath(name) {
  return path.join(configDir, FILES[name] ?? name);
}

/**
 * Validates the config the pipeline actually depends on. Returns a list of problems
 * rather than throwing, so a first run can report "you still owe me the list id"
 * on the dashboard instead of crashing in a background function with no output.
 */
export function validateConfig(config = loadConfig()) {
  const problems = [];
  const fatal = (msg) => problems.push({ level: "fatal", message: msg });
  const warn = (msg) => problems.push({ level: "warn", message: msg });

  const listId = config.clickup?.sprintListId;
  if (!listId || String(listId).startsWith("REPLACE_WITH")) {
    fatal("clickup.sprintListId is not set. The ClickUp collector cannot run without the sprint list id.");
  }
  if (!config.system?.timezone) fatal("system.timezone is not set.");
  if (typeof config.system?.schedule?.readoutHourCentral !== "number") {
    fatal("system.schedule.readoutHourCentral is not a number.");
  }

  for (const bucket of ["notStarted", "inProgress", "done"]) {
    const names = config.clickup?.statusMap?.[bucket];
    if (!Array.isArray(names) || names.length === 0) {
      fatal(`clickup.statusMap.${bucket} is empty. Status buckets cannot be derived.`);
    }
  }

  const team = (config.people?.team ?? []).filter((p) => p.clickupUserId != null);
  if (team.length === 0) {
    warn("people.team has no real entries. The one-big-swing capacity rule will fall back to the ClickUp workspace member list.");
  }

  const gate = config.intelligems?.readinessGate;
  if (!gate || typeof gate.minDaysRunning !== "number" || typeof gate.minOrdersPerGroup !== "number") {
    fatal("intelligems.readinessGate needs numeric minDaysRunning and minOrdersPerGroup.");
  }

  if (!Array.isArray(config.intelligems?.metrics?.p0) || config.intelligems.metrics.p0.length === 0) {
    warn("intelligems.metrics.p0 is empty. No P0 metric will be reported. Still an open item for Alex.");
  }

  const ltv = config.references?.ltv ?? {};
  if (ltv.subscription6MonthLtv?.value == null || ltv.oneTime6MonthLtv?.value == null) {
    warn("references.ltv is not populated. Future-value projection renders as 'not configured', never as zero.");
  }

  const queue = config.leadershipQueue?.queue ?? [];
  if (queue.some((item) => String(item.id ?? "").startsWith("example"))) {
    warn("config/leadership-queue.json still contains the example item. Replace it with the real leadership queue.");
  }

  return problems;
}

/** Every unresolved decision, collected from the `_TODO` keys the config files carry. */
export function openItems(config = loadConfig()) {
  const found = [];
  const walk = (node, trail) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("_TODO")) found.push({ at: trail.join("."), note: value });
      else if (value && typeof value === "object") walk(value, [...trail, key]);
    }
  };
  for (const [name, section] of Object.entries(config)) walk(section, [name]);
  return found;
}

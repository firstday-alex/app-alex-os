// Alex's Impact: an append-only ledger of what Alex and the team got done, grouped into
// themes that get regrouped as the record grows.
//
// Two halves, and only the second one is agentic:
//
//   harvest     plain code. Reads the latest report (and the day's MOS commits) and adds
//               anything new: a ticket done, a test launched or concluded, a rock shipped,
//               a day of building the MOS. Every item carries a link to the work.
//   placeTree   plain code. Takes the themes Claude proposes and enforces the one rule
//               that matters: nothing is ever deleted. An item Claude leaves out goes back
//               where it was, or into "Not yet sorted". An id Claude invents is dropped.
//
// Items are never removed from `items`. Their fields can be refreshed (a test goes from
// running to concluded, a title is renamed in ClickUp) but the record of the work stays.
//
// Key layout:
//   impact/ledger.json              the ledger: items, themes, recent runs
//   impact/history/<YYYY-MM-DD>.json  the themes as they stood after that day's run

export const LEDGER_KEY = "impact/ledger.json";
export const STATUS_KEY = "impact/status.json";
export const historyKey = (dateKey) => `impact/history/${dateKey}.json`;
export const UNSORTED = "Not yet sorted";
export const KINDS = ["ticket", "test", "rock", "build"];
const KEEP_RUNS = 90;
const DONE = new Set(["done (this sprint)", "done", "complete"]);

export function emptyLedger() {
  return { version: 1, items: {}, themes: [], runs: [], createdAt: null, updatedAt: null, reorganizedAt: null, changeNote: null };
}

const iso = (v) => {
  if (v == null || v === "") return null;
  const d = new Date(typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const names = (list) => [...new Set((list ?? []).map((u) => u?.username ?? u?.name ?? null).filter(Boolean))];

export function slug(text) {
  return (
    String(text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "theme"
  );
}

/** When a ticket was done: ClickUp's close date, else when it entered its done status, else its last update. */
function ticketDoneAt(task) {
  return iso(task.dateClosed) ?? (task.statusAge?.exact ? iso(task.statusAge.since) : null) ?? iso(task.dateUpdated);
}

/* ---------------------------------- harvest ---------------------------------- */

/** Every item the latest report and the day's commits can vouch for. Pure. */
export function itemsFromSources({ report, builds = [], config } = {}) {
  const out = [];
  const detail = report?.detail ?? {};

  for (const t of detail.clickup?.tasks ?? []) {
    if (t.archived || !DONE.has(String(t.status ?? "").toLowerCase())) continue;
    out.push({
      id: `ticket:${t.id}`,
      kind: "ticket",
      title: String(t.plainName ?? t.name ?? t.id).trim(),
      url: t.url ?? `https://app.clickup.com/t/${t.id}`,
      who: names(t.assignees?.length ? t.assignees : t.taskOwners),
      bigSwing: t.bigSwing?.label ?? null,
      rock: t.leadershipPriority?.label ?? null,
      status: t.status,
      date: ticketDoneAt(t),
    });
  }

  for (const test of detail.intelligems?.tests ?? []) {
    const impact = typeof test.estMonthlyRevenueImpact === "number" ? test.estMonthlyRevenueImpact : null;
    out.push({
      id: `test:${test.id}`,
      kind: "test",
      title: String(test.name ?? test.id),
      url: test.consoleUrl ?? null,
      who: [],
      bigSwing: null,
      rock: null,
      status: "running",
      date: iso(test.startedAt),
      facts: {
        verdict: test.verdict ?? null,
        daysRunning: test.daysRunning ?? null,
        totalOrders: test.totalOrders ?? null,
        ...(impact != null ? { estMonthlyRevenueImpact: Math.round(impact) } : {}),
      },
    });
  }

  const rocks = [...(detail.leadership?.queue ?? []), ...(detail.leadership?.backlog ?? [])];
  for (const rock of rocks) {
    if (!rock?.shippedAt && rock?.state !== "shipped") continue;
    out.push({
      id: `rock:${rock.id}`,
      kind: "rock",
      title: String(rock.title ?? rock.id),
      url: "#rocks",
      who: rock.owner?.name ? [rock.owner.name] : [],
      bigSwing: null,
      rock: rock.title ?? null,
      status: "shipped",
      date: iso(rock.shippedAt),
      facts: rock.kpi ? { kpi: rock.kpi } : undefined,
    });
  }

  const alex = config?.people?.alex?.name ?? "Alex";
  for (const b of builds) {
    out.push({
      id: `build:${b.dateKey}`,
      kind: "build",
      title: `Management OS: ${b.subjects.length} ${b.subjects.length === 1 ? "change" : "changes"}`,
      url: b.url,
      who: [alex],
      bigSwing: null,
      rock: null,
      status: "shipped",
      date: b.date,
      facts: { changes: b.subjects.slice(0, 20) },
    });
  }
  return out;
}

/**
 * Adds what is new and refreshes what is known. Never removes. A test that was running
 * and is no longer in the report has ended: it is marked concluded, with its last numbers.
 * Returns the ids added this run.
 */
export function harvest(ledger, incoming, { now = new Date(), testsCollected = false } = {}) {
  const at = now.toISOString();
  const added = [];
  const seenTests = new Set();
  ledger.createdAt ??= at;

  for (const item of incoming) {
    if (item.kind === "test") seenTests.add(item.id);
    const prev = ledger.items[item.id];
    if (!prev) {
      ledger.items[item.id] = { ...item, firstSeen: at, lastSeen: at };
      added.push(item.id);
      continue;
    }
    // Refresh, never blank: a field the source no longer carries keeps its old value.
    const merged = { ...prev, lastSeen: at };
    for (const [k, v] of Object.entries(item)) {
      if (v == null || (Array.isArray(v) && !v.length)) continue;
      merged[k] = v;
    }
    // A ticket's done date is when it was first done, not each later touch.
    if (prev.kind === "ticket" && prev.date) merged.date = prev.date;
    ledger.items[item.id] = merged;
  }

  // Only when the tests were actually read this run: a failed pull is not "every test ended".
  if (testsCollected) {
    for (const item of Object.values(ledger.items)) {
      if (item.kind !== "test" || item.status !== "running" || seenTests.has(item.id)) continue;
      item.status = "concluded";
      item.concludedAt = at;
    }
  }
  return added;
}

/* ---------------------------------- themes ---------------------------------- */

/** Every item id the themes hold, at any depth. */
export function placedIds(themes = []) {
  const out = [];
  for (const t of themes) {
    out.push(...(t.itemIds ?? []));
    out.push(...placedIds(t.themes ?? []));
  }
  return out;
}

/** Where each item sat: id -> the path of theme titles. */
function parentPaths(themes = [], path = [], out = new Map()) {
  for (const t of themes) {
    const here = [...path, t.title];
    for (const id of t.itemIds ?? []) out.set(id, here);
    parentPaths(t.themes ?? [], here, out);
  }
  return out;
}

function findOrMake(list, title) {
  let t = list.find((x) => x.title === title);
  if (!t) {
    t = { id: slug(title), title, summary: "", itemIds: [], themes: [] };
    list.push(t);
  }
  return t;
}

/**
 * Turns a proposed tree into the stored one. Two levels: a theme, and themes under it.
 * Each known item lands exactly once; unknown ids are dropped; empty themes are dropped;
 * anything left out goes back under the theme it was in before, else into UNSORTED.
 * `previous` is the tree as it stood before, for putting strays back.
 */
export function placeTree(proposed, ledger, previous = ledger.themes ?? []) {
  const known = new Set(Object.keys(ledger.items));
  const used = new Set();
  const take = (ids) =>
    (ids ?? []).map(String).filter((id) => {
      if (!known.has(id) || used.has(id)) return false;
      used.add(id);
      return true;
    });

  const build = (t, depth) => {
    const node = {
      id: slug(t?.title),
      title: String(t?.title ?? "").trim() || "Untitled",
      summary: String(t?.summary ?? "").trim(),
      itemIds: take(t?.itemIds),
      themes: depth < 1 ? (t?.themes ?? []).map((s) => build(s, depth + 1)) : [],
    };
    // A third level folds into the second: its items stay, its heading does not.
    if (depth >= 1) for (const deeper of t?.themes ?? []) node.itemIds.push(...take(placedIds([deeper])));
    node.themes = node.themes.filter((s) => s.itemIds.length || s.themes.length);
    return node;
  };

  const tree = (proposed ?? []).map((t) => build(t, 0)).filter((t) => t.itemIds.length || t.themes.length);

  // Strays: back where they were, else unsorted.
  const before = parentPaths(previous);
  for (const id of known) {
    if (used.has(id)) continue;
    const path = before.get(id);
    const top = findOrMake(tree, path?.[0] ?? UNSORTED);
    const target = path?.[1] ? findOrMake(top.themes, path[1]) : top;
    target.itemIds.push(id);
    used.add(id);
  }

  // Unique ids for anchors, since two titles can slug the same.
  const ids = new Set();
  const uniq = (node) => {
    let id = node.id;
    for (let n = 2; ids.has(id); n++) id = `${node.id}-${n}`;
    ids.add(id);
    node.id = id;
    node.themes.forEach(uniq);
  };
  tree.forEach(uniq);
  return tree;
}

/**
 * The plain-code placement, for days without a reorganization: new items go under their
 * rock (leadership priority), then Big Swing; tests, rocks and builds under their own kind.
 */
export function placeDeterministic(ledger, ids) {
  const tree = structuredClone(ledger.themes ?? []);
  const placed = new Set(placedIds(tree));
  const KIND_THEME = { test: "Experiments", rock: "Rocks shipped", build: "Management operating system" };
  for (const id of ids) {
    if (placed.has(id)) continue;
    const item = ledger.items[id];
    if (!item) continue;
    const topTitle = KIND_THEME[item.kind] ?? item.rock ?? item.bigSwing ?? UNSORTED;
    const top = findOrMake(tree, topTitle);
    const target = item.kind === "ticket" && item.rock && item.bigSwing ? findOrMake((top.themes ??= []), item.bigSwing) : top;
    target.itemIds.push(id);
    placed.add(id);
  }
  return placeTree(tree, ledger, ledger.themes);
}

/** Records a run, keeping the most recent. */
export function recordRun(ledger, run) {
  ledger.runs = [run, ...(ledger.runs ?? [])].slice(0, KEEP_RUNS);
}

/** An item as the model sees it: short, and only what the ledger holds. */
export function itemForModel(item) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    who: item.who?.length ? item.who : undefined,
    bigSwing: item.bigSwing ?? undefined,
    rock: item.rock ?? undefined,
    status: item.status ?? undefined,
    date: item.date ? item.date.slice(0, 10) : undefined,
    facts: item.facts ?? undefined,
  };
}

/** The tree as the model sees it: titles, summaries and ids, nothing else. */
export function treeForModel(themes = []) {
  return themes.map((t) => ({
    title: t.title,
    summary: t.summary || undefined,
    itemIds: t.itemIds?.length ? t.itemIds : undefined,
    themes: t.themes?.length ? treeForModel(t.themes) : undefined,
  }));
}

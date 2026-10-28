// The dashboard. Reads the same storage the 8 AM readout is built from, and can trigger
// the same pipeline on demand.
//
// The refresh path polls rather than awaits: a background function returns 202 straight
// away and the caller cannot wait for its result.

import { buildUpdate, updateText, windowStart } from "./update-text.js";

const $ = (id) => document.getElementById(id);
const layerLabel = (layer) => (layer === "cross" ? "CROSS" : layer === 0 ? "STORE" : `L${layer}`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const FN = "/.netlify/functions";

/* A sign-in lasts system.dashboard.sessionTtlHours. A tab left open past that keeps
   showing what it last loaded while every call behind it fails, which read as
   "Could not load the rocks: unauthorized" over a list that looked fine. So any call to
   our own functions that comes back 401 sends Alex to the sign-in screen, and signing
   in again reloads everything. */
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const response = await nativeFetch(input, init);
  const url = String(input?.url ?? input);
  if (response.status === 401 && url.startsWith(FN) && !url.endsWith("/login")) sessionExpired();
  return response;
};

function sessionExpired() {
  if (!$("login").classList.contains("hidden")) return;
  $("shell").classList.add("hidden");
  $("login").classList.remove("hidden");
  $("login-note").textContent = "Your session ran out. Sign in again and the page will reload where you were.";
  $("login-note").classList.remove("hidden");
  $("password").value = "";
  $("password").focus();
}
let state = { report: null, openItems: [], advisorButtonText: "Ask for recommendation", rocks: null, settings: null, testNotes: null, openTests: new Set(), showQuiet: false };

/* ---------------------------------- auth ---------------------------------- */

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("login-error");
  error.classList.add("hidden");
  const response = await fetch(`${FN}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: $("password").value }),
  });
  if (response.ok) {
    $("login-note").classList.add("hidden");
    $("login").classList.add("hidden");
    $("shell").classList.remove("hidden");
    load();
  } else {
    const body = await response.json().catch(() => ({}));
    error.textContent = body.error ?? "Sign in failed.";
    error.classList.remove("hidden");
  }
});

/* ---------------------------------- load ---------------------------------- */

async function load() {
  const response = await fetch(`${FN}/report`, { headers: { accept: "application/json" } });
  if (response.status === 401) {
    $("shell").classList.add("hidden");
    $("login").classList.remove("hidden");
    return;
  }
  // A valid cookie from an earlier visit means we can skip the sign-in screen.
  $("login").classList.add("hidden");
  $("shell").classList.remove("hidden");

  const body = await response.json();
  state.openItems = body.openItems ?? [];
  state.advisorButtonText = body.advisorButtonText ?? state.advisorButtonText;
  state.today = body.today ?? null;
  state.flagEntries = body.flagEntries ?? null;
  state.people = body.people ?? [];

  if (body.empty) {
    $("banners").innerHTML = `<div class="note"><strong>Nothing yet.</strong> ${esc(body.message)}</div>`;
    renderOpenItems();
    return;
  }
  state.report = body.report;
  render();
  // Test owners live in the notes. Fetched alongside so the attention list can use them.
  if (!state.testNotes) loadTestNotes().then(() => state.report && renderAllFlags({ rebuildTools: true }));
}

/* --------------------------------- render --------------------------------- */

function render() {
  const report = state.report;
  const s = report.summary;

  $("chip-mode").textContent = { official: "8 AM readout", test: "test send" }[report.mode] ?? "refreshed";
  $("drawer-baseline").textContent = `Baseline ${report.baseline.describe}`;
  $("drawer-generated").textContent = `Pulled ${new Date(report.generatedAt).toLocaleString()}`;

  const banners = [];
  if (report.mode !== "official") {
    banners.push(
      `<div class="note"><strong>Live preview.</strong> The baseline is pinned to the previous working day's 8 AM snapshot, so this is what tomorrow's 8 AM readout would say if nothing else changed. The scheduled send is still the official readout.</div>`,
    );
  }
  for (const missing of report.missing ?? []) {
    banners.push(
      `<div class="missing"><strong>Missing section: ${esc(missing.section)}.</strong> ${esc(missing.reason)}. The rest of this readout is complete.</div>`,
    );
  }
  for (const problem of (report.configProblems ?? []).filter((p) => p.level === "fatal")) {
    banners.push(`<div class="missing"><strong>Config problem.</strong> ${esc(problem.message)}</div>`);
  }
  $("banners").innerHTML = banners.join("");

  $("tiles").innerHTML = [
    `<div id="flag-tiles" class="tiles-inline">${flagTiles(report.flags ?? [])}</div>`,
    tile(report.sections.clickup?.counts?.inProgress ?? "—", "In progress"),
    tile(report.sections.clickup?.counts?.stalled ?? "—", "Stalled"),
    tile(report.sections.intelligems?.counts?.running ?? "—", "Tests running"),
  ].join("");

  const flags = report.flags ?? [];
  state.flagCtx = flagContextIndex(report);

  // Each part is drawn on its own. One that fails says so in place, and the rest of the
  // page, and the rocks load after it, still happen: a broken section must not blank
  // the dashboard.
  const failed = [];
  const part = (name, fn) => {
    try {
      fn();
    } catch (err) {
      console.error(`render ${name}`, err);
      failed.push(name);
    }
  };
  part("the flags", () => renderAllFlags({ rebuildTools: true }));
  part("the week", () => renderWeek(report));
  part("the store metrics", () => renderStoreMetrics(report));
  part("the funnel", () => renderFunnel(report));
  part("Layer 1", () => renderLayer1(report));
  part("the cross layer", () => renderCross(report));
  part("the sprint", () => renderLayer2(report));
  part("the update", () => renderUpdate(report));
  part("the tests", () => renderTests());
  part("the open decisions", () => renderOpenItems());
  $("report-text").textContent = report.text ?? "";
  if (failed.length) {
    $("banners").insertAdjacentHTML(
      "beforeend",
      `<div class="missing"><strong>Part of the page could not be drawn:</strong> ${esc(failed.join(", "))}. The rest is complete. Refresh to try again.</div>`,
    );
  }
  loadRocks();
}

/* ------------------------- Layer 0. store metrics ------------------------- */

const MONEY = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const MONEY2 = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const COUNT = new Intl.NumberFormat();

function formatMetric(value, format, { precise = false } = {}) {
  if (value == null) return "—";
  if (format === "money") return (precise ? MONEY2 : MONEY).format(value);
  if (format === "percent") return `${(value * 100).toFixed(2)}%`;
  return COUNT.format(Math.round(value));
}

/**
 * "Check in Shopify" links: one per window, opening the exact query behind the number
 * in a Shopify report. A tile built from two queries (Sub. Opt-In divides subscription
 * orders by all orders) gets a row for each, so both halves can be checked.
 */
function shopifyLinksRow(links, windows) {
  if (!links) return "";
  const byQuery = new Map();
  for (const w of windows ?? []) {
    for (const link of links[w.key] ?? []) {
      if (!byQuery.has(link.query)) byQuery.set(link.query, { label: link.label, links: [] });
      byQuery.get(link.query).links.push({ window: w.label, url: link.url });
    }
  }
  if (!byQuery.size) return "";
  const multi = byQuery.size > 1;
  return [...byQuery.values()]
    .map(
      (q) => `<div class="metric-src"><span>${esc(multi ? q.label : "Check in Shopify")}</span>${q.links
        .map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noreferrer" title="Open this ${esc(l.window)} query in Shopify">${esc(l.window)} ↗</a>`)
        .join("")}</div>`,
    )
    .join("");
}

/* ------------------------------ store period ------------------------------
   Which period the store tiles lead with: month to date, yesterday, the last 7 or the
   last 30 days. Every period is pulled on every run, so switching is instant; the
   others become the comparisons. Remembered per browser. */

const STORE_WINDOW_NAMES = { mtd: "Month to date", yesterday: "Yesterday", d7: "Last 7 days", d30: "Last 30 days" };

function storeWindowKey(data) {
  let chosen = null;
  try {
    chosen = localStorage.getItem("store-window");
  } catch {
    /* a per-viewer convenience */
  }
  const keys = (data?.windows ?? []).map((w) => w.key);
  return keys.includes(chosen) ? chosen : data?.primaryWindow?.key ?? keys[0];
}

/** Mirrors the collector's compareWindows: a rate directly, a total per day. */
function compareStore(primary, other, { kind, primaryDays, otherDays }) {
  if (primary == null || other == null) return { changePct: null, basis: kind === "total" ? "per day" : "direct" };
  if (kind === "total") {
    if (!primaryDays || !otherDays) return { changePct: null, basis: "per day" };
    const a = primary / primaryDays;
    const b = other / otherDays;
    if (b === 0) return { changePct: null, basis: "per day", otherPerDay: b };
    return { changePct: Number((((a - b) / Math.abs(b)) * 100).toFixed(1)), basis: "per day", otherPerDay: b };
  }
  if (other === 0) return { changePct: null, basis: "direct" };
  return { changePct: Number((((primary - other) / Math.abs(other)) * 100).toFixed(1)), basis: "direct" };
}

/**
 * A tile as seen from the chosen period. The stored tile leads with the collector's
 * primary window; for any other, the value and comparisons are rebuilt from the values
 * every window carries. A report from before those were stored can still be rebuilt
 * from the comparisons, which hold each window's value.
 */
function storeTileView(t, data, key) {
  const primaryKey = data?.primaryWindow?.key;
  if (key === primaryKey) return { value: t.value, comparisons: t.comparisons ?? [], companions: t.companions ?? [] };

  const values = t.byWindow
    ? Object.fromEntries(Object.entries(t.byWindow).map(([w, v]) => [w, v.value]))
    : { [primaryKey]: t.value, ...Object.fromEntries((t.comparisons ?? []).map((c) => [c.window, c.value])) };
  const days = Object.fromEntries((data?.windows ?? []).map((w) => [w.key, w.days]));
  const kind = t.kind ?? "total";
  const value = values[key] ?? null;

  const comparisons = (data?.windows ?? [])
    .filter((w) => w.key !== key)
    .map((w) => {
      const cmp = compareStore(value, values[w.key] ?? null, { kind, primaryDays: days[key], otherDays: days[w.key] });
      return { window: w.key, label: w.label, value: values[w.key] ?? null, perDay: cmp.otherPerDay ?? null, changePct: cmp.changePct, basis: cmp.basis };
    });
  const companions = (t.companions ?? []).map((c) => ({ ...c, value: t.byWindow?.[key]?.companions?.[c.name] ?? null }));
  return { value, comparisons, companions };
}

function renderStoreWindowToggle(data) {
  const host = $("store-windows");
  if (!host) return;
  const key = storeWindowKey(data);
  host.innerHTML = (data?.windows ?? [])
    .map((w) => `<button type="button" class="ghost dod-window${w.key === key ? " on" : ""}" data-store-window="${esc(w.key)}" aria-pressed="${w.key === key}">${esc(STORE_WINDOW_NAMES[w.key] ?? w.label)}</button>`)
    .join("");
}

$("store-windows")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-store-window]");
  if (!button || !state.report) return;
  try {
    localStorage.setItem("store-window", button.dataset.storeWindow);
  } catch {
    /* a per-viewer convenience */
  }
  renderStoreMetrics(state.report);
  renderFunnel(state.report);
});

function renderStoreMetrics(report) {
  const section = report.sections?.shopify;
  const data = report.detail?.shopify;
  const host = $("store-metrics");

  if (!section?.present) {
    host.innerHTML = `<div class="note"><strong>Store metrics unavailable.</strong> ${esc(section?.reason ?? "not collected")}</div>`;
    if ($("store-windows")) $("store-windows").innerHTML = "";
    return;
  }

  renderStoreWindowToggle(data);
  const windowKey = storeWindowKey(data);
  const shownWindow = (data?.windows ?? []).find((w) => w.key === windowKey) ?? data?.primaryWindow;
  renderStoreHeaderCount();

  host.innerHTML = (data?.tiles ?? [])
    .map((stored) => {
      const view = storeTileView(stored, data, windowKey);
      const t = { ...stored, value: view.value, comparisons: view.comparisons, companions: view.companions };
      if (!stored.available || t.value == null) {
        return `<div class="metric"><div class="metric-label">${esc(t.label)}</div><div class="metric-value muted">—</div><div class="metric-delta">${esc(t.reason ?? "unavailable")}</div></div>`;
      }

      // A rate is shown to the cent; a large total does not need the cents.
      const precise = t.kind === "rate" && t.format === "money";

      // Each chip states the other window's own number, then how the big number compares
      // with it. A bare "Yest -0.7%" read as "yesterday fell", when it meant the month is
      // 0.7% below yesterday: the opposite. A total is compared per day, so the chip shows
      // the other window per day.
      const primaryLabel = shownWindow?.label ?? "This period";
      const cmps = (t.comparisons ?? [])
        .map((c) => {
          const perDay = c.basis === "per day";
          // Reports from before the per-day value was stored have none; the next refresh fills it.
          const shown = perDay ? c.perDay ?? null : c.value;
          const theirs = `${formatMetric(shown, t.format, { precise: precise || perDay })}${perDay ? "/d" : ""}`;
          if (c.changePct == null) return `<span class="cmp">vs ${esc(c.label)} ${esc(shown == null ? "—" : theirs)}</span>`;
          const up = c.changePct > 0;
          // Direction is not the same as good. Discounts are stored negative, so a rise
          // means less discounting, which is why goodDirection lives on the tile.
          const good = t.goodDirection === "down" ? !up : up;
          const said = `${primaryLabel} ${formatMetric(t.value, t.format, { precise })}${perDay ? " (per day)" : ""} is ${Math.abs(c.changePct)}% ${up ? "higher" : "lower"} than ${c.label} ${theirs}`;
          return `<span class="cmp ${good ? "good" : "bad"}" title="${esc(said)}">vs ${esc(c.label)} ${esc(theirs)} · ${up ? "+" : "−"}${esc(Math.abs(c.changePct))}%</span>`;
        })
        .join("");

      // An info affordance only where there is something to explain.
      const detail = [
        t.description,
        ...(t.companions ?? []).map(
          (c) => `${c.label}: ${c.value == null ? "unavailable" : formatMetric(c.value, c.format, { precise: true })}${c.description ? ` — ${c.description}` : ""}`,
        ),
        t.formula ? `Formula: ${t.formula}` : null,
        t.filter ? `Filter: ${t.filter}` : null,
        t.kind === "total" ? "Compared per day, because the windows are different lengths." : null,
      ]
        .filter(Boolean)
        .join("\n\n");

      const info = detail
        ? `<button class="info-btn" data-detail="${esc(detail)}" data-title="${esc(t.label)}" aria-label="What is ${esc(t.label)}?">i</button>`
        : "";

      return `<div class="metric">
        <div class="metric-label">${esc(t.label)}${info}</div>
        <div class="metric-value">${esc(formatMetric(t.value, t.format, { precise }))}</div>
        <div class="metric-cmps">${cmps}</div>
        ${shopifyLinksRow(t.shopifyLinks, data?.windows)}
      </div>`;
    })
    .join("");

  const win = shownWindow;
  const others = (data?.windows ?? []).filter((w) => w.key !== win?.key).map((w) => w.label).join(", ");
  $("store-sub").innerHTML =
    `${esc(data?.shopDomain ?? "")} · showing <strong>${esc(STORE_WINDOW_NAMES[win?.key] ?? win?.label ?? "")}</strong>${win?.days > 1 ? ` (${esc(win.days)} complete days)` : ""} against ${esc(others)}. Every period ends yesterday, so today's partial day never skews a comparison. ` +
    `Totals are compared per day, marked <span class="basis">/d</span>, because a month-to-date total against a 7 day total measures the window, not the business. ` +
    `Context for everything below: a sitewide move is not a test result.`;
}

/**
 * The conversion funnel.
 *
 * Bar width is the share of all sessions, so the collapse from sessions to purchases is
 * visible at a glance. The number that actually matters per row is the step rate — the
 * share of the row above — because that is where a drop-off lives and it is the only
 * figure comparable across windows of different lengths.
 */
function renderFunnel(report) {
  const host = $("funnel");
  const f = report.detail?.shopify?.funnel;
  if (!f || !report.sections?.shopify?.present) {
    host.innerHTML = "";
    return;
  }

  const pct = (v, digits = 1) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);

  // The funnel follows the store tiles' period. Its steps for any window are stored
  // alongside the primary's; a report from before that shows the primary with a note.
  const data = report.detail?.shopify;
  const key = storeWindowKey(data);
  const windows = data?.windows ?? [];
  const label = (k) => windows.find((w) => w.key === k)?.label ?? k;
  const primaryKey = data?.primaryWindow?.key ?? f.window?.key;
  const stepsFor = (k) => f.byWindow?.[k] ?? (k === primaryKey ? f.steps : null);
  const shownKey = stepsFor(key) ? key : primaryKey;
  const steps = (stepsFor(shownKey) ?? []).map((step, index) => ({
    ...step,
    comparisons: windows
      .filter((w) => w.key !== shownKey && stepsFor(w.key))
      .map((w) => {
        const other = stepsFor(w.key)[index];
        const cmp = compareStore(step.ofPrevious, other?.ofPrevious ?? null, { kind: "rate" });
        return { window: w.key, label: w.label, ofPrevious: other?.ofPrevious ?? null, count: other?.count ?? null, changePct: cmp.changePct };
      }),
  }));
  const fw = { key: shownKey, label: label(shownKey) };
  const stale = shownKey !== key ? `<p class="meta">The funnel for ${esc(label(key))} appears after the next refresh. Showing ${esc(fw.label)}.</p>` : "";

  const rows = steps
    .map((step, index) => {
      const width = step.ofTop == null ? 0 : Math.max(step.ofTop * 100, 0.4);
      // The top step has no step rate, so nothing to compare.
      const cmps = (index === 0 ? [] : step.comparisons ?? [])
        .map((c) => {
          if (c.changePct == null) return `<span class="cmp">${esc(c.label)} —</span>`;
          const good = c.changePct > 0; // a higher step rate is always better
          return `<span class="cmp ${good ? "good" : "bad"}" title="${esc(`${fw.label} step rate ${pct(step.ofPrevious)} is ${Math.abs(c.changePct)}% ${good ? "higher" : "lower"} than ${c.label} ${pct(c.ofPrevious)}`)}">vs ${esc(c.label)} ${esc(pct(c.ofPrevious))} · ${good ? "+" : "−"}${esc(Math.abs(c.changePct))}%</span>`;
        })
        .join("");

      // The drop-off between this row and the one above, which is the actionable number.
      const lost = index === 0 || step.ofPrevious == null ? null : 1 - step.ofPrevious;

      return `<div class="funnel-row">
        <div class="funnel-head">
          <span class="funnel-label">${esc(step.label)}</span>
          <span class="funnel-count">${esc(COUNT.format(step.count ?? 0))}</span>
        </div>
        <div class="funnel-track"><div class="funnel-bar" style="width:${width}%"></div></div>
        <div class="funnel-meta">
          ${index === 0
            ? `<span class="funnel-step">top of funnel</span>`
            : `<span class="funnel-step">${esc(pct(step.ofPrevious))} of ${esc(steps[index - 1].label.toLowerCase())}</span>
               <span class="funnel-lost">${esc(pct(lost))} lost</span>`}
          <span class="funnel-oftop">${esc(pct(step.ofTop, 2))} of sessions</span>
          ${cmps}
        </div>
      </div>`;
    })
    .join("");

  host.innerHTML = `
    <h3 class="funnel-title">${esc(f.label)} <span class="meta">${esc(STORE_WINDOW_NAMES[fw.key] ?? fw.label)} · comparisons are on the step rate, not the count</span></h3>
    ${stale}
    ${shopifyLinksRow(f.shopifyLinks, report.detail?.shopify?.windows)}
    <div class="funnel">${rows}</div>`;
}

function tile(n, k) {
  return `<div class="tile"><div class="n">${esc(n)}</div><div class="k">${esc(k)}</div></div>`;
}

function renderFlags(container, flags, emptyText) {
  if (flags.length === 0) {
    container.innerHTML = `<p class="sub">${esc(emptyText)}</p>`;
    return;
  }
  container.innerHTML = flags.map(flagCard).join("");
}

/* ------------------------------- flag triage -------------------------------
   Triage is read from the live ledger the report endpoint sends alongside the report,
   so a flag handled after the 8 AM run shows as handled. A snooze or a wait runs out on
   its date, the same rule the pipeline applies. */

const TRIAGE_LABEL = { done: "Done", snoozed: "Snoozed", waiting: "Waiting on", dismissed: "Not a problem" };
const keyOf = (flag) => flag.key ?? String(flag.id ?? "").replace(/^(\d{4}-\d{2}-\d{2}|nodate):/, "");
const isAttn = (f) => f.severity === "p1" || f.severity === "attention";
// Store moves and control-group moves are context for reading results, not things to
// act on: shown with the store numbers, never in a flag list. Mirrors CONTEXT_RULES.
const CONTEXT_RULES = new Set(["shopify.metric_moved", "intelligems.control_moved"]);
const isContextFlag = (f) => CONTEXT_RULES.has(f?.rule);

function triageOf(flag) {
  const t = state.flagEntries ? state.flagEntries[keyOf(flag)]?.triage : flag.triage;
  if (!t?.status) return null;
  if (t.until && state.today && t.until <= state.today) return null;
  return t;
}
const viewOf = (flag) => {
  if (isContextFlag(flag)) return "context";
  const t = triageOf(flag);
  return !t ? "open" : t.status === "waiting" ? "waiting" : "parked";
};

function fmtDay(key) {
  if (!key) return "";
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function flagTiles(flags) {
  const open = flags.filter((f) => viewOf(f) === "open");
  return [
    tile(open.filter((f) => f.severity === "p1").length, "P1"),
    tile(open.filter((f) => f.severity === "attention").length, "Attention"),
    tile(open.filter((f) => f.severity === "prompt").length, "Decisions due"),
  ].join("");
}

/** Everything that shows flags, redrawn together so a triage moves a flag everywhere at once. */
function renderAllFlags({ rebuildTools = false } = {}) {
  const flags = state.report?.flags ?? [];
  if ($("flag-tiles")) $("flag-tiles").innerHTML = flagTiles(flags);
  renderStoreContext(flags);
  renderTopThree(flags);
  // The 1:1 view shows the same flags, so a triage there redraws it too.
  if (!$("view-people")?.classList.contains("hidden")) renderPeople();
  if (rebuildTools) renderAttentionTools(flags);
  renderAttention();
  const open = flags.filter((f) => viewOf(f) === "open");
  const handled = (sev) => flags.filter((f) => f.severity === sev && !["open", "context"].includes(viewOf(f))).length;
  const note = (n) => (n ? ` ${plural(n, "handled item is", "handled items are")} under Waiting and Parked above.` : "");
  renderFlags($("prompts"), open.filter((f) => f.severity === "prompt"), `No test is waiting on a decision.${note(handled("prompt"))}`);
  renderFlags($("hygiene"), open.filter((f) => f.severity === "info"), `Nothing outstanding.${note(handled("info"))}`);

  // The collapsed headers are the summary, so each says how much is inside.
  const attn = open.filter(isAttn);
  const p1 = attn.filter((f) => f.severity === "p1").length;
  sectionCount("attention", attn.length ? `${attn.length} open${p1 ? ` · ${p1} P1` : ""}` : "nothing open", p1 > 0);
  sectionCount("prompts", plural(open.filter((f) => f.severity === "prompt").length, "item", "items"));
  sectionCount("hygiene", plural(open.filter((f) => f.severity === "info").length, "item", "items"));
}

/**
 * Site-wide moves, above the store tiles: store metrics that moved, and control groups
 * that moved with them. Read before any test result, and nothing to triage.
 */
/**
 * Today's 3: the three open flags to do first. A copy of src/delta/priority.js so the
 * list re-ranks as flags are handled during the day; a test pins that the two agree.
 */
const PRIORITY_BASE = { p1: 100, attention: 50, prompt: 40 };
function priorityScore(flag) {
  const base = PRIORITY_BASE[flag.severity];
  if (base == null) return null;
  const age = Math.min(flag.openDays ?? 0, 10) * 3;
  const escalated = flag.escalated ? 10 : 0;
  const rock = flag.layer === 1 || flag.subject?.type === "priority" || flag.rule === "intelligems.ready_for_call" ? 15 : 0;
  return base + age + escalated + rock;
}
function topFlags(flags, n = 3) {
  return flags
    .map((flag, index) => ({ flag, index, score: triageOf(flag) || isContextFlag(flag) ? null : priorityScore(flag) }))
    .filter((x) => x.score != null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, n)
    .map((x) => x.flag);
}

function renderTopThree(flags) {
  const host = $("start-here");
  if (!host) return;
  const top = topFlags(flags);
  host.innerHTML = top.length
    ? `<div class="start-here-head"><h2>Today's 3</h2><span class="meta">start here: ranked by severity, how long each has been open, and whether it touches a rock</span></div>
       ${top.map(flagCard).join("")}`
    : `<div class="start-here-head"><h2>Today's 3</h2><span class="meta">nothing open that needs you. The full lists are below.</span></div>`;
}

/**
 * This week: the Friday roll-up, any day. The same lines the Friday readout leads with,
 * and a button to copy them, for a summary to leadership.
 */
function renderWeek(report) {
  const host = $("week");
  if (!host) return;
  const w = report.detail?.weekly;
  if (!w?.lines) {
    host.innerHTML = `<p class="sub">The week in review appears after the next refresh.</p>`;
    sectionCount("week", "");
    return;
  }
  sectionCount("week", `${plural(w.rocks.shipped.length, "rock shipped", "rocks shipped")} · ${plural(w.tickets.closed, "ticket closed", "tickets closed")}`);
  host.innerHTML = `
    <p class="sub">Since ${esc(new Date(w.since).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }))}. Friday's readout opens with this.</p>
    <ul class="week-lines">${w.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
    <div class="bar" style="margin-top:8px"><button type="button" class="ghost sm" id="copy-week">Copy the week</button><span class="meta" id="copy-week-note"></span></div>`;
}

document.addEventListener("click", async (event) => {
  if (event.target.id !== "copy-week") return;
  const lines = state.report?.detail?.weekly?.lines ?? [];
  try {
    await navigator.clipboard.writeText(["The week in review", ...lines.map((l) => `- ${l}`)].join("\n"));
    $("copy-week-note").textContent = "Copied.";
  } catch {
    $("copy-week-note").textContent = "The browser would not copy. Select the lines and copy them by hand.";
  }
});

function renderStoreContext(flags) {
  const host = $("store-context");
  if (!host) return;
  const context = flags.filter(isContextFlag);
  state.storeContextCount = context.length;
  host.innerHTML = context.length
    ? `<div class="store-context"><p class="store-context-head">Site-wide moves <span class="meta">read every test result against these</span></p>
        ${context
          .map((f) => `<p class="store-context-line ${f.severity === "attention" || f.severity === "p1" ? "bad" : "neutral"}">${esc(f.message)}</p>`)
          .join("")}</div>`
    : "";
  if (state.report) renderStoreHeaderCount();
}

function renderStoreHeaderCount() {
  const data = state.report?.detail?.shopify;
  const key = storeWindowKey(data);
  const win = (data?.windows ?? []).find((w) => w.key === key) ?? data?.primaryWindow;
  const n = state.storeContextCount ?? 0;
  sectionCount("store", `${STORE_WINDOW_NAMES[win?.key] ?? win?.label ?? ""}${n ? ` · ${plural(n, "site-wide move", "site-wide moves")}` : ""}`);
}

function sectionCount(name, text, urgent = false) {
  const el = $(`sec-${name}-count`);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("urgent", urgent);
}

function ageBadges(flag) {
  const out = [];
  if (flag.isNew) out.push(`<span class="chip age-new">new today</span>`);
  else if (flag.openDays) out.push(`<span class="chip">open ${esc(plural(flag.openDays, "working day", "working days"))}</span>`);
  if (flag.escalated) out.push(`<span class="chip bad" title="Left at Attention past the escalation mark, so it is now a P1">escalated</span>`);
  return out.join("");
}

function triageBanner(flag, t) {
  const what =
    t.status === "waiting"
      ? `Waiting on <strong>${esc(t.waitingOn)}</strong> until ${esc(fmtDay(t.until))}`
      : t.status === "snoozed"
        ? `Snoozed until ${esc(fmtDay(t.until))}`
        : `<strong>${esc(TRIAGE_LABEL[t.status] ?? t.status)}</strong>`;
  return `<p class="triage-state">${what}${t.note ? ` · ${esc(t.note)}` : ""}
    <button type="button" class="link-btn" data-triage="clear">Undo</button></p>`;
}

function triageActions() {
  return `<div class="triage-actions">
      <button type="button" class="ghost sm" data-triage="done" title="Handled. Hidden until the condition clears and comes back.">Done</button>
      <select class="sm" data-triage="snooze" aria-label="Snooze">
        <option value="">Snooze…</option>
        <option value="1">1 working day</option>
        <option value="3">3 working days</option>
        <option value="5">1 week</option>
      </select>
      <button type="button" class="ghost sm" data-triage="waiting-open">Waiting on…</button>
      <button type="button" class="ghost sm" data-triage="dismiss-open">Not a problem…</button>
      <button type="button" class="ghost sm" data-triage="nudge-open" title="A message for you to send yourself">Draft a nudge</button>
    </div>
    <div class="triage-panel hidden"></div>`;
}

function flagCard(flag) {
  const ctx = flagContext(flag);
  const t = triageOf(flag);
  const links = ctx.links
    .map((l) =>
      l.external
        ? `<a href="${esc(l.href)}" target="_blank" rel="noreferrer">${esc(l.label)} ↗</a>`
        : `<a href="${esc(l.href)}">${esc(l.label)}</a>`,
    )
    .join("");
  return `
      <div class="flag sev-${esc(flag.severity)}"${t ? " data-triaged" : ""} data-flag="${esc(flag.id)}" data-key="${esc(keyOf(flag))}" data-layer="${esc(flag.layer)}">
        <div class="row">
          <div>
            <p class="msg">${esc(flag.message)}</p>
            <p class="meta">${esc(layerLabel(flag.layer))} · ${esc(flag.rule)}${ctx.owners.length ? ` · ${esc(ctx.owners.join(", "))}` : ""}</p>
            <p class="flag-badges">${ageBadges(flag)}</p>
            ${links ? `<p class="flag-links">${links}</p>` : ""}
          </div>
          ${flag.advisable && !t ? `<button class="ghost advise" data-flag="${esc(flag.id)}">${esc(state.advisorButtonText)}</button>` : ""}
        </div>
        ${t ? triageBanner(flag, t) : `${quickFix(flag)}${triageActions()}`}
        <div class="advice hidden"></div>
      </div>`;
}

/* --------------------------- needs your attention ---------------------------
   A flag names its subject by type and id. These lookups turn that into who owns it and
   where to go to fix it: the ClickUp ticket, the rock editor, the test's readout and its
   Intelligems page. Subject ids carry a suffix per rule (`<rockId>:status`,
   `<testId>:gate`), so they are matched on the part before the first colon. */

const AREA_LABEL = { 1: "Leadership", cross: "Cross layer", 3: "Tests", 2: "Sprint", 0: "Store" };
const AREA_ORDER = ["1", "cross", "3", "2", "0"]; // the same order sortFlags uses
const NO_OWNER = "No owner";
const ATTN_GROUPS = { age: "New vs still open", area: "Area", owner: "Owner", rule: "Issue", item: "Item", none: "No grouping" };
const ATTN_VIEWS = { open: "Open", waiting: "Waiting", parked: "Parked" };

const baseId = (id) => String(id ?? "").split(":")[0];
const ruleLabel = (rule) => {
  const s = String(rule ?? "").split(".").pop().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function flagContextIndex(report) {
  const d = report.detail ?? {};
  return {
    tasks: new Map((d.clickup?.tasks ?? []).map((t) => [String(t.id), t])),
    tests: new Map((d.intelligems?.tests ?? []).map((t) => [String(t.id), t])),
    rocks: new Map([...(d.leadership?.queue ?? []), ...(d.leadership?.backlog ?? [])].map((r) => [String(r.id), r])),
  };
}

/** The flag's subject. Reports from before clickup.stale_in_status carried one rebuild it from the id. */
function subjectOf(flag) {
  if (flag.subject) return flag.subject;
  if (flag.rule === "clickup.stale_in_status") {
    return { type: "task", id: flag.id.slice(flag.id.indexOf(":") + 1), label: null, url: flag.url ?? null };
  }
  return { type: "none", id: flag.id, label: null };
}

function flagContext(flag) {
  const idx = state.flagCtx ?? { tasks: new Map(), tests: new Map(), rocks: new Map() };
  const subject = subjectOf(flag);
  const id = baseId(subject.id);
  const links = [];
  let owners = [];
  let itemLabel = subject.label;
  let url = null;

  switch (subject.type) {
    case "task": {
      const task = idx.tasks.get(id);
      itemLabel ??= task?.name;
      const owned = task?.taskOwners?.length ? task.taskOwners : task?.assignees ?? [];
      owners = owned.map((u) => u.username).filter(Boolean);
      url = subject.url ?? flag.url ?? task?.url ?? null;
      if (url) links.push({ label: "ClickUp", href: url, external: true });
      links.push({ label: "Sprint", href: "#sprint" });
      break;
    }
    case "test": {
      const test = idx.tests.get(id);
      itemLabel ??= test?.name;
      // The Tests view's notes, when loaded, are newer than the report: an owner chosen
      // there this afternoon counts now rather than at tomorrow's run.
      const assignee = state.testNotes?.notes?.[id]?.assignee;
      const named = assignee ? (state.testNotes.assignees ?? []).find((p) => String(p.id) === String(assignee))?.name : null;
      const owner = named ?? test?.owner?.name;
      if (owner) owners = [owner];
      url = test?.consoleUrl ?? null;
      if (test) links.push({ label: "Test readout", href: `#tests/${encodeURIComponent(id)}` });
      if (url) links.push({ label: "Intelligems", href: url, external: true });
      break;
    }
    case "priority": {
      const rock = idx.rocks.get(id);
      if (rock?.owner?.name) owners = [rock.owner.name];
      links.push({ label: "Edit rock", href: `#rocks/${encodeURIComponent(id)}` });
      if (rock?.intelligemsExperienceId) {
        links.push({ label: "Test readout", href: `#tests/${encodeURIComponent(rock.intelligemsExperienceId)}` });
      }
      break;
    }
    case "person":
      owners = subject.label ? [subject.label] : [];
      links.push({ label: "Their rocks", href: `#rocks/${encodeURIComponent(subject.label ?? "")}` });
      links.push({ label: "Cross layer", href: "#readout/cross" });
      links.push({ label: "Sprint", href: "#sprint" });
      break;
    case "field":
      // The dropdown flags are fixed by relinking rocks; the missing-field ones in Setup.
      links.push(String(flag.rule).startsWith("leadership.dropdown_") ? { label: "Rocks", href: "#rocks" } : { label: "Setup", href: "#setup" });
      break;
    case "list":
      links.push({ label: "Sprint", href: "#sprint" });
      break;
    case "queue":
    case "swingOption":
      links.push({ label: "Rocks", href: "#rocks" });
      break;
    case "metric":
      links.push({ label: "Store metrics", href: "#readout/store-head" });
      break;
  }
  return { owners, links, url, itemKey: `${subject.type}:${id}`, itemLabel: itemLabel ?? ruleLabel(flag.rule) };
}

function loadAttnPrefs() {
  const defaults = { view: "open", sev: "", area: "", owner: "", q: "", group: "age" };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem("attn-prefs") ?? "{}"), view: "open", q: "" };
  } catch {
    return defaults;
  }
}
function saveAttnPrefs() {
  try {
    const { sev, area, owner, group } = state.attn;
    localStorage.setItem("attn-prefs", JSON.stringify({ sev, area, owner, group }));
  } catch {
    /* a per-viewer convenience; nothing is lost without it */
  }
}

/**
 * The flags a view lists. Open is the attention list. Waiting and Parked hold every
 * handled flag whatever its severity, because they are where a handled hygiene item or
 * decision prompt is found again and undone.
 */
function flagsForView(view) {
  const flags = state.report?.flags ?? [];
  return view === "open" ? flags.filter((f) => isAttn(f) && viewOf(f) === "open") : flags.filter((f) => viewOf(f) === view);
}

/** The toolbar is built once per report, so typing in the search box keeps its focus. */
function renderAttentionTools(flags) {
  state.attn ??= loadAttnPrefs();
  const a = state.attn;
  const pool = flags.filter((f) => !isContextFlag(f) && (isAttn(f) || viewOf(f) !== "open"));

  const areas = AREA_ORDER.filter((k) => pool.some((f) => String(f.layer) === k));
  const owners = [...new Set(pool.flatMap((f) => { const o = flagContext(f).owners; return o.length ? o : [NO_OWNER]; }))]
    .sort((x, y) => (x === NO_OWNER) - (y === NO_OWNER) || x.localeCompare(y));
  // A remembered filter for an area or owner with nothing today would hide everything.
  if (a.area && !areas.includes(a.area)) a.area = "";
  if (a.owner && !owners.includes(a.owner)) a.owner = "";
  if (!ATTN_GROUPS[a.group]) a.group = "age";

  const option = (value, label, selected) => `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`;

  $("attention-tools").innerHTML = pool.length
    ? `<div class="dod-windows" role="group" aria-label="Show">${Object.entries(ATTN_VIEWS)
        .map(([k, l]) => `<button type="button" class="ghost dod-window" data-view-attn="${k}">${esc(l)} <span data-count="${k}"></span></button>`)
        .join("")}</div>
       <div class="dod-windows" role="group" aria-label="Severity">${[["", "All"], ["p1", "P1"], ["attention", "Attention"]]
         .map(([k, l]) => `<button type="button" class="ghost dod-window" data-sev="${k}">${esc(l)}</button>`)
         .join("")}</div>
       <select id="attn-area" aria-label="Area">${option("", "All areas", a.area)}${areas.map((k) => option(k, AREA_LABEL[k] ?? k, a.area)).join("")}</select>
       <select id="attn-owner" aria-label="Owner">${option("", "All owners", a.owner)}${owners.map((o) => option(o, o, a.owner)).join("")}</select>
       <input id="attn-q" type="search" placeholder="Search" aria-label="Search flags" value="${esc(a.q)}">
       <label class="attn-group">Group by <select id="attn-group">${Object.entries(ATTN_GROUPS).map(([k, l]) => option(k, l, a.group)).join("")}</select></label>
       <span class="meta" id="attn-count"></span>`
    : "";
}

function renderAttention() {
  const a = state.attn ?? (state.attn = loadAttnPrefs());
  const all = flagsForView(a.view);
  const q = a.q.trim().toLowerCase();

  const shown = all.filter((f) => {
    if (a.sev && f.severity !== a.sev) return false;
    if (a.area && String(f.layer) !== a.area) return false;
    const ctx = flagContext(f);
    if (a.owner && !(ctx.owners.length ? ctx.owners : [NO_OWNER]).includes(a.owner)) return false;
    if (q && !`${f.message} ${f.rule} ${ctx.owners.join(" ")} ${ctx.itemLabel} ${triageOf(f)?.waitingOn ?? ""}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const toggle = (selector, attr, current) => {
    for (const button of document.querySelectorAll(`#attention-tools [${selector}]`)) {
      const on = button.getAttribute(selector) === current;
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
    }
  };
  toggle("data-view-attn", "view", a.view);
  toggle("data-sev", "sev", a.sev);
  for (const k of Object.keys(ATTN_VIEWS)) {
    const el = document.querySelector(`#attention-tools [data-count="${k}"]`);
    if (el) el.textContent = flagsForView(k).length;
  }
  if ($("attn-count")) $("attn-count").textContent = shown.length === all.length ? plural(all.length, "item", "items") : `${shown.length} of ${all.length} shown`;

  const host = $("attention");
  if (all.length === 0) {
    const empty = { open: "Nothing flagged.", waiting: "Nothing is waiting on anyone.", parked: "Nothing done, snoozed or set aside." }[a.view];
    return renderFlags(host, [], empty);
  }
  if (shown.length === 0) {
    host.innerHTML = `<p class="sub">Nothing matches these filters. <button type="button" class="ghost" id="attn-clear">Clear filters</button></p>`;
    return;
  }
  if (a.group === "none") return renderFlags(host, shown, "");

  // A flag with two owners shows under each, so filtering by either finds it.
  const groups = new Map();
  const put = (key, label, flag) => {
    if (!groups.has(key)) groups.set(key, { label, flags: [] });
    groups.get(key).flags.push(flag);
  };
  for (const f of shown) {
    const ctx = flagContext(f);
    if (a.group === "age") f.isNew ? put("new", "New today", f) : put("still", "Still open", f);
    else if (a.group === "area") put(String(f.layer), AREA_LABEL[f.layer] ?? layerLabel(f.layer), f);
    else if (a.group === "rule") put(f.rule, ruleLabel(f.rule), f);
    else if (a.group === "item") put(ctx.itemKey, ctx.itemLabel, f);
    else for (const o of ctx.owners.length ? ctx.owners : [NO_OWNER]) put(o, o, f);
  }

  let ordered = [...groups.entries()];
  if (a.group === "age") ordered.sort(([x]) => (x === "new" ? -1 : 1));
  else if (a.group === "area") ordered.sort(([x], [y]) => AREA_ORDER.indexOf(x) - AREA_ORDER.indexOf(y));
  else if (a.group === "owner") ordered.sort(([x], [y]) => (x === NO_OWNER) - (y === NO_OWNER) || x.localeCompare(y));
  // Issue and item groups keep flag order, so whatever holds the first P1 leads.

  state.openGroups ??= new Set();
  host.innerHTML = ordered
    .map(([key, g]) => {
      const p1 = g.flags.filter((f) => f.severity === "p1").length;
      // Collapsed to start. A group opened stays open when a triage redraws the list.
      const groupKey = `${a.view}:${a.group}:${key}`;
      return `<details class="flag-group" data-group="${esc(groupKey)}"${state.openGroups.has(groupKey) ? " open" : ""}>
        <summary><span class="flag-group-name">${esc(g.label)}</span> <span class="meta">${g.flags.length}${p1 ? ` · ${p1} P1` : ""}</span></summary>
        ${g.flags.map(flagCard).join("")}
      </details>`;
    })
    .join("");
}

$("attention-tools").addEventListener("click", (event) => {
  const view = event.target.closest("[data-view-attn]");
  const sev = event.target.closest("[data-sev]");
  if (view) state.attn.view = view.dataset.viewAttn;
  else if (sev) state.attn.sev = sev.dataset.sev;
  else return;
  saveAttnPrefs();
  renderAttention();
});
$("attention-tools").addEventListener("change", (event) => {
  const key = { "attn-area": "area", "attn-owner": "owner", "attn-group": "group" }[event.target.id];
  if (!key) return;
  state.attn[key] = event.target.value;
  saveAttnPrefs();
  renderAttention();
});
$("attention-tools").addEventListener("input", (event) => {
  if (event.target.id !== "attn-q") return;
  state.attn.q = event.target.value;
  renderAttention();
});
// <details> does not bubble its toggle event, so it is caught on the way down.
$("attention").addEventListener(
  "toggle",
  (event) => {
    const key = event.target?.dataset?.group;
    if (!key) return;
    state.openGroups ??= new Set();
    if (event.target.open) state.openGroups.add(key);
    else state.openGroups.delete(key);
  },
  true,
);

$("attention").addEventListener("click", (event) => {
  if (event.target.id !== "attn-clear") return;
  Object.assign(state.attn, { sev: "", area: "", owner: "", q: "" });
  saveAttnPrefs();
  renderAttentionTools(state.report?.flags ?? []);
  renderAttention();
});

/* -------------------------------- quick fixes --------------------------------
   A Layer 1 flag is about a rock, and rocks are this system's own data, so the fix can
   sit on the flag: the one field the rule is about, saved through the same rocks API
   the editor uses, versioned and audited the same way. A flag fixed here is marked Done,
   and the next run clears it for good once the rule no longer fires.

   ClickUp and Intelligems flags get no quick fix. The system does not write to those
   platforms; their links go there instead. */

const todayKey = () => state.today ?? new Date().toISOString().slice(0, 10);
const rockById = (id) => (state.rocks?.rocks ?? []).find((r) => String(r.id) === String(id)) ?? null;

/** Rules whose fix is one field on one rock: what to show and what it writes. */
const ROCK_FIXES = {
  "leadership.mini_readout_overdue": "checkin",
  "leadership.mini_readout_unknown": "checkin",
  "leadership.check_in_overdue": "checkin",
  "leadership.rock_at_risk": "status",
  "leadership.shipped_without_date": "shipped",
  "leadership.rock_without_kpi": "kpi",
  "leadership.unassigned": "owner",
  "leadership.rock_not_linked": "link",
  "crosslayer.rock_work_stalled": "stalled",
};

function quickFix(flag) {
  if (!String(flag.rule).startsWith("leadership.") && !["crosslayer.big_swing_without_rock", "crosslayer.rock_work_stalled"].includes(flag.rule)) return "";
  if (!state.rocks) return `<div class="quick-fix"><span class="meta">Loading the rock to edit…</span></div>`;
  const subject = subjectOf(flag);
  const kind = ROCK_FIXES[flag.rule];

  if (kind) {
    const rock = rockById(baseId(subject.id));
    if (!rock) return "";
    const id = esc(rock.id);
    const field = (inner) => `<div class="quick-fix" data-rock="${id}">${inner}</div>`;
    switch (kind) {
      case "checkin":
        return field(`
          <button type="button" class="sm" data-qf="checkin-today">Checked in today</button>
          <label>or on <input type="date" class="sm" data-qf-input="checkInDate" value="${esc(rock.checkInDate ?? "")}"></label>
          <button type="button" class="ghost sm" data-qf="save" data-field="checkInDate">Save date</button>`);
      case "stalled": {
        // Say it is in trouble, or that you looked and it is fine; the tickets are where to
        // see why it stopped.
        const tickets = (flag.values?.tickets ?? [])
          .map((t) => `<a href="${esc(t.url ?? "#")}" target="_blank" rel="noreferrer">${esc(t.name)} · ${esc(t.idleDays)}d ↗</a>`)
          .join("");
        return field(`
          ${rock.status === "at_risk" ? "" : `<button type="button" class="sm" data-qf="set" data-field="status" data-value="at_risk">Mark At Risk</button>`}
          <button type="button" class="ghost sm" data-qf="checkin-today">Checked in today</button>
          ${tickets ? `<span class="flag-links">${tickets}</span>` : ""}`);
      }
      case "status":
        return field(`
          <span class="meta">Status</span>
          <button type="button" class="sm" data-qf="set" data-field="status" data-value="on_track">Back on track</button>
          <button type="button" class="ghost sm" data-qf="set" data-field="status" data-value="done">Done</button>
          <button type="button" class="ghost sm" data-qf="set" data-field="state" data-value="backlog">Move to backlog</button>`);
      case "shipped":
        return field(`
          <label>Shipped on <input type="date" class="sm" data-qf-input="shippedAt" max="${esc(todayKey())}" value="${esc(todayKey())}"></label>
          <button type="button" class="sm" data-qf="save" data-field="shippedAt">Save</button>`);
      case "kpi":
        return field(`
          <label class="grow">KPI <input type="text" class="sm" data-qf-input="kpi" placeholder="The number that says whether it worked"></label>
          <button type="button" class="sm" data-qf="save" data-field="kpi">Save</button>`);
      case "owner": {
        const people = state.rocks.people ?? [];
        return field(`
          <label>Owner <select class="sm" data-qf-input="owner"><option value="">Choose…</option>${people.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></label>
          <button type="button" class="sm" data-qf="save" data-field="owner">Assign</button>
          <button type="button" class="ghost sm" data-qf="set" data-field="state" data-value="backlog">Move to backlog</button>`);
      }
      case "link": {
        // Tickets reach a rock through the Big Swing field, so that is the link to set.
        const swings = state.rocks.bigSwingOptions ?? { available: false, options: [] };
        if (!swings.available || !swings.options?.length) return field(`<span class="meta">The Big Swing options could not be loaded${swings.reason ? `: ${esc(swings.reason)}` : ""}. Use Edit rock.</span>`);
        return field(`
          <label>Big Swing <select class="sm" data-qf-input="clickupBigSwingOptionId"><option value="">Choose…</option>${swings.options.map((o) => `<option value="${esc(o.id)}"${o.label.toLowerCase() === String(rock.title).toLowerCase() ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select></label>
          <button type="button" class="sm" data-qf="save" data-field="clickupBigSwingOptionId">Link</button>`);
      }
    }
  }

  // Work on a Big Swing no live rock claims. Per Big Swing: add it as a rock, owned by
  // the person doing the work and linked to it; or link an existing rock to it; or, when
  // its rock is in the backlog, make that rock active.
  if (flag.rule === "crosslayer.big_swing_without_rock") {
    // Older reports carry names only; those can still be added, just not linked by id.
    const refs = (flag.values?.swingRefs ?? (flag.values?.swings ?? []).map((label) => ({ label, optionId: null, parkedRockId: null }))).filter((ref) => !swingClaimed(ref));
    if (!refs.length) return "";
    return `<div class="quick-fix quick-fix-rows" data-multi="${esc(flag.rule)}">
      ${refs.map((ref) => swingRow(ref, { ownerId: flag.values?.ownerId ?? "" })).join("")}
      <span class="meta">A new rock is active, on track, owned by ${esc(subjectOf(flag).label ?? "them")} and linked to the Big Swing. Edit it afterwards for the KPI and dates.</span>
    </div>`;
  }

  // A Big Swing option in ClickUp that no live rock claims. The same fixes, plus an owner
  // to choose (nobody is doing the work in this flag's view) and "Not a rock", for an
  // option that is ongoing work rather than a project; that sets this one flag aside
  // while the option stays unclaimed, and the others stay.
  if (flag.rule === "leadership.dropdown_orphan_option") {
    const ref = { label: flag.values?.label ?? subjectOf(flag).label, optionId: flag.values?.optionId ?? null, parkedRockId: flag.values?.parkedRockId ?? null };
    if (!ref.optionId || swingClaimed(ref)) return "";
    return `<div class="quick-fix quick-fix-rows">
      ${swingRow(ref, { chooseOwner: true, notARock: true })}
      <span class="meta">A new rock is active and on track, linked to this Big Swing. Edit it afterwards for the KPI and dates.</span>
    </div>`;
  }

  // Rocks linked to a Big Swing option that is no longer in the dropdown: relink each.
  // Reports from before the flag carried rock ids name rocks by title only.
  if (flag.rule === "leadership.dropdown_missing_option") {
    const swings = state.rocks.bigSwingOptions ?? { available: false, options: [] };
    const current = new Set((swings.options ?? []).map((o) => String(o.id)));
    const rocks = (flag.values?.missing ?? [])
      .map((m) => (typeof m === "string" ? (state.rocks.rocks ?? []).find((r) => r.title === m) : rockById(m.id)))
      .filter((r) => r && r.state === "active" && !current.has(String(r.clickupBigSwingOptionId ?? "")));
    if (!rocks.length) return "";
    if (!swings.available || !swings.options?.length) return `<div class="quick-fix"><span class="meta">The Big Swing options could not be loaded${swings.reason ? `: ${esc(swings.reason)}` : ""}. Use Edit rock.</span></div>`;
    const choices = (rock) =>
      swings.options.map((o) => `<option value="${esc(o.id)}"${o.label.toLowerCase() === String(rock.title).toLowerCase() ? " selected" : ""}>${esc(o.label)}</option>`).join("");
    return `<div class="quick-fix quick-fix-rows" data-multi="${esc(flag.rule)}">
      ${rocks
        .map((r) => `<div class="qf-row" data-rock="${esc(r.id)}">
          <span class="qf-title">${esc(r.title)}</span>
          <select class="sm" data-qf-input="clickupBigSwingOptionId"><option value="">Choose a Big Swing…</option>${choices(r)}</select>
          <button type="button" class="sm" data-qf="save" data-field="clickupBigSwingOptionId">Link</button>
        </div>`)
        .join("")}
      <span class="meta">No option for it? Add one to the Big Swing field in ClickUp, then refresh.</span>
    </div>`;
  }

  // Too many rocks on one person, or unassigned rocks with nobody free: the fix is a
  // choice of which rocks go to the backlog, so list them.
  const backloggable =
    flag.rule === "leadership.over_capacity"
      ? (state.rocks.rocks ?? []).filter((r) => r.state === "active" && String(r.owner) === String(subject.id))
      : flag.rule === "leadership.should_be_backlogged"
        ? (state.rocks.rocks ?? []).filter((r) => r.state === "active" && !r.owner)
        : [];
  if (!backloggable.length) return "";
  return `<div class="quick-fix quick-fix-list" data-multi="${esc(flag.rule)}">
    <span class="meta">Move to the backlog:</span>
    ${backloggable
      .map((r) => `<span class="qf-rock" data-rock="${esc(r.id)}">${esc(r.title)}
          <button type="button" class="ghost sm" data-qf="set" data-field="state" data-value="backlog">Backlog</button></span>`)
      .join("")}
  </div>`;
}

/** Whether a live (active or shipped) rock already claims a Big Swing, by id or name. */
function swingClaimed(ref) {
  return (state.rocks?.rocks ?? []).some(
    (r) =>
      (r.state === "active" || r.state === "shipped") &&
      ((ref.optionId && String(r.clickupBigSwingOptionId ?? "") === String(ref.optionId)) ||
        String(r.title).trim().toLowerCase() === String(ref.label).trim().toLowerCase()),
  );
}

/**
 * One row of fixes for a Big Swing no live rock claims: add it as a rock, make its
 * backlog rock active, or link an existing rock to it. Shared by the person-level flag
 * (who is working on it) and the option-level one (nobody yet).
 */
function swingRow(ref, { ownerId = "", chooseOwner = false, notARock = false } = {}) {
  const sorted = (state.rocks?.rocks ?? []).slice().sort((a, b) => String(a.title).localeCompare(String(b.title)));
  const parked = ref.parkedRockId ? rockById(ref.parkedRockId) : null;
  // A rock named nearly the same ("Ready to Pour" for "New Products: Ready to Pour") is
  // almost always the one meant, so it is offered first.
  const likely = ref.optionId ? likelyRock(ref.label, sorted) : null;
  const rockChoices = sorted
    .map((r) => `<option value="${esc(r.id)}"${r.id === likely?.id ? " selected" : ""}>${esc(r.title)}${r.state === "active" ? "" : ` (${esc(r.state)})`}</option>`)
    .join("");
  const owners = (state.rocks?.people ?? []).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  return `<div class="qf-row" data-swing="${esc(ref.label)}" data-swing-id="${esc(ref.optionId ?? "")}" data-owner="${esc(ownerId)}">
    <span class="qf-title">${esc(ref.label)}</span>
    ${parked && parked.state === "backlog"
      ? `<button type="button" class="sm" data-qf="swing-activate" data-rock-id="${esc(parked.id)}">Make "${esc(parked.title)}" active</button>`
      : `${chooseOwner ? `<select class="sm" data-qf-input="swing-owner" aria-label="Owner"><option value="">Owner…</option>${owners}</select>` : ""}
         <button type="button" class="sm" data-qf="swing-add">Add as rock</button>`}
    ${ref.optionId
      ? `<select class="sm" data-qf-input="swing-rock" aria-label="Existing rock"><option value="">or link a rock…</option>${rockChoices}</select>
         <button type="button" class="${likely ? "" : "ghost "}sm" data-qf="swing-link">Link</button>
         ${likely ? `<span class="meta">Looks like "${esc(likely.title)}"</span>` : ""}`
      : ""}
    ${notARock ? `<button type="button" class="ghost sm" data-qf="swing-not-rock" title="Ongoing work, not a project: set this flag aside">Not a rock</button>` : ""}
  </div>`;
}

/**
 * The rock most likely meant by a Big Swing name that matches no rock exactly: the one
 * sharing the most words with it, as long as it shares at least half of the shorter
 * name's words. Null when nothing is close, rather than a guess.
 */
function likelyRock(label, rocks) {
  const words = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1));
  const want = words(label);
  let best = null;
  let bestScore = 0;
  for (const r of rocks) {
    const have = words(r.title);
    const shared = [...want].filter((w) => have.has(w)).length;
    const score = shared / Math.max(1, Math.min(want.size, have.size));
    if (shared > 0 && score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

/** What a fix did, in words, kept as the Done note so the Parked view says how it was fixed. */
function fixNote(field, value) {
  const people = new Map((state.rocks?.people ?? []).map((p) => [p.id, p.name]));
  if (field === "checkInDate") return `Checked in ${value}`;
  if (field === "shippedAt") return `Shipped date set to ${value}`;
  if (field === "kpi") return `KPI set: ${value}`;
  if (field === "owner") return `Assigned to ${people.get(value) ?? value}`;
  if (field === "clickupBigSwingOptionId") return "Linked to a Big Swing";
  if (field === "status") return `Status set to ${(state.rocks?.statusLabels ?? {})[value] ?? value}`;
  if (field === "state") return `Moved to ${value}`;
  return "Fixed";
}

/**
 * Whether the change actually ends the condition. A check-in dated before the window
 * still leaves the rock overdue, and marking that flag Done would hide it while the rule
 * keeps firing, so it stays open instead.
 */
function stillOverdue(flag, field, value) {
  const tolerance = flag?.values?.toleranceWindowDays;
  if (field !== "checkInDate" || tolerance == null) return null;
  const days = Math.round((Date.parse(todayKey()) - Date.parse(value)) / 86_400_000);
  return days > tolerance ? { days, tolerance } : null;
}

function saveRockField(card, rockId, field, value) {
  return saveRockPatch(card, { id: rockId, [field]: value }, { field, value, note: fixNote(field, value) });
}

/**
 * Writes one change to the rocks: a patch to an existing rock (with its id), or a new
 * rock (without). `field` and `value` are only for the check-in rule, which needs to
 * know whether the date actually ends the overdue condition.
 */
async function saveRockPatch(card, rock, { field = null, value = null, note = "Fixed" } = {}) {
  const errorAt = card.querySelector(".quick-fix");
  try {
    const res = await fetch(`${FN}/rocks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rock, version: state.rocks?.version }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Someone changed the rocks since this page loaded: take theirs, and say so.
      if (res.status === 409) await loadRocks();
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    state.rocks = { ...state.rocks, version: body.version, rocks: body.rocks };
    renderRocks();

    // A list fix is only done when nothing is left on the list.
    const multi = card.querySelector("[data-multi]");
    const flag = findFlag(card);
    const remaining = multi && flag ? quickFix(flag) : "";
    const overdue = stillOverdue(flag, field, value);
    if (overdue) {
      showQuickFixError(errorAt ?? card, `Saved, but ${value} is ${overdue.days} days ago, past the ${overdue.tolerance} day window, so this stays open.`);
    } else if (!multi || !remaining) {
      await saveTriage(card, { status: "done", note });
    } else {
      renderAllFlags();
    }
  } catch (err) {
    showQuickFixError(errorAt ?? card, `Not saved: ${err.message}`);
  }
}

function showQuickFixError(host, message) {
  let box = host.querySelector(".triage-error");
  if (!box) {
    box = document.createElement("p");
    box.className = "triage-error";
    host.append(box);
  }
  box.textContent = message;
}

document.addEventListener("click", (event) => {
  const el = event.target.closest("[data-qf]");
  if (!el) return;
  const card = el.closest(".flag[data-key]");

  // Unclaimed Big Swings: rows keyed on the swing, not on a rock.
  const row = el.closest("[data-swing]");
  if (card && row) {
    const label = row.dataset.swing;
    const optionId = row.dataset.swingId || null;
    if (el.dataset.qf === "swing-add") {
      const owner = row.dataset.owner || row.querySelector('[data-qf-input="swing-owner"]')?.value || null;
      return saveRockPatch(
        card,
        { title: label, state: "active", status: "on_track", owner, ...(optionId ? { clickupBigSwingOptionId: optionId } : {}) },
        { note: `Added "${label}" as a rock` },
      );
    }
    if (el.dataset.qf === "swing-not-rock") {
      return saveTriage(card, { status: "dismissed", note: `"${label}" is ongoing work, not a rock` });
    }
    if (el.dataset.qf === "swing-activate") {
      const id = el.dataset.rockId;
      return saveRockPatch(card, { id, state: "active", ...(optionId ? { clickupBigSwingOptionId: optionId } : {}) }, { note: `Made "${rockById(id)?.title ?? label}" active` });
    }
    if (el.dataset.qf === "swing-link") {
      const id = row.querySelector('[data-qf-input="swing-rock"]')?.value;
      if (!id) return showQuickFixError(el.closest(".quick-fix"), "Pick a rock first.");
      const rock = rockById(id);
      // A rock already on another Big Swing would lose that link, so say so first.
      if (rock?.clickupBigSwingOptionId && String(rock.clickupBigSwingOptionId) !== String(optionId)) {
        if (!window.confirm(`"${rock.title}" is linked to another Big Swing. Move its link to "${label}"?`)) return;
      }
      return saveRockPatch(card, { id, clickupBigSwingOptionId: optionId }, { note: `Linked "${rock?.title ?? id}" to ${label}` });
    }
    return;
  }

  const rockId = el.closest("[data-rock]")?.dataset.rock;
  if (!card || !rockId) return;

  if (el.dataset.qf === "checkin-today") return saveRockField(card, rockId, "checkInDate", todayKey());
  if (el.dataset.qf === "set") return saveRockField(card, rockId, el.dataset.field, el.dataset.value);
  if (el.dataset.qf === "save") {
    // A card fixing several rocks has one input per rock, so read the one in this row.
    const input = (el.closest("[data-rock]") ?? card).querySelector(`[data-qf-input="${el.dataset.field}"]`);
    const value = (input?.value ?? "").trim();
    if (!value) return showQuickFixError(el.closest(".quick-fix"), "Fill it in first.");
    return saveRockField(card, rockId, el.dataset.field, value);
  }
});

/* ------------------------------ triage actions ------------------------------ */

const findFlag = (card) => (state.report?.flags ?? []).find((f) => f.id === card.dataset.flag);

async function saveTriage(card, payload) {
  const errorBox = card.querySelector(".triage-error");
  try {
    const res = await fetch(`${FN}/flags`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: card.dataset.key, layer: card.dataset.layer, ...payload }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    applyEntry(body);
  } catch (err) {
    showPanelError(card, `Could not save: ${err.message}`, errorBox);
  }
}

function applyEntry(body) {
  state.flagEntries = { ...(state.flagEntries ?? {}), [body.key]: body.entry };
  if (body.today) state.today = body.today;
  renderAllFlags();
}

function showPanelError(card, message) {
  const panel = card.querySelector(".triage-panel") ?? card;
  panel.classList.remove("hidden");
  let box = panel.querySelector(".triage-error");
  if (!box) {
    box = document.createElement("p");
    box.className = "triage-error";
    panel.prepend(box);
  }
  box.textContent = message;
}

/** Everyone a flag could be waiting on: its owners first, then the roster. */
function peopleFor(flag) {
  const owners = flagContext(flag).owners;
  const roster = (state.people ?? []).map((p) => p.name);
  return [...new Set([...owners.map((o) => matchPerson(o)?.name ?? o), ...roster])];
}

/** The roster entry for a name as ClickUp spells it: exact, else a unique first-name match. */
function matchPerson(name) {
  const want = String(name ?? "").trim().toLowerCase();
  const people = state.people ?? [];
  const exact = people.filter((p) => p.name.toLowerCase() === want);
  if (exact.length === 1) return exact[0];
  const first = people.filter((p) => p.name.toLowerCase().split(/\s+/)[0] === want.split(/\s+/)[0]);
  return first.length === 1 ? first[0] : null;
}

/**
 * A nudge for Alex to send himself. The system never contacts the team, so this is only
 * ever copied: fixed wording, no model, edited before it is copied.
 */
function nudgeText(flag) {
  const { url } = flagContext(flag);
  return `Quick check on this: ${flag.message}${url ? ` ${url}` : ""}\nWhat's the next step, and when do you expect it to move?`;
}

function openPanel(card, kind) {
  const flag = findFlag(card);
  const panel = card.querySelector(".triage-panel");
  if (!flag || !panel) return;
  if (panel.dataset.kind === kind && !panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
  }
  panel.dataset.kind = kind;
  const people = peopleFor(flag);
  const personSelect = (id) =>
    `<select id="${id}" class="sm">${people.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("")}<option value="__other">Someone else…</option></select>`;

  if (kind === "waiting") {
    panel.innerHTML = `
      <label>Waiting on ${personSelect("tp-person")}</label>
      <label>Check back in <select id="tp-days" class="sm"><option value="1">1 working day</option><option value="2" selected>2 working days</option><option value="3">3 working days</option><option value="5">1 week</option></select></label>
      <button type="button" class="sm" data-triage="waiting-save">Save</button>`;
  } else if (kind === "dismiss") {
    panel.innerHTML = `
      <label class="wide">Why is it not a problem? <span class="meta">Optional. Kept with the flag, and useful feedback for the rules.</span>
        <textarea id="tp-note" rows="2"></textarea></label>
      <button type="button" class="sm" data-triage="dismiss-save">Set aside</button>`;
  } else if (kind === "nudge") {
    panel.innerHTML = `
      <label>To ${personSelect("tp-person")}</label>
      <label class="wide">Message <span class="meta">For you to send yourself. Nothing is sent from here.</span>
        <textarea id="tp-text" rows="4">${esc(nudgeText(flag))}</textarea></label>
      <button type="button" class="sm" data-triage="nudge-copy">Copy, and mark waiting</button>`;
  }
  panel.classList.remove("hidden");
}

function chosenPerson(card) {
  const value = card.querySelector("#tp-person")?.value;
  if (value !== "__other") return value;
  return (window.prompt("Who is it waiting on?") ?? "").trim();
}

document.addEventListener("change", (event) => {
  const card = event.target.closest(".flag[data-key]");
  if (!card) return;
  if (event.target.dataset.triage === "snooze" && event.target.value) {
    saveTriage(card, { status: "snoozed", workingDays: Number(event.target.value) });
  }
});

document.addEventListener("click", async (event) => {
  const el = event.target.closest("[data-triage]");
  if (!el || el.tagName === "SELECT") return;
  const card = el.closest(".flag[data-key]");
  if (!card) return;
  const action = el.dataset.triage;

  if (action === "done") return saveTriage(card, { status: "done" });
  if (action === "clear") return saveTriage(card, { status: null });
  if (action === "waiting-open") return openPanel(card, "waiting");
  if (action === "dismiss-open") return openPanel(card, "dismiss");
  if (action === "nudge-open") return openPanel(card, "nudge");
  if (action === "dismiss-save") return saveTriage(card, { status: "dismissed", note: card.querySelector("#tp-note")?.value ?? "" });
  if (action === "waiting-save") {
    const who = chosenPerson(card);
    if (!who) return;
    return saveTriage(card, { status: "waiting", waitingOn: who, workingDays: Number(card.querySelector("#tp-days")?.value ?? 2) });
  }
  if (action === "nudge-copy") {
    const who = chosenPerson(card);
    if (!who) return;
    try {
      await navigator.clipboard.writeText(card.querySelector("#tp-text")?.value ?? "");
    } catch {
      return showPanelError(card, "The browser would not copy. Select the message and copy it by hand.");
    }
    return saveTriage(card, { status: "waiting", waitingOn: who });
  }
});

function renderLayer1(report) {
  const section = report.sections.leadership;
  const detail = report.detail?.leadership;
  if (!section?.present) {
    $("layer1").innerHTML = `<div class="missing">Missing. ${esc(section?.reason ?? "not collected")}</div>`;
    return;
  }
  const rows = (detail.queue ?? [])
    .map(
      (item) => `<tr>
        <td class="wrap">${esc(item.title)}</td>
        <td>${esc(item.state)}</td>
        <td>${item.owner ? esc(item.owner.name) : '<strong>no owner</strong>'}</td>
        <td>${esc(item.type ?? "—")}</td>
        <td>${esc(item.shippedAt ?? "—")}</td>
        <td>${esc(item.lastMiniReadoutAt ?? "never")}</td>
      </tr>`,
    )
    .join("");
  const s = detail.summary;
  sectionCount("layer1", `${s.activeCount} active · ${s.shippedCount} shipped · ${s.backlogCount} backlog`);
  $("layer1").innerHTML = `
    <p class="sub">${s.activeCount} active, ${s.shippedCount} shipped, ${s.backlogCount} in the backlog. ${s.peopleAtCapacity} of ${s.rosterSize} people at capacity. Every item here is a P1.</p>
    <div class="scroll"><table>
      <thead><tr><th>Priority</th><th>State</th><th>Owner</th><th>Type</th><th>Shipped</th><th>Last mini readout</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6">The leadership queue is empty.</td></tr>'}</tbody>
    </table></div>
    ${detail.backlog?.length ? `<h3>Leadership backlog</h3><p>${detail.backlog.map((i) => esc(i.title)).join("; ")}</p>` : ""}`;
}

function renderCross(report) {
  const section = report.sections.crossLayer;
  const detail = report.detail?.crossLayer;
  if (!section?.present) {
    $("cross").innerHTML = `<div class="missing">Missing. ${esc(section?.reason ?? "not collected")}</div>`;
    sectionCount("cross", "missing", true);
    return;
  }
  const without = (detail.people ?? []).filter((p) => p.totalTickets > 0 && p.distinctBigSwings === 0).length;
  sectionCount("cross", without ? `${plural(without, "person", "people")} with no big swing` : `${plural((detail.people ?? []).length, "person", "people")}, all with a big swing`, without > 0);
  const rows = (detail.people ?? [])
    .map(
      (person) => `<tr>
        <td>${esc(person.name)}</td>
        <td>${person.distinctBigSwings === 0 ? "<strong>0</strong>" : esc(person.distinctBigSwings)}</td>
        <td>${esc(person.bauTickets.length)}</td>
        <td>${esc(person.unrelatedTickets.length)}</td>
        <td>${esc(person.totalTickets)}</td>
      </tr>`,
    )
    .join("");
  $("cross").innerHTML = `
    <p class="sub">Every person's sprint should carry at least one big swing tied to a live leadership priority. Business as usual is expected; it just should not crowd the big swing out.</p>
    <div class="scroll"><table>
      <thead><tr><th>Person</th><th>Big swings</th><th>BAU</th><th>Unrelated</th><th>Tickets</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">Nobody on the roster.</td></tr>'}</tbody>
    </table></div>`;
}

/* ------------------------------- staleness -------------------------------
   One label, used by both the sprint table and the staleness view, so the two cannot
   drift on what "at least" means.

   `exact` is the whole point. A ticket first seen mid-flight has been in its status
   longer than we watched, so its number is a floor taken from its last activity date,
   and it says "at least". Once we have seen the transition ourselves it is a
   measurement and drops the qualifier. Unknown renders as a dash, never as 0d, which
   would read as "just moved". */

function stalenessLabel(task) {
  const age = task.statusAge;
  if (!age) return '<span class="age-unknown" title="Not tracked yet. The clock starts the first time the 8 AM run sees this ticket.">—</span>';

  const qualifier = age.exact ? "" : "≥";
  const tone = task.stale ? (age.days >= task.stale.threshold * 2 ? "age-bad" : "age-warn") : "";
  const title = age.exact
    ? `In ${task.status} since ${new Date(age.since).toLocaleDateString()}, watched by this system.`
    : `At least ${age.days} days: nothing has touched this ticket since ${new Date(age.since).toLocaleDateString()}, so it has been in ${task.status} at least that long.${
        age.ceilingDays ? ` Created ${age.ceilingDays} days ago, so that is the upper bound.` : ""
      }`;

  return `<span class="age ${tone}" title="${esc(title)}">${esc(qualifier)}${esc(age.days)}d</span>`;
}

/**
 * Before sprint planning: the backlog tickets marked Ready, checked against the rocks.
 * What needs fixing is listed first and open; what is fine is a collapsed table.
 */
function preSprintHtml(p) {
  if (!p) return "";
  if (!p.available) {
    return `<details class="pre-sprint"><summary><h3>Before sprint planning</h3><span class="meta">not available: ${esc(p.reason ?? "")}</span></summary></details>`;
  }
  const ticket = (t) =>
    `<li>${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.name)} ↗</a>` : esc(t.name)}${t.swing ? ` <span class="meta">${esc(t.swing)}</span>` : ""}</li>`;
  const noSwingPeople = p.people.filter((x) => x.noBigSwing);
  const gaps = [
    noSwingPeople.length
      ? `<div class="ps-gap"><p class="ps-head bad">${esc(plural(noSwingPeople.length, "person has", "people have"))} no big swing queued</p>
         <p>${noSwingPeople.map((x) => `<strong>${esc(x.name)}</strong> <span class="meta">${esc(plural(x.ready, "Ready ticket", "Ready tickets"))}, none on a live rock</span>`).join("<br>")}</p></div>`
      : "",
    p.unqueuedRocks.length
      ? `<div class="ps-gap"><p class="ps-head bad">${esc(plural(p.unqueuedRocks.length, "active rock has", "active rocks have"))} nothing queued or open</p>
         <p class="flag-links">${p.unqueuedRocks.map((r) => `<a href="#rocks/${encodeURIComponent(r.id)}">${esc(r.title)}${r.owner ? ` · ${esc(r.owner)}` : ""}</a>`).join("")}</p></div>`
      : "",
    p.noSwing.length
      ? `<div class="ps-gap"><p class="ps-head">${esc(plural(p.noSwing.length, "Ready ticket has", "Ready tickets have"))} no Big Swing</p><ul>${p.noSwing.map(ticket).join("")}</ul></div>`
      : "",
    p.unclaimedSwing.length
      ? `<div class="ps-gap"><p class="ps-head">${esc(plural(p.unclaimedSwing.length, "Ready ticket is", "Ready tickets are"))} on a Big Swing no active rock claims</p><ul>${p.unclaimedSwing.map(ticket).join("")}</ul></div>`
      : "",
    p.unowned.length
      ? `<div class="ps-gap"><p class="ps-head">${esc(plural(p.unowned.length, "Ready ticket has", "Ready tickets have"))} nobody on it</p><ul>${p.unowned.map(ticket).join("")}</ul></div>`
      : "",
  ].filter(Boolean);
  const rows = p.people
    .map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.ready)}</td><td class="wrap">${x.rocks.length ? esc(x.rocks.join(", ")) : "—"}</td><td class="wrap">${x.carryover.length ? esc(x.carryover.join(", ")) : "—"}</td></tr>`)
    .join("");
  return `<details class="pre-sprint" ${gaps.length ? "open" : ""}>
    <summary><h3>Before sprint planning</h3><span class="meta">${esc(plural(p.readyCount, "ticket", "tickets"))} marked Ready in the backlog${gaps.length ? ` · <span class="bad">${esc(plural(gaps.length, "gap", "gaps"))}</span>` : " · no gaps"}</span></summary>
    <p class="sub">The backlog's Ready tickets are the pool for the next sprint. This checks the pool against the rocks while it is still cheap to change.</p>
    ${gaps.join("") || `<p class="sub">Everyone has a big swing queued and every active rock has work. Nothing to fix before planning.</p>`}
    <details><summary class="meta">By person</summary>
      <div class="scroll"><table><thead><tr><th>Person</th><th>Ready</th><th>Rocks in the pool</th><th>Carried over</th></tr></thead><tbody>${rows}</tbody></table></div>
    </details>
  </details>`;
}

/* ------------------------------- sprint board -------------------------------
   The week's commitment: every open ticket on the sprint, where it is, and what it is
   waiting on. Built from what the readout already holds, so it costs no extra request.

   "Waiting on" is worked out, never guessed. In order: a flag Alex marked as waiting on
   someone, then the ticket's status read as a stage (QA, deploy, to start), then whether
   it has stalled. The latest ClickUp comment sits under it, with who said it and when,
   because that is usually where the actual answer is. */

// Each stage, in the order a ticket worth asking about comes first.
const STAGES = [
  { id: "blocked", label: "Blocked", statuses: ["blocked"] },
  { id: "deploy", label: "Waiting on deploy", statuses: ["ready for deploy"] },
  { id: "review", label: "Waiting on QA or review", statuses: ["qa", "vqa", "in review"] },
  { id: "work", label: "Being worked", statuses: ["in-progress", "in progress"] },
  { id: "start", label: "Waiting to start", statuses: ["to do", "open", "not started", "backlog"] },
];
const STAGE_BY_STATUS = new Map(STAGES.flatMap((st) => st.statuses.map((x) => [x, st])));
const STAGE_TONE = { blocked: "bad", deploy: "warn", review: "warn", work: "", start: "" };
// The person view's swimlanes, left to right in the order a ticket moves. Blocked only
// gets a lane when something is blocked.
const LANES = [
  { id: "start", label: "To do" },
  { id: "work", label: "In progress" },
  { id: "review", label: "QA / review" },
  { id: "deploy", label: "Ready for deploy" },
  { id: "blocked", label: "Blocked" },
];

let sprintGroup = "person";
// The Big Swing the board is narrowed to: "" for every ticket, NO_SWING for tickets without one.
let sprintSwing = "";
const NO_SWING = "__none__";
const swingKey = (t) => (t.bigSwing?.label ? String(t.bigSwing.label) : NO_SWING);

/** The rock a ticket serves, through its Big Swing option, else by Big Swing label. */
function rockForTask(task) {
  const swing = task?.bigSwing;
  if (!swing?.optionId && !swing?.label) return null;
  const rocks = (state.rocks?.rocks ?? []).filter((r) => r.state !== "shipped" || r.clickupBigSwingOptionId);
  return (
    rocks.find((r) => swing.optionId && r.clickupBigSwingOptionId && String(r.clickupBigSwingOptionId) === String(swing.optionId)) ??
    rocks.find((r) => swing.label && String(r.title).trim().toLowerCase() === String(swing.label).trim().toLowerCase()) ??
    null
  );
}

/** Who a ticket belongs to: its Task Owner, else its assignees. Same rule as the cross layer. */
function accountable(task) {
  const owners = task.taskOwners?.length ? task.taskOwners : task.assignees ?? [];
  return owners.map((u) => ({ id: String(u.id), name: u.username ?? String(u.id) }));
}

function stageOf(task) {
  return STAGE_BY_STATUS.get(String(task.status ?? "").toLowerCase()) ?? { id: "work", label: task.status ?? "Unknown status" };
}

/** What a ticket is waiting on, and why we think so. */
function waitingOn(task) {
  const marked = (state.report?.flags ?? []).find(
    (f) => viewOf(f) === "waiting" && baseId(f.subject?.id) === String(task.id) && triageOf(f)?.waitingOn,
  );
  if (marked) return { text: `Waiting on ${triageOf(marked).waitingOn}`, why: "you marked it", tone: "warn" };
  const stage = stageOf(task);
  // The last comment put a question to someone by name: that is who it waits on.
  const c = task.lastComment;
  const asked = (c?.mentions ?? []).filter((m) => m.id !== c.userId).map((m) => m.username);
  if (asked.length && task.bucket !== "done") {
    // A ticket nobody has started is not alarming until its status moves.
    const tone = stage.id === "start" ? "" : Date.now() - c.date > 2 * DAY_MS ? "bad" : "warn";
    return { text: `Waiting on ${asked.join(", ")}`, why: `${c.user ?? "someone"} asked ${agoText(c.date)}`, tone };
  }
  if (stage.id === "work" && task.signal === "stalled") {
    return { text: "Stalled: needs a question", why: `untouched ${task.idleDays ?? "?"}d`, tone: "bad" };
  }
  if (stage.id === "work") {
    const who = accountable(task).map((p) => p.name.split(/\s+/)[0]).join(", ");
    return { text: who ? `With ${who}` : "Nobody on it", why: task.status, tone: who ? "" : "bad" };
  }
  return { text: stage.label, why: task.status, tone: STAGE_TONE[stage.id] ?? "" };
}

/** The ClickUp due date as a chip: red once it has passed, amber within two days. */
function dueChip(task) {
  if (!task.dueDate || task.bucket === "done") return "";
  const due = new Date(task.dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueDay = new Date(due);
  dueDay.setHours(0, 0, 0, 0);
  const days = Math.round((dueDay - today) / DAY_MS);
  const label = due.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const text = days < 0 ? `overdue ${-days}d (${label})` : days === 0 ? "due today" : days === 1 ? "due tomorrow" : `due ${label}`;
  const tone = days < 0 ? " sp-due-bad" : days <= 2 ? " sp-due-warn" : "";
  return `<span class="chip sp-due${tone}" title="ClickUp due date: ${esc(due.toLocaleString())}">${esc(text)}</span>`;
}

function agoText(ms) {
  if (!ms) return "";
  const days = Math.floor((Date.now() - ms) / DAY_MS);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`;
}

/** One ticket: name, where it is, what it waits on, and the last thing said on it. */
function ticketRow(task, { showOwner = true, lane = false } = {}) {
  const wait = waitingOn(task);
  const stage = stageOf(task);
  // In a lane the column already says the status, unless the lane holds several.
  const showStatus = !lane || stage.id === "review" || !STAGE_BY_STATUS.has(String(task.status ?? "").toLowerCase());
  // "Waiting to start" under a To do column says nothing; only a question put to someone does.
  const quietStart = lane && stage.id === "start" && wait.text === stage.label;
  const rock = rockForTask(task);
  const owners = accountable(task).map((p) => p.name).join(", ");
  const c = task.lastComment;
  const said =
    c === undefined
      ? `<span class="meta">Comments not read yet. They are read on the next refresh.</span>`
      : c
        ? `<span class="sp-said"><strong>${esc(c.user ?? "someone")}</strong>, ${esc(agoText(c.date))}: ${esc(c.text || "(no text)")}</span>`
        : `<span class="meta">No comments.</span>`;
  return `<div class="sp-row${wait.tone === "bad" ? " sp-row-bad" : ""}${lane ? " sp-card" : ""}">
      <div class="sp-line">
        <span class="sp-name">${task.url ? `<a href="${esc(task.url)}" target="_blank" rel="noreferrer">${esc(task.name)}</a>` : esc(task.name)}</span>
        <span class="sp-chips">
          ${showStatus ? `<span class="chip">${esc(task.status ?? "")}</span>` : ""}
          ${task.bucket === "done" || stage.id === "start" ? "" : stalenessLabel(task)}
          ${dueChip(task)}
          ${rock ? `<a class="chip owner" href="#rocks/${encodeURIComponent(rock.id)}">${esc(rock.title)}</a>` : task.bigSwing?.label ? `<span class="chip">${esc(task.bigSwing.label)}</span>` : ""}
        </span>
      </div>
      ${quietStart ? "" : `<div class="sp-line sp-sub">
        <span class="sp-wait${wait.tone ? ` sp-wait-${wait.tone}` : ""}">${esc(wait.text)}</span>
        <span class="meta">${esc(wait.why ?? "")}${showOwner ? ` · ${esc(owners || "unassigned")}` : ""}</span>
      </div>`}
      <div class="sp-line sp-sub">${said}</div>
    </div>`;
}

const stageRank = (task) => {
  if (task.signal === "stalled") return -1;
  const i = STAGES.findIndex((st) => st.id === stageOf(task).id);
  return i < 0 ? STAGES.length : i;
};

function renderLayer2(report) {
  const section = report.sections.clickup;
  const delta = report.detail?.clickup;
  if (!section?.present) {
    $("layer2").innerHTML = `<div class="missing">Missing. ${esc(section?.reason ?? "not collected")}</div>`;
    return;
  }
  const allTasks = delta.tasks ?? [];
  // The Big Swings on the sprint, by how many open tickets carry each.
  const swingCounts = new Map();
  for (const t of allTasks.filter((t) => t.bucket !== "done")) swingCounts.set(swingKey(t), (swingCounts.get(swingKey(t)) ?? 0) + 1);
  if (sprintSwing && !swingCounts.has(sprintSwing)) sprintSwing = "";
  const swingOptions = [...swingCounts.entries()]
    .filter(([k]) => k !== NO_SWING)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, n]) => `<option value="${esc(k)}"${k === sprintSwing ? " selected" : ""}>${esc(k)} (${esc(n)})</option>`)
    .join("");
  const swingSelect = `<select id="sprint-swing" aria-label="Big Swing">
      <option value="">All Big Swings</option>${swingOptions}
      ${swingCounts.has(NO_SWING) ? `<option value="${NO_SWING}"${sprintSwing === NO_SWING ? " selected" : ""}>No Big Swing (${esc(swingCounts.get(NO_SWING))})</option>` : ""}
    </select>`;
  const tasks = sprintSwing ? allTasks.filter((t) => swingKey(t) === sprintSwing) : allTasks;
  const open = tasks.filter((t) => t.bucket !== "done").sort((a, b) => stageRank(a) - stageRank(b));
  const weekAgo = Date.now() - 7 * DAY_MS;
  const doneThisWeek = tasks.filter((t) => t.bucket === "done" && t.dateClosed && t.dateClosed >= weekAgo);

  const count = (fn) => open.filter(fn).length;
  const tiles = [
    tile(count((t) => t.signal === "stalled" || stageOf(t).id === "blocked"), "Stalled or blocked"),
    tile(count((t) => stageOf(t).id === "review"), "Waiting on QA"),
    tile(count((t) => stageOf(t).id === "deploy"), "Waiting on deploy"),
    tile(count((t) => stageOf(t).id === "work" && t.signal !== "stalled"), "Being worked"),
    tile(count((t) => stageOf(t).id === "start"), "Not started"),
    tile(doneThisWeek.length, "Done this week"),
  ].join("");

  let groups;
  if (sprintGroup === "stage") {
    const stalled = open.filter((t) => t.signal === "stalled" && stageOf(t).id === "work");
    groups = [
      { title: "Stalled: needs a question", tasks: stalled },
      ...STAGES.map((st) => ({ title: st.label, tasks: open.filter((t) => stageOf(t).id === st.id && !stalled.includes(t)) })),
    ];
  } else {
    const roster = (state.people ?? []).filter((p) => p.clickupUserId);
    const byId = new Map();
    for (const t of open) {
      const who = accountable(t);
      if (!who.length) who.push({ id: "", name: "Unassigned" });
      for (const p of who) {
        if (!byId.has(p.id)) byId.set(p.id, { title: p.name, tasks: [] });
        byId.get(p.id).tasks.push(t);
      }
    }
    const order = (id) => {
      const i = roster.findIndex((p) => String(p.clickupUserId) === id);
      return id === "" ? 1e6 : i < 0 ? 1e5 : i;
    };
    groups = [...byId.entries()].sort((a, b) => order(a[0]) - order(b[0])).map(([id, g]) => ({ ...g, personId: id }));
  }

  const lanes = LANES.filter((l) => l.id !== "blocked" || open.some((t) => stageOf(t).id === "blocked"));
  // Worst first, then soonest due; tickets with no due date last.
  const worstFirst = (list) =>
    [...list].sort((a, b) => (waitingOn(b).tone === "bad") - (waitingOn(a).tone === "bad") || (a.dueDate ?? Infinity) - (b.dueDate ?? Infinity));
  const laneHtml = (tasks) =>
    `<div class="sp-lanes" style="--sp-cols:${lanes.length}">${lanes
      .map((l) => {
        const inLane = worstFirst(tasks.filter((t) => stageOf(t).id === l.id));
        return `<div class="sp-lane sp-lane-${l.id}">
          <p class="sp-lane-head">${esc(l.label)} <span class="meta">${esc(inLane.length)}</span></p>
          ${inLane.map((t) => ticketRow(t, { showOwner: false, lane: true })).join("")}
        </div>`;
      })
      .join("")}</div>`;

  const groupHtml = groups
    .filter((g) => g.tasks.length)
    .map((g) => {
      const urgent = g.tasks.filter((t) => waitingOn(t).tone === "bad").length;
      return `<section class="sp-group">
        <div class="sp-group-head"><h3>${esc(g.title)}</h3><span class="meta">${esc(plural(g.tasks.length, "ticket", "tickets"))}${urgent ? ` · <span class="bad">${esc(urgent)} need a question</span>` : ""}</span>
          ${g.personId ? `<span class="grow"></span><a class="meta" href="#people/${encodeURIComponent(g.personId)}">1:1 prep →</a>` : ""}</div>
        ${sprintGroup === "person" ? laneHtml(g.tasks) : g.tasks.map((t) => ticketRow(t)).join("")}
      </section>`;
    })
    .join("");

  $("layer2").innerHTML = `
    <div class="tiles">${tiles}</div>
    ${delta.hasBaseline ? "" : `<div class="note"><strong>First run.</strong> There is no previous snapshot, so there is no day over day comparison yet.</div>`}
    <div class="bar sp-bar">
      <div class="dod-windows" role="group" aria-label="Group by">
        ${[["person", "By person"], ["stage", "By what it waits on"]].map(([id, label]) => `<button type="button" class="ghost dod-window${id === sprintGroup ? " on" : ""}" data-sprint-group="${id}" aria-pressed="${id === sprintGroup}">${esc(label)}</button>`).join("")}
      </div>
      ${swingSelect}
      <span class="meta">${esc(plural(open.length, "open ticket", "open tickets"))}${sprintSwing ? ` on ${esc(sprintSwing === NO_SWING ? "no Big Swing" : sprintSwing)}` : ""}, worst first</span>
    </div>
    ${groupHtml || `<p class="sub">Nothing open on the sprint.</p>`}
    <details class="section">
      <summary><h2>Done this week</h2><span class="sec-count">${esc(doneThisWeek.length)}</span></summary>
      ${doneThisWeek.length ? doneThisWeek.map((t) => ticketRow(t)).join("") : `<p class="sub">Nothing closed in the last 7 days.</p>`}
    </details>
    <details class="section">
      <summary><h2>What changed</h2><span class="sec-count">${esc(delta.counts?.changed ?? 0)}</span></summary>
      <div class="dod-windows" role="group" aria-label="Compare against">
        ${Object.entries(DOD_WINDOWS).map(([id, w]) => `<button type="button" class="ghost dod-window${id === dodWindow ? " on" : ""}" data-window="${id}" aria-pressed="${id === dodWindow}">${esc(w.label)}</button>`).join("")}
      </div>
      <p class="meta" id="dod-basis">${delta.baselineDate ? `Against the readout baseline from ${esc(fmtWhen(delta.baselineDate))}.` : ""}</p>
      <div id="dod">${renderDayOverDay(delta)}</div>
      <div id="dod-rocks"></div>
    </details>`;
  // Always fetched, even for the readout window: it is what brings the rock changes.
  loadDodWindow(dodWindow);
}

$("layer2")?.addEventListener("change", (event) => {
  if (event.target.id !== "sprint-swing") return;
  sprintSwing = event.target.value;
  if (state.report) renderLayer2(state.report);
});

$("layer2")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-sprint-group]");
  if (!button) return;
  sprintGroup = button.dataset.sprintGroup;
  if (state.report) renderLayer2(state.report);
});

/* --------------------------------- update ---------------------------------
   The daily update text, grouped by Big Swing. Built in update-text.js from the tickets
   the report already holds; this only draws it and copies it. */

const updateExcluded = new Set();
let updateGroups = [];

/** The @name for a ClickUp user: their handle from the roster, else their first name. */
function handleFor(user) {
  const person = (state.people ?? []).find((p) => p.clickupUserId && String(p.clickupUserId) === String(user.id));
  return person?.handle || String(person?.name ?? user.username ?? user.id).split(/\s+/)[0];
}

function renderUpdate(report) {
  const section = report.sections.clickup;
  if (!section?.present) {
    $("update").innerHTML = `<div class="missing">Missing. ${esc(section?.reason ?? "not collected")}</div>`;
    return;
  }
  const since = windowStart();
  updateGroups = buildUpdate(report.detail?.clickup?.tasks ?? [], { since, handleFor });
  const pulled = new Date(report.generatedAt);
  const stale = Date.now() - pulled.getTime() > 2 * 3600_000;
  const text = updateText(updateGroups, updateExcluded);
  const count = updateGroups.reduce((n, g) => n + g.tasks.length, 0);

  $("update").innerHTML = `
    <p class="meta">Since ${esc(new Date(since).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }))}. From ClickUp as pulled ${esc(pulled.toLocaleString())}${stale ? `: press <strong>Refresh</strong> to include today so far` : ""}.</p>
    ${
      count
        ? `<div class="bar up-bar"><button type="button" id="copy-update">Copy all</button><span class="meta" id="copy-update-note">${esc(plural(count, "ticket", "tickets"))} across ${esc(plural(updateGroups.length, "Big Swing", "Big Swings"))}</span></div>
      <textarea id="update-text" class="up-text" rows="${Math.min(24, text.split("\n").length + 1)}" readonly>${esc(text)}</textarea>
      ${updateGroups
        .map(
          (g) => `<section class="up-group">
          <div class="sp-group-head"><h3>${esc(g.label)}</h3><span class="meta">${esc(plural(g.tasks.length, "ticket", "tickets"))}</span></div>
          ${g.tasks
            .map(
              ({ task, text: line }) => `<label class="up-item">
              <input type="checkbox" data-update-task="${esc(task.id)}"${updateExcluded.has(String(task.id)) ? "" : " checked"}>
              <span>${esc(line)}</span>
              ${task.url ? `<a class="meta" href="${esc(task.url)}" target="_blank" rel="noreferrer">open</a>` : ""}
            </label>`,
            )
            .join("")}
        </section>`,
        )
        .join("")}`
        : `<p class="sub">Nothing on the sprint has been touched since then.</p>`
    }`;
}

$("update")?.addEventListener("change", (event) => {
  const id = event.target.dataset?.updateTask;
  if (!id) return;
  if (event.target.checked) updateExcluded.delete(id);
  else updateExcluded.add(id);
  // Only the text changes; redrawing everything would drop the scroll position.
  const text = updateText(updateGroups, updateExcluded);
  $("update-text").value = text;
});

$("update")?.addEventListener("click", async (event) => {
  if (event.target.id !== "copy-update") return;
  try {
    await navigator.clipboard.writeText($("update-text").value);
    $("copy-update-note").textContent = "Copied.";
  } catch {
    $("copy-update-note").textContent = "The browser would not copy. Select the text and copy it by hand.";
  }
});

/* -------------------------- day over day: windows --------------------------
   The 8 AM readout always compares against the previous working day's 8 AM snapshot.
   Here the same view can also be asked about the last 24 hours, or today since
   midnight. Each answer names the snapshot it actually compared against. */

const DOD_WINDOWS = {
  readout: { label: "Since 8 AM readout" },
  "24h": { label: "Last 24 hours" },
  today: { label: "Today" },
};
let dodWindow = (() => {
  try {
    const saved = localStorage.getItem("mos.dodWindow");
    return DOD_WINDOWS[saved] ? saved : "readout";
  } catch {
    return "readout";
  }
})();

function fmtWhen(iso) {
  const d = new Date(iso);
  const day = d.toDateString() === new Date().toDateString() ? "today" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return `${day} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

async function loadDodWindow(window) {
  const basis = $("dod-basis");
  if (!basis) return;
  const res = await fetch(`${FN}/compare?window=${encodeURIComponent(window)}`).catch(() => null);
  const body = res ? await res.json().catch(() => ({})) : {};
  if (window !== dodWindow || !$("dod")) return; // the toggle moved on while this loaded
  if (!res?.ok) {
    basis.textContent = body.error ?? "Could not load that comparison.";
    return;
  }
  const gap = body.gapMinutes;
  basis.innerHTML = `Snapshot from ${esc(fmtWhen(body.current.takenAt))} against ${esc(fmtWhen(body.baseline.takenAt))}${
    window === "readout" ? " (the readout baseline)" : ""
  }.${
    !body.coversWindow
      ? ` <strong>Covers less than the window:</strong> the oldest snapshot stored is from ${esc(fmtWhen(body.baseline.takenAt))}.`
      : gap != null && gap > 90
        ? ` The nearest snapshot was ${esc(Math.round(gap / 60))}h before the window's start, so this covers a little more than it says.`
        : ""
  }`;
  $("dod").innerHTML = renderDayOverDay(body.delta);
  $("dod-rocks").innerHTML = renderRockChanges(body.rockChanges ?? []);
}

const ROCK_FIELD_LABEL = {
  title: "renamed", status: "status", state: "queue", owner: "owner", kpi: "KPI", startDate: "start", checkInDate: "check-in",
  shippedAt: "shipped", clickupOptionId: "Rock Reference link", clickupBigSwingOptionId: "Big Swing link",
  intelligemsExperienceId: "experiment", standupRockId: "standup link", websiteUrl: "website", notes: "notes",
};

/** What changed on the rocks in the window, from the audit trail. */
function renderRockChanges(entries) {
  const changes = entries.flatMap((e) => e.changes.map((c) => ({ ...c, at: e.at, actor: e.actor })));
  const head = `<h3>Rocks in this window</h3>`;
  if (!changes.length) return `${head}<p class="sub">No rock changes in this window.</p>`;
  const people = new Map((state.rocks?.people ?? []).map((p) => [p.id, p.name]));
  const statusLabels = { on_track: "On Track", at_risk: "At Risk", done: "Done", ...(state.rocks?.statusLabels ?? {}) };
  const show = (field, v) =>
    v == null || v === "" ? "none" : field === "owner" ? people.get(v) ?? v : field === "status" ? statusLabels[v] ?? v : v;
  const row = (c) => {
    const move = c.change === "created" ? "new" : c.change === "removed" ? "gone" : c.diff?.status ? (c.diff.status.to === "at_risk" ? "back" : "forward") : "talk";
    const label = { created: "+ Added", removed: "✕ Removed", updated: "• Changed" }[c.change];
    const diffs = Object.entries(c.diff ?? {}).map(([f, d]) =>
      f === "notes"
        ? `<div class="dod-note">notes edited</div>`
        : `<div class="dod-note">${esc(ROCK_FIELD_LABEL[f] ?? f)}: <span class="dod-person">${esc(show(f, d.from))}</span> → <span class="dod-person">${esc(show(f, d.to))}</span></div>`,
    ).join("");
    return `<li class="dod-row ${move}"><span class="dod-badge ${move}">${label}</span>
      <div class="dod-main"><div class="dod-name">${esc(c.title ?? c.id)}</div>${diffs}
      <div class="dod-note">${esc(fmtWhen(c.at))} · ${esc(c.actor)}</div></div></li>`;
  };
  return `${head}<ul class="dod-list">${changes.map(row).join("")}</ul>`;
}

document.addEventListener("click", (event) => {
  const button = event.target.closest(".dod-window");
  if (!button) return;
  dodWindow = button.dataset.window;
  try { localStorage.setItem("mos.dodWindow", dodWindow); } catch { /* per-viewer nicety only */ }
  document.querySelectorAll(".dod-window").forEach((b) => {
    b.classList.toggle("on", b === button);
    b.setAttribute("aria-pressed", String(b === button));
  });
  loadDodWindow(dodWindow);
});

/* ------------------------------ day over day ------------------------------
   One row per ticket, not one line per change: a ticket that shipped, was reassigned
   and got three comments is one story, and reading it as five scattered bullets is
   how the story gets lost. Rows are ordered by what needs a look first. */

const MOVE = {
  back: { label: "Moved back", icon: "↩", rank: 0 },
  shipped: { label: "Shipped", icon: "✓", rank: 1 },
  forward: { label: "Moved forward", icon: "→", rank: 2 },
  new: { label: "New", icon: "+", rank: 3 },
  gone: { label: "Gone", icon: "✕", rank: 4 },
  talk: { label: "Activity", icon: "•", rank: 5 },
};

function renderDayOverDay(delta) {
  const ch = delta.changes;
  const order = delta.statusOrder ?? [];
  const norm = (s) => String(s ?? "").trim().toLowerCase();
  const rankOf = (s) => order.findIndex((o) => o.name === norm(s));
  const bucketOf = (s) => order.find((o) => o.name === norm(s))?.bucket ?? null;

  // The stepper shows only the statuses this board actually uses, in workflow order.
  const used = new Set([...(delta.tasks ?? []).map((t) => norm(t.status)), ...ch.statusChanges.flatMap((t) => [norm(t.from), norm(t.to)])]);
  const stages = order.filter((o) => used.has(o.name)).filter((o, i, all) => all.findIndex((x) => x.name === o.name) === i);

  const byId = new Map();
  const row = (t) => {
    const key = String(t.id ?? t.name);
    if (!byId.has(key)) byId.set(key, { id: key, name: t.name, url: t.url, move: null, from: null, to: null, notes: [], comments: [] });
    return byId.get(key);
  };

  for (const t of ch.statusChanges) {
    const r = row(t);
    r.from = t.from;
    r.to = t.to;
    const [a, b] = [rankOf(t.from), rankOf(t.to)];
    r.move =
      bucketOf(t.to) === "done" && bucketOf(t.from) !== "done" ? "shipped"
      : norm(t.to) === "blocked" || (a >= 0 && b >= 0 && b < a) ? "back"
      : "forward";
  }
  for (const t of ch.newTasks) Object.assign(row(t), { move: "new", to: t.status });
  for (const t of ch.disappeared) Object.assign(row(t), { move: "gone", from: t.status });
  for (const [list, what] of [[ch.assigneeChanges, "assignee"], [ch.ownerChanges, "owner"], [ch.priorityChanges, "priority"]]) {
    for (const t of list) row(t).notes.push({ what, from: t.from, to: t.to });
  }
  for (const t of ch.newComments) row(t).comments.push({ added: t.added, user: t.latest?.user, text: t.latest?.text });

  const rows = [...byId.values()].map((r) => ({ ...r, move: r.move ?? "talk" }));
  if (!rows.length) return '<p class="sub">No changes since the baseline.</p>';
  rows.sort((x, y) => MOVE[x.move].rank - MOVE[y.move].rank || String(x.name).localeCompare(String(y.name)));

  const count = (m) => rows.filter((r) => r.move === m).length;
  const commented = rows.filter((r) => r.comments.length).length;
  const tiles = [
    ["shipped", count("shipped")], ["forward", count("forward")], ["back", count("back")], ["new", count("new")],
  ].map(([m, n]) => `<div class="dod-tile ${m}${n ? "" : " zero"}"><span class="dod-n">${n}</span><span class="dod-l">${MOVE[m].icon} ${MOVE[m].label}</span></div>`).join("")
    + `<div class="dod-tile talk${commented ? "" : " zero"}"><span class="dod-n">${commented}</span><span class="dod-l">💬 Discussed</span></div>`;

  // A dot per stage: where it was (hollow), where it is now (filled), the run between lit.
  const stepper = (r) => {
    if (r.from == null && r.to == null) return "";
    const [a, b] = [stages.findIndex((s) => s.name === norm(r.from)), stages.findIndex((s) => s.name === norm(r.to))];
    if ((r.from != null && a < 0) || (r.to != null && b < 0) || !stages.length) {
      return `<span class="dod-text">${esc(r.from ?? "")}${r.from != null && r.to != null ? " → " : ""}${esc(r.to ?? "")}</span>`;
    }
    const lo = Math.min(a < 0 ? b : a, b < 0 ? a : b);
    const hi = Math.max(a, b);
    const dots = stages.map((s, i) => {
      const cls = [i === b ? "now" : "", i === a ? "was" : "", i > lo && i < hi ? "pass" : "", i > lo && i <= hi && a >= 0 && b >= 0 ? "lit" : ""].filter(Boolean).join(" ");
      return `<span class="dod-stage ${cls}" title="${esc(s.name)}"><span class="dod-dot"></span></span>`;
    }).join("");
    return `<span class="dod-stepper ${r.move}" role="img" aria-label="${esc(`${r.from ?? "new"} to ${r.to ?? "removed"}`)}">${dots}</span>
      <span class="dod-text">${r.from != null ? `<s>${esc(r.from)}</s> → ` : ""}<strong>${esc(r.to ?? "removed")}</strong></span>`;
  };

  const people = (v) => esc(v ?? "none");
  const item = (r) => `
    <li class="dod-row ${r.move}">
      <span class="dod-badge ${r.move}">${MOVE[r.move].icon} ${MOVE[r.move].label}</span>
      <div class="dod-main">
        <div class="dod-name">${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.name)}</a>` : esc(r.name)}</div>
        <div class="dod-move">${stepper(r)}</div>
        ${r.notes.map((n) => `<div class="dod-note">${esc(n.what)}: <span class="dod-person">${people(n.from)}</span> → <span class="dod-person">${people(n.to)}</span></div>`).join("")}
        ${r.comments.map((c) => `<blockquote class="dod-comment"><span class="meta">💬 +${esc(c.added)}${c.user ? ` · ${esc(c.user)}` : ""}</span>${c.text ? `<span class="dod-quote">${esc(c.text)}</span>` : ""}</blockquote>`).join("")}
      </div>
    </li>`;

  return `
    <div class="dod-tiles">${tiles}</div>
    ${stages.length ? `<p class="meta dod-legend">Pipeline: ${stages.map((s) => esc(s.name)).join(" → ")}. Hollow dot is where a ticket was yesterday, filled is where it is now.</p>` : ""}
    <ul class="dod-list">${rows.map(item).join("")}</ul>`;
}

/* ------------------------- Layer 3. experiment trees -------------------------
   Quiet by default. A tree where every row shouts is a tree nobody reads: the
   inconclusive rows are the majority and they are exactly the ones that should
   not draw the eye. They stay, dimmed and compact, and can be hidden entirely. */

const SIG_TONE = { win: "win", loss: "loss", flat: "flat", none: "none" };
const QUIET_LEVELS = new Set(["inconclusive", "no_data"]);

function fmtMetric(value, format) {
  if (value == null) return "—";
  if (format === "money") return `$${Number(value).toFixed(2)}`;
  if (format === "percent") return `${(Number(value) * 100).toFixed(1)}%`;
  return Number(value).toFixed(2);
}

/** Only significant nodes get a chip. Labelling noise "Inconclusive" IS the noise. */
function sigChip(sig) {
  if (!sig || QUIET_LEVELS.has(sig.level)) return "";
  const tone = SIG_TONE[sig.tone] ?? "flat";
  const p = sig.probability != null ? ` · p ${(sig.probability * 100).toFixed(0)}%` : "";
  return `<span class="sig-chip ${tone}" title="${esc(sig.reason ?? "")}${esc(p)}">${esc(sig.label)}</span>`;
}

function nodeIsQuiet(node) {
  const own = QUIET_LEVELS.has(node.significance?.level);
  const anyChildLoud = (node.children ?? []).some((c) => !nodeIsQuiet(c));
  return own && !anyChildLoud;
}

function renderNode(node, depth, path) {
  const quiet = nodeIsQuiet(node);
  if (quiet && !state.showQuiet && depth > 0) return "";

  const hasChildren = (node.children ?? []).length > 0;
  const open = state.openTests.has(path);
  const up = (node.upliftPct ?? 0) > 0;
  const good = node.upliftPct == null ? null : node.goodDirection === "down" ? !up : up;
  const upliftText = node.upliftPct == null ? "—" : `${up ? "+" : ""}${node.upliftPct.toFixed(1)}%`;
  const caret = hasChildren ? `<span class="caret ${open ? "open" : ""}">▸</span>` : `<span class="caret leafdot"></span>`;

  // Attribution is a sentence, not a row of chips. "AOV carried it" is the finding.
  let attribution = "";
  if (node.attribution && node.attribution.length) {
    const sorted = [...node.attribution].sort((a, b) => Math.abs(b.contributionPct) - Math.abs(a.contributionPct));
    const lead = sorted[0];
    const rest = sorted.slice(1);
    attribution = `<div class="attribution">${esc(lead.label)} accounts for ${lead.contributionPct > 0 ? "+" : ""}${lead.contributionPct.toFixed(1)}pp of this${
      rest.length ? `, ${esc(rest.map((r) => `${r.label} ${r.contributionPct > 0 ? "+" : ""}${r.contributionPct.toFixed(1)}pp`).join(", "))}` : ""
    }</div>`;
  }

  const weaker = node.childrenSignificance && node.childrenSignificance.rank < (node.significance?.rank ?? 0);
  const rollup = weaker ? `<span class="rollup" title="The components beneath this are weaker than the headline.">components weaker</span>` : "";

  const children = hasChildren && open
    ? `<div class="tchildren">${node.children.map((c, i) => renderNode(c, depth + 1, `${path}.${i}`)).join("")}</div>`
    : "";

  const hiddenCount = hasChildren && open && !state.showQuiet
    ? node.children.filter((c) => nodeIsQuiet(c)).length
    : 0;

  return `<div class="tnode${quiet ? " quiet" : ""}">
      <button class="tnode-head${hasChildren ? "" : " leaf"}" ${hasChildren ? `data-node="${esc(path)}"` : "disabled"}
        title="control ${esc(fmtMetric(node.control, node.format))}">
        ${caret}
        <span class="tnode-label">${esc(node.label)}</span>
        <span class="tnode-value">${esc(fmtMetric(node.value, node.format))}</span>
        <span class="tnode-uplift ${good === null ? "" : good ? "good" : "bad"}">${esc(upliftText)}</span>
        ${sigChip(node.significance)}
        ${rollup}
      </button>
      ${attribution}
      ${children}
      ${hiddenCount ? `<div class="tnode-hidden">${hiddenCount} inconclusive hidden</div>` : ""}
    </div>`;
}

/* --------------------------- future value, on demand --------------------------- */

function renderFutureValue(testId, fv) {
  const key = `fv:${testId}`;
  if (!state.openTests.has(key)) {
    return `<div class="fv-ask">
        <button class="ghost" data-node="${esc(key)}">Project ${esc(fv?.horizonMonths ?? 12)} month value</button>
        <span class="meta">Values each variant on the customer mix it produces, not on this order alone.</span>
      </div>`;
  }
  if (!fv) return "";
  if (!fv.available) return `<div class="note"><strong>Cannot project.</strong> ${esc(fv.reason)}</div>`;

  const money = (v) => (v == null ? "—" : `$${Number(v).toFixed(2)}`);
  const pct = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
  const share = (v) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

  const rows = fv.variants
    .map((v) => `<tr>
        <td>${esc(v.name)}</td>
        <td>${esc(money(v.valuePerVisitor))}</td>
        <td class="${v.upliftPct == null ? "" : v.upliftPct > 0 ? "good" : "bad"}">${esc(pct(v.upliftPct))}</td>
        <td class="${v.immediateUpliftPct == null ? "" : v.immediateUpliftPct > 0 ? "good" : "bad"}">${esc(pct(v.immediateUpliftPct))}</td>
        <td>${esc(share(v.subscriptionShare))}</td>
      </tr>`)
    .join("");

  const conflict = fv.variants.filter((v) => v.disagreesWithImmediate);
  return `<div class="fv">
      <div class="bar">
        <strong>${esc(fv.horizonMonths)} month value</strong>
        <span class="meta">${fv.method === "multiplier"
          ? `subscriber ${esc(fv.subscriptionMultiplier)}x · one-time ${esc(fv.oneTimeMultiplier)}x first order`
          : `subscriber ${esc(money(fv.subscriptionLtv))} · one-time ${esc(money(fv.oneTimeLtv))}`}</span>
        <span class="grow"></span>
        <button class="ghost" data-node="${esc(key)}">Hide</button>
      </div>
      ${fv.references.stale ? `<div class="note">${esc(fv.references.note)}</div>` : ""}
      ${conflict.length ? `<div class="note"><strong>Lifetime and immediate disagree on ${esc(conflict.map((v) => v.name).join(", "))}.</strong> That disagreement is the decision.</div>` : ""}
      <div class="scroll"><table>
        <thead><tr><th>Variation</th><th>Value / visitor</th><th>Lifetime</th><th>Immediate</th><th>Sub share</th></tr></thead>
        <tbody>
          <tr class="control-row"><td>${esc(fv.control.name)} (control)</td><td>${esc(money(fv.control.valuePerVisitor))}</td><td>—</td><td>—</td><td>${esc(share(fv.control.subscriptionShare))}</td></tr>
          ${rows}
        </tbody>
      </table></div>
    </div>`;
}

/* ------------------------------- test notes ------------------------------- */

function renderNotes(testId) {
  const all = state.testNotes?.notes ?? {};
  const note = all[testId] ?? {};
  const fields = state.testNotes?.fields ?? {};
  const key = `notes:${testId}`;
  const open = state.openTests.has(key);
  const filled = Object.keys(fields).filter((f) => note[f]).length;

  const people = state.testNotes?.assignees ?? [];
  const owner = people.find((p) => p.id === note.assignee);

  if (!open) {
    const summary = note.hypothesis || note.decision || note.notes;
    return `<div class="notes-peek">
        <button class="ghost" data-node="${esc(key)}">${filled || note.assignee ? "Notes" : "Add notes"}</button>
        ${owner ? `<span class="chip owner">${esc(owner.name)}</span>` : '<span class="chip warn">no owner</span>'}
        ${summary ? `<span class="meta">${esc(String(summary).slice(0, 100))}${String(summary).length > 100 ? "…" : ""}</span>` : '<span class="meta">hypothesis, observations, the decision and why</span>'}
        ${(note.tags ?? []).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}
      </div>`;
  }

  const inputs = Object.entries(fields)
    .map(([k, spec]) => `<label class="wide">${esc(spec.label)}
        <textarea class="nt" data-f="${esc(k)}" rows="${k === "notes" ? 3 : 2}" placeholder="${esc(spec.help)}">${esc(note[k] ?? "")}</textarea>
      </label>`)
    .join("");

  const options = [`<option value="">no owner</option>`]
    .concat(people.map((p) => `<option value="${esc(p.id)}"${p.id === note.assignee ? " selected" : ""}>${esc(p.name)}</option>`))
    .join("");

  return `<div class="notes-edit" data-test="${esc(testId)}">
      <label class="wide">Owner
        <select class="nt" data-f="assignee">${options}</select>
        <span class="meta">One accountable person, from the ClickUp roster. Stored as their id, so a rename does not break it.</span>
      </label>
      ${inputs}
      <label class="wide">Tags<input class="nt" data-f="tags" value="${esc((note.tags ?? []).join(", "))}" placeholder="comma separated"></label>
      <div class="bar">
        <button class="note-save" data-test="${esc(testId)}">Save notes</button>
        <button class="ghost" data-node="${esc(key)}">Close</button>
        <span class="meta note-msg"></span>
        ${note.updatedAt ? `<span class="meta">last saved ${esc(new Date(note.updatedAt).toLocaleString())}</span>` : ""}
      </div>
    </div>`;
}

/* --------------------- what is different, control vs variant --------------------- */

function renderExperienceDiff(diff) {
  if (!diff) return "";

  const variation = (v) => `<div class="vdiff${v.isControl ? " control" : ""}">
      <div class="vdiff-head">
        <strong>${esc(v.name)}</strong>
        ${v.isControl ? '<span class="chip">control</span>' : ""}
        ${v.percentage != null ? `<span class="meta">${esc(v.percentage)}% of traffic</span>` : ""}
        ${v.unchanged ? '<span class="meta">unchanged baseline</span>' : ""}
      </div>
      ${v.changes.length
        ? `<ul class="vdiff-changes">${v.changes
            .map((c) => `<li>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noreferrer">${esc(c.text)}</a>` : esc(c.text)}</li>`)
            .join("")}</ul>`
        : '<p class="meta">No configuration of its own.</p>'}
    </div>`;

  return `<div class="ediff">
      <div class="bar">
        ${diff.types.map((x) => `<span class="chip">${esc(x)}</span>`).join("")}
        <span class="meta">${esc(diff.audience)}</span>
        ${diff.previewPath ? `<a class="meta" href="${esc(diff.previewPath)}" target="_blank" rel="noreferrer">preview the page</a>` : ""}
      </div>
      ${diff.description
        ? `<p class="ediff-desc">${esc(diff.description)}</p>`
        : '<p class="meta ediff-missing">No description written in Intelligems. What follows is derived from the variation configuration: it says what the test changes, not why.</p>'}
      <div class="vdiffs">${[diff.control, ...diff.variants].filter(Boolean).map(variation).join("")}</div>
    </div>`;
}


/* ----------------------- where the test won or lost ----------------------- */

function renderAudiences(audiences) {
  const shown = (audiences ?? []).filter((a) => a.rows?.length);
  if (!shown.length) return "";

  const pct = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);

  const block = (a) => {
    const rows = a.rows
      .flatMap((row) =>
        row.variants.map((v) => {
          const tone = v.significance.tone === "win" ? "good" : v.significance.tone === "loss" ? "bad" : "";
          return `<tr class="${v.underpowered ? "underpowered" : ""}">
              <td>${esc(row.segment)}</td>
              <td>${esc(v.name ?? "")}</td>
              <td>${esc((v.orders ?? 0).toLocaleString())}</td>
              <td class="${tone}">${esc(pct(v.upliftPct))}</td>
              <td><span class="sig-chip ${esc(v.significance.tone === "none" ? "flat" : v.significance.tone)}" title="${esc(v.significance.reason ?? "")}">${esc(v.significance.label)}</span></td>
            </tr>`;
        }),
      )
      .join("");

    const findings = a.divergent.length
      ? `<div class="note"><strong>Segments disagree with the overall result.</strong> ${a.divergent
          .map((d) => `${esc(d.segment)} is a ${esc(d.direction)}${d.overallDirection ? ` while the test overall is a ${esc(d.overallDirection)}` : " while the test overall is inconclusive"}`)
          .join("; ")}. Worth shipping to the segment rather than calling the whole test.</div>`
      : "";

    return `<div class="aud-block">
        <div class="aud-head">By ${esc(a.dimension.replace(/_/g, " "))}<span class="meta"> · judged on ${esc(a.metric)} · overall ${esc(a.overall?.label ?? "not judged")}</span></div>
        ${findings}
        <div class="scroll"><table>
          <thead><tr><th>Segment</th><th>Variation</th><th>Orders</th><th>Uplift</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`;
  };

  return `<h4 class="form-head">Where it won or lost</h4>
    <p class="meta">A segment under the order bar is shown as Too small rather than as a result. Slicing until something looks significant is the failure this invites.</p>
    ${shown.map(block).join("")}`;
}

/* -------------------------------- test card -------------------------------- */

function renderTestCard(test, ti) {
  const openKey = `t${test.id ?? ti}`;
  const open = state.openTests.has(openKey);
  const headline = (test.trees ?? [])[0]?.headline;
  const gate = test.recommendation.gate.ready ? "" : "gate not met";

  const trees = (test.trees ?? [])
    .map((tree, gi) => {
      const roots = tree.roots.map((r, ri) => renderNode(r, 0, `${openKey}.g${gi}.r${ri}`)).join("");
      return `<div class="tree-block"><div class="tree-head">${esc(tree.groupName)} vs control</div>${roots}</div>`;
    })
    .join("");

  const body = open
    ? `<div class="test-body">
        <p class="meta">${esc(test.recommendation.reason)}</p>
        ${renderExperienceDiff(test.experienceDiff)}
        ${renderNotes(test.id)}
        ${trees}
        ${renderAudiences(test.audiences)}
        <div class="bar tree-controls">
          <button class="ghost" id="toggle-quiet-${esc(openKey)}" data-quiet="1">${state.showQuiet ? "Hide inconclusive" : "Show all rows"}</button>
        </div>
        ${renderFutureValue(test.id, test.futureValue)}
      </div>`
    : "";

  const headlineChip = headline && !QUIET_LEVELS.has(headline.level)
    ? `<span class="sig-chip ${SIG_TONE[headline.tone] ?? "flat"}">${esc(headline.label)} on ${esc(headline.label === "Strong" || headline.label === "Directional" ? headline.metric ?? "" : "")}</span>`
    : "";

  // id-based, so a deep link survives tests being added, removed or reordered.
  return `<div class="test-card" id="test-${esc(test.id)}" data-test-id="${esc(test.id)}">
      <button class="test-head" data-node="${esc(openKey)}">
        <span class="caret ${open ? "open" : ""}">▸</span>
        <span class="test-name">${esc(test.name)}</span>
        <span class="chip ${test.recommendation.recommendation === "Kill" ? "bad" : test.recommendation.recommendation === "Ship" ? "good" : ""}">${esc(test.recommendation.recommendation)}</span>
        ${headlineChip}
        <span class="meta">${esc(test.daysRunning ?? "?")}d · ${esc(test.minOrdersPerGroup ?? "?")} orders${gate ? ` · ${esc(gate)}` : ""}</span>
      </button>
      ${
        test.consoleUrl
          ? `<a class="test-out" href="${esc(test.consoleUrl)}" target="_blank" rel="noreferrer" title="Open this test in Intelligems">Intelligems ↗</a>`
          : ""
      }
      ${!open && test.experienceDiff?.summary ? `<div class="test-peek">${esc(test.experienceDiff.summary)}</div>` : ""}
      ${body}
    </div>`;
}

function renderTests() {
  const report = state.report;
  const section = report?.sections?.intelligems;
  const delta = report?.detail?.intelligems;
  const host = $("layer3");
  if (!host) return;

  if (!section?.present) {
    host.innerHTML = `<div class="missing">Missing. ${esc(section?.reason ?? "not collected")}</div>`;
    return;
  }

  const c = delta.counts;
  const ended = (delta.ended ?? []).length
    ? `<h3>Ended</h3><ul>${delta.ended.map((t) => `<li>${esc(t.name)} — final verdict ${esc(t.finalVerdict ?? "none recorded")}</li>`).join("")}</ul>`
    : "";

  // Not shown is not the same as not there. One quiet line rather than a card each.
  const setAside = (delta.setAside ?? []).length
    ? `<p class="meta">${esc(delta.setAside.length)} not shown — ${delta.setAside
        .map((e) => `${esc(e.name)} (${esc(e.category)})`)
        .join(", ")}. A personalization has no control group, so there is no verdict to reach.</p>`
    : "";

  host.innerHTML = `<p class="sub">${esc(c.running)} running · ${esc(c.readyForVerdict)} past the readiness gate · ${esc(c.notable)} moved · ${esc(c.quiet)} quiet</p>
    ${setAside}
    ${(delta.tests ?? []).map(renderTestCard).join("")}
    ${ended}`;
}

async function loadTestNotes() {
  const res = await fetch(`${FN}/test-notes`).then((r) => r.json()).catch(() => null);
  if (res) state.testNotes = res;
}

document.addEventListener("click", async (event) => {
  const quiet = event.target.closest("[data-quiet]");
  if (quiet) {
    state.showQuiet = !state.showQuiet;
    renderTests();
    return;
  }

  const save = event.target.closest("button.note-save");
  if (save) {
    const wrap = save.closest(".notes-edit");
    const msg = wrap.querySelector(".note-msg");
    const note = {};
    for (const el of wrap.querySelectorAll(".nt")) {
      note[el.dataset.f] = el.dataset.f === "tags" ? el.value.split(",").map((s) => s.trim()).filter(Boolean) : el.value;
    }
    msg.textContent = "saving…";
    const res = await fetch(`${FN}/test-notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ experienceId: save.dataset.test, note, version: state.testNotes?.version }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      msg.textContent = body.error ?? `HTTP ${res.status}`;
      if (res.status === 409) await loadTestNotes();
      return;
    }
    await loadTestNotes();
    renderTests();
    return;
  }

  const head = event.target.closest("[data-node]");
  if (!head) return;
  const key = head.dataset.node;
  if (state.openTests.has(key)) state.openTests.delete(key);
  else state.openTests.add(key);
  renderTests();
});

function renderOpenItems() {
  const items = state.openItems ?? [];
  $("open-items").innerHTML = items.length
    ? `<div class="scroll"><table><thead><tr><th>Config</th><th>Decision</th></tr></thead><tbody>${items
        .map((i) => `<tr><td><code>${esc(i.at)}</code></td><td class="wrap">${esc(i.note)}</td></tr>`)
        .join("")}</tbody></table></div>`
    : '<p class="sub">Nothing outstanding. Every threshold is decided.</p>';
}

/* -------------------------------- actions -------------------------------- */

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button.advise");
  if (!button) return;

  const card = button.closest(".flag");
  const target = card.querySelector(".advice");
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Thinking…";
  target.classList.remove("hidden");
  target.textContent = "Asking the strategic advisor. This is the one place the system spends tokens.";

  try {
    const response = await fetch(`${FN}/advisor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flagId: button.dataset.flag }),
    });
    const body = await response.json();
    target.textContent = response.ok ? body.text : `Could not get a recommendation. ${body.error ?? body.reason ?? ""}`;
  } catch (err) {
    target.textContent = `Could not get a recommendation. ${err.message}`;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

$("refresh").addEventListener("click", async () => {
  const button = $("refresh");
  button.disabled = true;
  button.textContent = "Re-pulling…";
  const before = state.report?.runId ?? null;

  try {
    const response = await fetch(`${FN}/refresh`, { method: "POST" });
    const body = await response.json();
    if (!body.started) {
      button.textContent = "Refresh now";
      button.disabled = false;
      $("banners").innerHTML = `<div class="note">${esc(body.reason ?? "Refresh did not start.")}</div>`;
      return;
    }

    // The background function returned 202. Poll storage for the new report rather than
    // waiting on the function.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const check = await fetch(`${FN}/report`).then((r) => r.json()).catch(() => null);
      if (check && !check.empty && check.report.runId !== before) {
        state.report = check.report;
        state.openItems = check.openItems ?? state.openItems;
        render();
        break;
      }
    }
  } finally {
    button.disabled = false;
    button.textContent = "Refresh now";
  }
});


/* ------------------------------ test readout ------------------------------
   Proving the 8 AM Slack send works, on demand. The parts that break are the parts a
   dry run cannot reach: channel membership, a scope lost to a reinstall, blocks Slack
   will not accept. Those only fail against the real API.

   It posts to a channel other people read, so it arms first and sends on the second
   click. The arming lapses on its own, because a button left armed is a button that
   posts by accident. */

const TEST_READOUT_LABEL = "Send a test readout";
let armTimer = null;

function disarmTestReadout() {
  const button = $("test-readout");
  if (!button) return;
  clearTimeout(armTimer);
  armTimer = null;
  button.dataset.armed = "";
  button.classList.remove("armed");
  button.textContent = TEST_READOUT_LABEL;
}

$("test-readout")?.addEventListener("click", async () => {
  const button = $("test-readout");
  const note = $("test-readout-note");

  if (button.dataset.armed !== "1") {
    button.dataset.armed = "1";
    button.classList.add("armed");
    button.textContent = "Click again to post to Slack";
    note.textContent = "This posts a real message to the readout channel. It is labelled as a test. Click away to cancel.";
    // Arming lapses by itself rather than waiting to be clicked days later.
    armTimer = setTimeout(disarmTestReadout, 8000);
    return;
  }

  clearTimeout(armTimer);
  armTimer = null;
  button.classList.remove("armed");
  button.dataset.armed = "";
  button.disabled = true;
  button.textContent = "Posting…";

  try {
    const response = await fetch(`${FN}/test-readout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "send-test-readout" }),
    });
    const body = await response.json().catch(() => ({}));

    if (!body.started) {
      button.textContent = TEST_READOUT_LABEL;
      note.textContent = body.reason ?? "The test readout did not start.";
      return;
    }

    // The send rides the same background run as a refresh, so the dashboard picks up the
    // new report the same way and the readout on screen is the one that was posted.
    note.textContent = "Pulling live data and posting. This takes about as long as a refresh.";
    const before = state.report?.runId ?? null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      const check = await fetch(`${FN}/report`).then((r) => r.json()).catch(() => null);
      if (check && !check.empty && check.report.runId !== before) {
        state.report = check.report;
        state.openItems = check.openItems ?? state.openItems;
        render();
        note.textContent = "Posted. Check the readout channel in Slack for the message marked TEST.";
        return;
      }
    }
    note.textContent = "Still running. The post may land shortly — check Slack rather than clicking again.";
  } catch (err) {
    note.textContent = `The test readout failed: ${err.message}`;
  } finally {
    button.disabled = false;
    button.textContent = TEST_READOUT_LABEL;
  }
});

// Opening a view, or closing the drawer, cancels an armed send.
for (const nav of document.querySelectorAll(".nav")) nav.addEventListener("click", disarmTestReadout);
$("scrim")?.addEventListener("click", disarmTestReadout);


// Already signed in from a previous visit? The cookie will tell us.
load();


/* ---------------------------------- rocks ----------------------------------
   Layer 1's data, on its own screen. A list you can scan, and one rock at a time in a
   modal, because a dozen rocks each with nine fields is not a table anyone can read. */

async function loadRocks() {
  try {
    const res = await fetch(`${FN}/rocks`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    state.rocks = await res.json();
    rocksError(null);
    renderRocks();
    // The flags' quick fixes and the sprint's rock links are drawn from the rocks, so
    // they wait for them.
    if (state.report) {
      renderAllFlags();
      renderLayer2(state.report);
      renderPeople();
    }
  } catch (err) {
    rocksError(`Could not load the rocks: ${err.message}`);
  }
}

function rocksError(message) {
  const box = $("rocks-error");
  if (!message) return box.classList.add("hidden");
  box.textContent = message;
  box.classList.remove("hidden");
}

const STATUS_TONE = { on_track: "on_track", at_risk: "at_risk", off_track: "off_track", done: "done" };

function renderRocks() {
  const data = state.rocks;
  if (!data) return;
  const label = (id) => (data.statusLabels ?? {})[id] ?? id;
  const peopleById = new Map((data.people ?? []).map((p) => [p.id, p.name]));
  const cuById = new Map((data.clickupOptions?.options ?? []).map((o) => [o.id, o.label]));
  const swingById = new Map((data.bigSwingOptions?.options ?? []).map((o) => [o.id, o.label]));

  const q = ($("rock-filter")?.value ?? "").toLowerCase();
  const stateFilter = $("rock-state-filter")?.value ?? "";

  const rocks = (data.rocks ?? []).filter((r) => {
    if (stateFilter && r.state !== stateFilter) return false;
    if (!q) return true;
    return `${r.title} ${peopleById.get(r.owner) ?? ""} ${r.kpi ?? ""}`.toLowerCase().includes(q);
  });

  const gaps = (r) => {
    const out = [];
    if (!r.owner) out.push("no owner");
    if (!r.kpi) out.push("no KPI");
    if (!r.clickupBigSwingOptionId) out.push("no Big Swing");
    return out;
  };

  const card = (r) => `
    <button class="rock-row" data-open="${esc(r.id)}">
      <span class="sig ${esc(STATUS_TONE[r.status] ?? "")}">${esc(label(r.status))}</span>
      <span class="rock-row-main">
        <span class="rock-row-title">${esc(r.title)}</span>
        <span class="meta">
          ${esc(peopleById.get(r.owner) ?? "no owner")}
          · ${esc(r.state)}
          ${r.kpi ? `· KPI ${esc(r.kpi)}` : ""}
          ${r.checkInDate ? `· checked in ${esc(r.checkInDate)}` : "· never checked in"}
          ${r.clickupBigSwingOptionId ? `· swing: ${esc(swingById.get(r.clickupBigSwingOptionId) ?? "linked")}` : ""}
          ${r.readout?.headline ? `· <strong>${esc(r.readout.headline)}</strong>` : ""}
        </span>
        <span class="rock-links" data-stop>
          ${(r.experimentLinks ?? [])
            .map((l, i) => {
              const label = esc(l.label || `experiment ${i + 1}`);
              // Two destinations, because they answer different questions. The in-app
              // link goes to the readout this system has already built — the tree, the
              // segments, the projection — with that test expanded. The outward one
              // goes to Intelligems for everything this system does not hold. An
              // experiment link with no experience id parsed out of it can only do the
              // latter.
              const inApp = l.experienceId
                ? `<a href="#tests/${encodeURIComponent(l.experienceId)}" title="Open this test's readout in the Tests view">${label}</a>`
                : `<a href="${esc(l.url)}" target="_blank" rel="noreferrer">${label}</a>`;
              const out = l.experienceId
                ? `<a class="link-out" href="${esc(l.url)}" target="_blank" rel="noreferrer" title="Open ${label} in Intelligems">↗</a>`
                : "";
              return inApp + out;
            })
            .join("")}
          ${r.websiteUrl ? `<a href="${esc(r.websiteUrl)}" target="_blank" rel="noreferrer">site</a>` : ""}
          ${(r.reportLinks ?? []).map((l, i) => `<a href="${esc(l.url)}" target="_blank" rel="noreferrer">${esc(l.label || `report ${i + 1}`)}</a>`).join("")}
        </span>
      </span>
      <span class="rock-row-gaps">${gaps(r).map((g) => `<span class="chip warn">${esc(g)}</span>`).join("")}</span>
    </button>`;

  // Planning: what is already on the sprint and what is queued in the backlog under each
  // rock, joined through the Big Swing field, the same link the cross layer uses.
  const sprintOpen = (state.report?.detail?.clickup?.tasks ?? []).filter((t) => t.bucket !== "done");
  const backlogInfo = state.report?.detail?.backlog;
  const backlog = backlogInfo?.available ? backlogInfo.items.filter((t) => t.bucket !== "done") : [];
  const ticketsFor = (r) => {
    const mine = (t) => rockForTask(t)?.id === r.id;
    return { sprint: sprintOpen.filter(mine), backlog: backlog.filter(mine).sort((a, b) => Number(b.ready) - Number(a.ready)) };
  };
  const backlogLine = (t) => {
    const who = accountable(t).map((p) => p.name).join(", ");
    return `<li>${t.ready ? '<span class="chip good">Ready</span> ' : ""}${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.name)}</a>` : esc(t.name)} <span class="meta">${esc(who || "nobody on it")}</span></li>`;
  };

  const item = (r) => {
    const t = ticketsFor(r);
    const ready = t.backlog.filter((x) => x.ready).length;
    const planned = r.state === "shipped"
      ? ""
      : `<div class="rk-plan">
          <label class="meta rk-month">Target month <input type="month" data-rock-month="${esc(r.id)}" value="${esc(r.targetMonth ?? "")}"></label>
          <details>
            <summary class="meta">${esc(plural(t.sprint.length, "ticket", "tickets"))} on the sprint · ${esc(plural(t.backlog.length, "in the backlog", "in the backlog"))}${ready ? `, ${esc(ready)} Ready` : ""}${
              r.state === "active" && !t.sprint.length && !t.backlog.length ? ' · <span class="bad">nothing planned</span>' : ""
            }</summary>
            ${t.sprint.length ? `<p class="meta rk-head">On the sprint</p>${t.sprint.map((x) => ticketRow(x)).join("")}` : ""}
            ${t.backlog.length ? `<p class="meta rk-head">In the backlog</p><ul class="plain">${t.backlog.map(backlogLine).join("")}</ul>` : ""}
            ${!t.sprint.length && !t.backlog.length ? `<p class="sub">${r.clickupBigSwingOptionId ? "No open ticket on its Big Swing, in the sprint or the backlog." : "Not linked to a Big Swing, so no ticket can reach it. Set one in the editor."}</p>` : ""}
          </details>
        </div>`;
    return `<div class="rk-item">${card(r)}${planned}</div>`;
  };

  // Months, earliest first. A month already past with a rock still active is overdue.
  const thisMonth = todayKey().slice(0, 7);
  const monthName = (m) => new Date(`${m}-01T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const live = rocks.filter((r) => r.state !== "shipped");
  const months = [...new Set(live.map((r) => r.targetMonth).filter(Boolean))].sort();
  const groups = [
    ...months.map((m) => ({ title: monthName(m), late: m < thisMonth, current: m === thisMonth, rocks: live.filter((r) => r.targetMonth === m) })),
    { title: "No month set", rocks: live.filter((r) => !r.targetMonth), unset: true },
  ].filter((g) => g.rocks.length);
  const shipped = rocks.filter((r) => r.state === "shipped");

  const swingOf = (t) => t.bigSwing?.label ?? null;
  const offRock = backlog.filter((t) => !rockForTask(t));
  const offRockBySwing = new Map();
  for (const t of offRock) {
    const key = swingOf(t) ?? "No Big Swing";
    if (!offRockBySwing.has(key)) offRockBySwing.set(key, []);
    offRockBySwing.get(key).push(t);
  }

  $("rocks-list").innerHTML = `
    ${data.clickupOptions?.available === false ? `<div class="note"><strong>ClickUp link unavailable.</strong> ${esc(data.clickupOptions.reason ?? "")}</div>` : ""}
    ${backlogInfo && !backlogInfo.available ? `<div class="note"><strong>Backlog not loaded.</strong> ${esc(backlogInfo.reason ?? "")} Rocks show their sprint tickets only.</div>` : ""}
    ${preSprintHtml(state.report?.detail?.preSprint)}
    ${groups
      .map(
        (g) => `<section class="rk-month-group">
          <div class="sp-group-head"><h3>${esc(g.title)}</h3><span class="meta">${esc(plural(g.rocks.length, "rock", "rocks"))}${g.current ? " · this month" : ""}${
            g.late ? ' · <span class="bad">past its month</span>' : ""
          }${g.unset ? " · set a target month on each to plan it" : ""}</span></div>
          ${g.rocks.map(item).join("")}
        </section>`,
      )
      .join("") || `<p class="sub">${(data.rocks ?? []).length ? "No rocks match that filter." : "No rocks yet. Use New rock to add the first."}</p>`}
    ${shipped.length ? `<details class="section"><summary><h2>Shipped</h2><span class="sec-count">${esc(shipped.length)}</span></summary>${shipped.map(item).join("")}</details>` : ""}
    ${offRock.length
      ? `<details class="section"><summary><h2>Backlog on no rock</h2><span class="sec-count">${esc(offRock.length)}</span></summary>
          <p class="sub">Open backlog tickets whose Big Swing no rock claims, or that have none. Either they belong under a rock, or they are BAU.</p>
          ${[...offRockBySwing.entries()].map(([swing, list]) => `<p class="meta rk-head">${esc(swing)}</p><ul class="plain">${list.map(backlogLine).join("")}</ul>`).join("")}
        </details>`
      : ""}
    <p class="sub">${rocks.length} of ${(data.rocks ?? []).length} shown · version ${esc(data.version)}${data.updatedAt ? ` · last changed ${new Date(data.updatedAt).toLocaleString()}` : ""}</p>`;
}

/** Sets a rock's target month straight from the Rocks view. */
$("rocks-list").addEventListener("change", async (event) => {
  const input = event.target.closest("[data-rock-month]");
  if (!input) return;
  input.disabled = true;
  try {
    const res = await fetch(`${FN}/rocks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rock: { id: input.dataset.rockMonth, targetMonth: input.value || null }, version: state.rocks?.version }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 409) await loadRocks();
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    state.rocks = { ...state.rocks, version: body.version, rocks: body.rocks };
    renderRocks();
  } catch (err) {
    rocksError(`Target month not saved: ${err.message}`);
    input.disabled = false;
  }
});

/* ------------------------------- rock editor ------------------------------- */

let editingId = null;

function openRock(id) {
  const data = state.rocks;
  const r = id ? (data.rocks ?? []).find((x) => x.id === id) : null;
  editingId = r?.id ?? null;
  $("rock-modal-title").textContent = r ? "Edit rock" : "New rock";
  $("rock-delete").classList.toggle("hidden", !r);
  $("rock-form-error").classList.add("hidden");

  // A <select> can only select what it contains. If a rock points at an option that is
  // no longer on the ClickUp dropdown — deleted, or on a list we failed to refresh — the
  // browser silently falls back to the first entry, and merely opening the rock and
  // saving it would relink it to a different Big Swing without anyone touching that
  // field. So an unrecognised current value is kept as an option of its own, selected,
  // and labelled for what it is.
  const opts = (list, selected, blank) => {
    const has = list.some((o) => String(o.id) === String(selected ?? ""));
    const orphan =
      selected && !has
        ? [`<option value="${esc(selected)}" selected>⚠ linked to an option that is no longer on this field (${esc(String(selected).slice(0, 8))}…)</option>`]
        : [];
    return (blank == null ? [] : [`<option value=""${!selected ? " selected" : ""}>${esc(blank)}</option>`])
      .concat(orphan)
      .concat(list.map((o) => `<option value="${esc(o.id)}"${String(selected ?? "") === String(o.id) ? " selected" : ""}>${esc(o.label)}</option>`))
      .join("");
  };

  const statuses = (data.statuses ?? []).map((s) => ({ id: s, label: (data.statusLabels ?? {})[s] ?? s }));
  const states = (data.states ?? []).map((s) => ({ id: s, label: s }));
  const people = (data.people ?? []).map((p) => ({ id: p.id, label: p.name }));
  const cu = data.clickupOptions ?? { available: false, options: [] };
  const swings = data.bigSwingOptions ?? { available: false, options: [] };

  $("rock-form").innerHTML = `
    <label class="wide">Title<input class="rk" data-f="title" value="${esc(r?.title ?? "")}" placeholder="What is the rock"></label>
    <div class="form-grid">
      <label>Status<select class="rk" data-f="status">${opts(statuses, r?.status ?? "on_track", null)}</select></label>
      <label>Queue<select class="rk" data-f="state">${opts(states, r?.state ?? "active", null)}</select></label>
      <label>Owner<select class="rk" data-f="owner">${opts(people, r?.owner, "no owner")}</select></label>
      <label>KPI<input class="rk" data-f="kpi" value="${esc(r?.kpi ?? "")}" placeholder="the number this moves"></label>
      <label>Start date<input class="rk" type="date" data-f="startDate" value="${esc(r?.startDate ?? "")}"></label>
      <label>Target month <span class="meta">when it is delivered</span><input class="rk" type="month" data-f="targetMonth" value="${esc(r?.targetMonth ?? "")}"></label>
      <label>Check-in date<input class="rk" type="date" data-f="checkInDate" value="${esc(r?.checkInDate ?? "")}"></label>
      <label>Shipped<input class="rk" type="date" data-f="shippedAt" value="${esc(r?.shippedAt ?? "")}"></label>
      <label>Big Swing <span class="meta">how tickets reach this rock</span>${
        swings.available
          ? `<select class="rk" data-f="clickupBigSwingOptionId">${opts(swings.options, r?.clickupBigSwingOptionId, "not linked")}</select>`
          : `<input class="rk" data-f="clickupBigSwingOptionId" value="${esc(r?.clickupBigSwingOptionId ?? "")}" placeholder="option id">`
      }</label>
      <label>Rock Reference${
        cu.available
          ? `<select class="rk" data-f="clickupOptionId">${opts(cu.options, r?.clickupOptionId, "not linked")}</select>`
          : `<input class="rk" data-f="clickupOptionId" value="${esc(r?.clickupOptionId ?? "")}" placeholder="option id">`
      }</label>
    </div>
    <h4 class="form-head">Links</h4>
    <p class="meta">Up to three Intelligems experiments, the live page, and up to three reports. Paste an Intelligems URL and the experiment id is read out of it.</p>
    ${[0, 1, 2].map((i) => {
      const link = r?.experimentLinks?.[i];
      return `<div class="link-row">
        <input class="lk" data-lk="experiment" data-i="${i}" data-p="url" value="${esc(link?.url ?? "")}" placeholder="Intelligems experiment URL">
        <input class="lk narrow" data-lk="experiment" data-i="${i}" data-p="label" value="${esc(link?.label ?? "")}" placeholder="label">
        ${link?.experienceId ? `<span class="chip">id ${esc(link.experienceId.slice(0, 8))}</span>` : ""}
      </div>`;
    }).join("")}
    <label class="wide">Website URL<input class="rk" data-f="websiteUrl" value="${esc(r?.websiteUrl ?? "")}" placeholder="the page this rock changes"></label>
    ${[0, 1, 2].map((i) => {
      const link = r?.reportLinks?.[i];
      return `<div class="link-row">
        <input class="lk" data-lk="report" data-i="${i}" data-p="url" value="${esc(link?.url ?? "")}" placeholder="Report or doc URL">
        <input class="lk narrow" data-lk="report" data-i="${i}" data-p="label" value="${esc(link?.label ?? "")}" placeholder="label">
      </div>`;
    }).join("")}

    <label class="wide">Notes / details<textarea class="rk" data-f="notes" rows="4" placeholder="context, what done looks like">${esc(r?.notes ?? "")}</textarea></label>

    ${r ? renderRockReadout(r.readout) : '<p class="meta">A new rock starts active and on track.</p>'}`;

  $("rock-modal").hidden = false;
}

function closeRock() {
  $("rock-modal").hidden = true;
  editingId = null;
  // Drop a deep-linked rock from the hash, or following the same link again would not
  // fire a hashchange and the editor would not reopen.
  if (parseHash(location.hash).name === "rocks" && parseHash(location.hash).target) history.replaceState(null, "", "#rocks");
}

function formPayload() {
  const out = editingId ? { id: editingId } : {};
  for (const el of $("rock-form").querySelectorAll(".rk")) out[el.dataset.f] = el.value.trim();

  // Collect the link rows, dropping any with no URL so an empty row is not an error.
  for (const kind of ["experiment", "report"]) {
    const rows = new Map();
    for (const el of $("rock-form").querySelectorAll(`.lk[data-lk="${kind}"]`)) {
      const row = rows.get(el.dataset.i) ?? {};
      row[el.dataset.p] = el.value.trim();
      rows.set(el.dataset.i, row);
    }
    out[kind === "experiment" ? "experimentLinks" : "reportLinks"] =
      [...rows.values()].filter((row) => row.url);
  }
  return out;
}

/** The rock's own readout, joined from the latest Intelligems snapshot. */
function renderRockReadout(readout) {
  if (!readout) return "";
  if (readout.state === "no_experiments") {
    return `<h4 class="form-head">Readout</h4><p class="meta">${esc(readout.message)}</p>`;
  }
  if (readout.state === "no_snapshot") {
    return `<h4 class="form-head">Readout</h4><div class="note">${esc(readout.message)}</div>`;
  }

  const pct = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${Number(v).toFixed(1)}%`);
  const num = (v) => (v == null ? "not configured" : Number(v).toFixed(3));

  const test = (t) => {
    if (!t.found) {
      return `<div class="flag"><p class="msg">${esc(t.experienceId.slice(0, 8))}</p><p class="meta">${esc(t.message)}</p></div>`;
    }
    const rows = (t.metrics ?? []).flatMap((g) =>
      g.values.map((v) => `<tr>
        <td>${esc(g.group)}</td>
        <td>${esc(v.metric)}</td>
        <td>${esc(num(v.value))}</td>
        <td>${esc(num(v.control))}</td>
        <td>${v.confident ? "<strong>" + esc(pct(v.upliftPct)) + "</strong>" : esc(pct(v.upliftPct))}</td>
        <td>${v.probBeatControl == null ? "—" : esc((v.probBeatControl * 100).toFixed(0) + "%")}</td>
      </tr>`),
    ).join("");

    return `
      <div class="flag ${t.gateMet ? "" : "sev-prompt"}">
        <p class="msg"><strong>${esc(t.name ?? t.experienceId)}</strong> — ${esc(t.recommendation)}</p>
        <p class="meta">${esc(t.reason)}</p>
        <p class="meta">${esc(t.daysRunning ?? "?")} days · ${esc(t.ordersInSmallestGroup ?? "?")} orders in the smallest group${
          t.estMonthlyRevenueImpact != null ? ` · est. monthly impact ${esc(t.estMonthlyRevenueImpact)}` : ""
        }${t.stabilized === false ? " · still swinging" : ""}</p>
        ${rows ? `<div class="scroll"><table><thead><tr><th>Group</th><th>Metric</th><th>Value</th><th>Control</th><th>Uplift</th><th>Beat control</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
      </div>`;
  };

  return `
    <h4 class="form-head">Readout${readout.headline ? ` — ${esc(readout.headline)}` : ""}</h4>
    <p class="meta">From the Intelligems snapshot${readout.takenAt ? ` taken ${new Date(readout.takenAt).toLocaleString()}` : ""}. Bold uplift means the interval does not span zero.</p>
    ${(readout.tests ?? []).map(test).join("")}`;
}

async function saveRock() {
  const errBox = $("rock-form-error");
  errBox.classList.add("hidden");
  const res = await fetch(`${FN}/rocks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rock: formPayload(), version: state.rocks.version }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    errBox.textContent = body.error ?? `HTTP ${res.status}`;
    errBox.classList.remove("hidden");
    if (res.status === 409) await loadRocks();
    return;
  }
  closeRock();
  await loadRocks();
}

async function deleteRock() {
  if (!editingId) return;
  if (!confirm(`Remove "${editingId}"? The change is recorded, but it leaves the queue.`)) return;
  const res = await fetch(`${FN}/rocks?id=${encodeURIComponent(editingId)}&version=${state.rocks.version}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    $("rock-form-error").textContent = body.error ?? `HTTP ${res.status}`;
    $("rock-form-error").classList.remove("hidden");
    return;
  }
  closeRock();
  await loadRocks();
}

document.addEventListener("click", (event) => {
  // Clicking a link in a row opens the link, not the editor.
  if (event.target.closest("[data-stop]")) return;
  const open = event.target.closest("[data-open]");
  if (open) return openRock(open.dataset.open);
});
// The info popover on a metric tile. Click rather than hover only, so it works on touch.
document.addEventListener("click", (event) => {
  const button = event.target.closest("button.info-btn");
  document.querySelectorAll(".info-pop").forEach((n) => n.remove());
  if (!button) return;
  event.stopPropagation();

  const pop = document.createElement("div");
  pop.className = "info-pop";
  pop.innerHTML = `<strong>${esc(button.dataset.title)}</strong><p>${esc(button.dataset.detail).replace(/\n\n/g, "</p><p>")}</p>`;
  button.closest(".metric").appendChild(pop);

  // The popover is wider than its tile on purpose, so on the right-hand tiles it would
  // hang off the screen. Measure once it is in the DOM and pull it back inside. Right
  // edge first, then left, so a popover wider than a narrow viewport ends up pinned to
  // the left rather than yanked off the other side.
  const margin = 12;
  const room = document.documentElement.clientWidth;
  const overflowRight = pop.getBoundingClientRect().right - (room - margin);
  if (overflowRight > 0) pop.style.left = `${-overflowRight}px`;
  const shortfallLeft = margin - pop.getBoundingClientRect().left;
  if (shortfallLeft > 0) pop.style.left = `${(parseFloat(pop.style.left) || 0) + shortfallLeft}px`;
});

$("new-rock-btn").addEventListener("click", () => openRock(null));
$("rock-close").addEventListener("click", closeRock);
$("rock-save").addEventListener("click", saveRock);
$("rock-delete").addEventListener("click", deleteRock);
$("rock-modal").addEventListener("click", (e) => { if (e.target.id === "rock-modal") closeRock(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("import-modal").hidden) closeImport();
  else if (!$("rock-modal").hidden) closeRock();
});
$("rock-filter").addEventListener("input", renderRocks);
$("rock-state-filter").addEventListener("change", renderRocks);

$("rocks-audit-wrap")?.addEventListener("toggle", async (event) => {
  if (!event.target.open) return;
  const res = await fetch(`${FN}/rocks?audit=true`).then((r) => r.json()).catch(() => null);
  const entries = res?.audit ?? [];
  $("rocks-audit").innerHTML = entries.length
    ? entries.map((e) => `
        <div class="flag">
          <p class="meta">${esc(new Date(e.at).toLocaleString())} · v${esc(e.version)} · ${esc(e.actor)}</p>
          <p class="msg">${esc(e.reason ?? "")}</p>
          ${e.changes.map((c) => `<p class="meta">${esc(c.change)} ${esc(c.title ?? c.id)}${
            c.diff ? " — " + Object.entries(c.diff).map(([f, d]) => `${esc(f)}: ${esc(d.from ?? "none")} to ${esc(d.to ?? "none")}`).join(", ") : ""
          }</p>`).join("")}
        </div>`).join("")
    : '<p class="sub">No changes recorded yet.</p>';
});

/* ------------------------------ standup import ------------------------------
   The standup names the rocks; this screen links them to ClickUp. A paste carries the
   names across. Preview shows every proposed rename, new rock and ClickUp link, each one
   changeable, and nothing is written until Apply. */

let importPlan = null;

const STANDUP_SNIPPET = 'copy(await api("get-rocks"))';

function openImport() {
  importPlan = null;
  $("import-error").classList.add("hidden");
  $("import-apply").classList.add("hidden");
  $("import-preview").classList.remove("hidden");
  $("import-body").innerHTML = `
    <p class="meta">Best: on the standup site, signed in, open the browser console (Cmd+Option+J) and run
      <code>${esc(STANDUP_SNIPPET)}</code>, then paste here. That carries each rock's standup id, so the next
      paste follows a rename instead of guessing. The page's own HTML also works (on the Submit update
      screen, Inspect → right-click &lt;html&gt; → Copy outerHTML), and so does one title per line.</p>
    <textarea id="import-text" rows="12" placeholder="Paste the get-rocks JSON, or one rock title per line"></textarea>`;
  $("import-modal").hidden = false;
  $("import-text").focus();
}

function closeImport() {
  $("import-modal").hidden = true;
  importPlan = null;
}

function importError(message) {
  const box = $("import-error");
  if (!message) return box.classList.add("hidden");
  box.textContent = message;
  box.classList.remove("hidden");
}

async function previewImport() {
  importError(null);
  const res = await fetch(`${FN}/rocks?import=preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: $("import-text").value }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return importError(body.error ?? `HTTP ${res.status}`);
  importPlan = body;
  renderImportPlan();
}

function renderImportPlan() {
  const plan = importPlan;
  const cu = plan.clickupOptions ?? { available: false, options: [] };
  const swings = plan.bigSwingOptions ?? { available: false, options: [] };
  const labelOf = (list, id) => list.options.find((o) => String(o.id) === String(id))?.label;

  const select = (cls, i, list, selected, blank) =>
    `<select class="${cls}" data-i="${i}">
      <option value="">${esc(blank)}</option>
      ${list.map((o) => `<option value="${esc(o.id)}"${String(selected ?? "") === String(o.id) ? " selected" : ""}>${esc(o.label)}</option>`).join("")}
    </select>`;

  // A link that already exists is shown, not offered for change: a bulk paste is the
  // wrong place to relink a rock someone linked by hand. The rock editor is the right one.
  const linkCell = (cls, item, list, currentId, suggestion) => {
    if (currentId) return `<span class="meta">linked: ${esc(labelOf(list, currentId) ?? "an option no longer on the field")}</span>`;
    if (!list.available) return `<span class="meta">options unavailable</span>`;
    const hint = suggestion ? `<br><span class="meta">${suggestion.match === "exact" ? "same name" : "similar name"}</span>` : "";
    return select(cls, item.index, list.options, suggestion?.id, "not linked") + hint;
  };

  const actionText = (item) =>
    item.action === "create"
      ? `<span class="chip warn">new rock</span>`
      : item.action === "rename"
        ? `<span class="chip">rename</span><br><span class="meta">was "${esc(item.currentTitle)}" · ${esc(item.matchedBy)}${item.matchScore != null ? ` ${Math.round(item.matchScore * 100)}%` : ""}</span>`
        : `<span class="chip good">same name</span>`;

  const rows = plan.items.map((item) => `
    <tr data-row="${item.index}" class="${item.include ? "" : "skip"}">
      <td><input type="checkbox" class="im-include" data-i="${item.index}"${item.include ? " checked" : ""}></td>
      <td><strong>${esc(item.title)}</strong><br><span class="meta">${esc([item.team, item.quarter].filter(Boolean).join(" · "))}</span></td>
      <td>${select("im-rock", item.index, plan.rocks.map((r) => ({ id: r.id, label: `${r.title} (${r.state})` })), item.rockId, "create as a new rock")}
        <div class="im-action" data-i="${item.index}">${actionText(item)}</div></td>
      <td>${linkCell("im-ref", item, cu, item.currentRockReferenceId, item.suggestedRockReference)}</td>
      <td>${linkCell("im-swing", item, swings, item.currentBigSwingId, item.suggestedBigSwing)}</td>
    </tr>`).join("");

  $("import-body").innerHTML = `
    <p class="meta">${esc(plural(plan.items.length, "rock", "rocks"))} read from a ${({ json: "get-rocks paste", html: "standup page paste", lines: "list of titles" })[plan.format] ?? "paste"}${
      plan.latestQuarter ? ` · only ${esc(plan.latestQuarter)} is ticked by default` : ""
    }${plan.ownTeam ? ` · new rocks from teams other than ${esc(plan.ownTeam)} start unticked` : ""}${plan.skipped?.length ? ` · ${esc(plan.skipped.length)} skipped (business as usual or untitled)` : ""}. Check the matches, then Apply.</p>
    ${!cu.available ? `<div class="note"><strong>ClickUp options unavailable.</strong> ${esc(cu.reason ?? "")} Renames still work; link in the rock editor later.</div>` : ""}
    <div class="scroll"><table>
      <thead><tr><th></th><th>On the standup</th><th>Rock here</th><th>Rock Reference</th><th>Big Swing</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${plan.notInPaste.length ? `
      <h4 class="form-head">Here but not in the paste</h4>
      <p class="meta">Left as they are. Remove or ship them from the rock editor if they are gone from the standup.</p>
      ${plan.notInPaste.map((r) => `<p class="meta">${esc(r.title)} · ${esc(r.state)}</p>`).join("")}` : ""}
    ${renderTacticCheck(plan.tactics)}`;

  $("import-preview").classList.add("hidden");
  $("import-apply").classList.remove("hidden");
}

/** The page paste's tactics against the sprint. Read only: nothing here is applied. */
function renderTacticCheck(t) {
  if (!t) return "";
  if (t.unavailable) return `<h4 class="form-head">Tactics vs the ClickUp sprint</h4><div class="note">${esc(t.unavailable)}</div>`;

  const ticket = (k) => `<a href="${esc(k.url)}" target="_blank" rel="noreferrer">${esc(k.name)}</a>`;
  const tacticMeta = (x) => esc([x.owner ?? "no owner", x.rockTitle, x.status?.replace("_", " ")].filter(Boolean).join(" · "));

  const matched = t.matched.map((m) => `
    <tr>
      <td><strong>${esc(m.tactic.title)}</strong><br><span class="meta">${tacticMeta(m.tactic)}</span></td>
      <td>${m.tickets.map((k) => `${ticket(k)} <span class="meta">${esc(k.status ?? "")} · ${Math.round(k.score * 100)}%${k.sameOwner ? " · same owner" : ""}</span>`).join("<br>")}</td>
    </tr>`).join("");

  return `
    <h4 class="form-head">Tactics vs the ClickUp sprint</h4>
    <p class="meta">${esc(plural(t.count, "tactic", "tactics"))} on the page, matched by name against the sprint snapshot${
      t.takenAt ? ` taken ${esc(new Date(t.takenAt).toLocaleString())}` : ""
    }. Nothing here is applied; it is a list to act on.</p>
    ${matched ? `<div class="scroll"><table><thead><tr><th>Tactic</th><th>Looks like these tickets</th></tr></thead><tbody>${matched}</tbody></table></div>` : ""}
    <h4 class="form-head">On the standup, not in the sprint (${esc(t.tacticsWithoutTicket.length)})</h4>
    ${t.tacticsWithoutTicket.map((x) => `<p class="meta"><strong>${esc(x.title)}</strong> · ${tacticMeta(x)}</p>`).join("") || '<p class="meta">None.</p>'}
    <h4 class="form-head">In the sprint, not on the standup (${esc(t.ticketsWithoutTactic.length)})</h4>
    ${t.ticketsWithoutTactic.map((k) => `<p class="meta">${ticket(k)} · ${esc(k.status ?? "")} · ${esc(k.owners.join(", ") || "no owner")}${
      k.bigSwing ? ` · swing: ${esc(k.bigSwing)}` : ""}${k.rockReference ? ` · rock: ${esc(k.rockReference)}` : ""}</p>`).join("") || '<p class="meta">None.</p>'}`;
}

function collectImport() {
  const body = $("import-body");
  const val = (cls, i) => body.querySelector(`.${cls}[data-i="${i}"]`)?.value || null;
  return importPlan.items
    .filter((item) => body.querySelector(`.im-include[data-i="${item.index}"]`)?.checked)
    .map((item) => ({
      rockId: val("im-rock", item.index),
      title: item.title,
      standupRockId: item.standupId,
      clickupOptionId: val("im-ref", item.index),
      clickupBigSwingOptionId: val("im-swing", item.index),
    }));
}

async function applyImport() {
  importError(null);
  const items = collectImport();
  if (!items.length) return importError("Nothing is ticked.");
  const res = await fetch(`${FN}/rocks?import=apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items, version: importPlan.version }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return importError(body.error ?? `HTTP ${res.status}`);
  closeImport();
  await loadRocks();
}

$("import-body").addEventListener("change", (event) => {
  const i = event.target.dataset.i;
  if (event.target.classList.contains("im-include")) {
    event.target.closest("tr").classList.toggle("skip", !event.target.checked);
  }
  // Re-pointing a row at a different rock changes what Apply does to it, so say so.
  if (event.target.classList.contains("im-rock")) {
    const item = importPlan.items.find((x) => String(x.index) === i);
    const rock = importPlan.rocks.find((r) => r.id === event.target.value);
    $("import-body").querySelector(`.im-action[data-i="${i}"]`).innerHTML = !rock
      ? `<span class="chip warn">new rock</span>`
      : rock.title === item.title
        ? `<span class="chip good">same name</span>`
        : `<span class="chip">rename</span><br><span class="meta">was "${esc(rock.title)}" · picked by hand</span>`;
  }
});
$("import-rocks-btn").addEventListener("click", openImport);
$("import-close").addEventListener("click", closeImport);
$("import-preview").addEventListener("click", previewImport);
$("import-apply").addEventListener("click", applyImport);
$("import-modal").addEventListener("click", (e) => { if (e.target.id === "import-modal") closeImport(); });

/* ----------------------------------- nav ----------------------------------- */

// Sprint, Rocks and 1:1 are the tabs. The rest live in the menu and name themselves in
// the top bar when open.
const TAB_VIEWS = new Set(["sprint", "rocks", "people", "update"]);
const VIEW_TITLES = { readout: "Daily readout", tests: "Tests", setup: "Setup" };

/* --------------------------------- 1:1 prep ---------------------------------
   One person at a time, built entirely from what the dashboard already holds: the
   report, the live triage, the rocks and the test notes. Nothing is fetched for it and
   nothing about it leaves the page; the talking points are copied for Alex to use. */

const DAY_MS = 86_400_000;

/** Whether a name as ClickUp or a rock spells it is this person: exact, or first name. */
function isPerson(name, person) {
  const a = String(name ?? "").trim().toLowerCase();
  const b = String(person?.name ?? "").trim().toLowerCase();
  if (!a || !b) return false;
  return a === b || a.split(/\s+/)[0] === b.split(/\s+/)[0];
}

function personData(person) {
  const report = state.report ?? {};
  const d = report.detail ?? {};
  const id = String(person.clickupUserId ?? "");
  const tasks = (d.clickup?.tasks ?? []).filter((t) =>
    [...(t.taskOwners ?? []), ...(t.assignees ?? [])].some((u) => String(u.id) === id || isPerson(u.username, person)),
  );
  const open = tasks.filter((t) => t.bucket !== "done");
  const weekAgo = Date.now() - 7 * DAY_MS;
  const doneThisWeek = tasks.filter((t) => t.bucket === "done" && t.dateClosed && t.dateClosed >= weekAgo);
  const rocks = (state.rocks?.rocks ?? []).filter((r) => String(r.owner ?? "") === id);
  const cross = (d.crossLayer?.people ?? []).find((p) => String(p.id) === id) ?? null;
  const flags = (report.flags ?? []).filter((f) => !isContextFlag(f) && flagContext(f).owners.some((o) => isPerson(o, person)));
  const openFlags = flags.filter((f) => viewOf(f) === "open");
  const waiting = (report.flags ?? []).filter((f) => viewOf(f) === "waiting" && isPerson(triageOf(f)?.waitingOn, person));
  const tests = (d.intelligems?.tests ?? []).filter((t) => {
    const assignee = state.testNotes?.notes?.[t.id]?.assignee ?? t.owner?.clickupUserId;
    return assignee != null && String(assignee) === id;
  });
  const backlogInfo = d.backlog;
  const queued = (backlogInfo?.available ? backlogInfo.items : [])
    .filter((t) => t.bucket !== "done" && accountable(t).some((u) => u.id === id || isPerson(u.name, person)))
    .sort((a, b) => Number(b.ready) - Number(a.ready));
  return { tasks, open, doneThisWeek, rocks, cross, openFlags, waiting, tests, queued };
}

/** Deterministic talking points: what to raise, in the order it matters. */
function talkingPoints(person, data) {
  const points = [];
  const labels = state.rocks?.statusLabels ?? {};
  for (const r of data.rocks.filter((r) => r.state === "active")) {
    const since = r.checkInDate ? Math.floor((Date.now() - Date.parse(r.checkInDate)) / DAY_MS) : null;
    const checkIn = since == null ? ", never checked in" : since < 0 ? `, next check-in ${r.checkInDate}` : `, last check-in ${since} days ago`;
    points.push(`${r.title}: ${labels[r.status] ?? r.status}${checkIn}${r.targetMonth ? `, due ${r.targetMonth}` : ", no target month"}${r.kpi ? `. KPI ${r.kpi}` : ", no KPI set"}.`);
  }
  if (data.cross && data.cross.totalTickets > 0 && data.cross.distinctBigSwings === 0) points.push("No big swing in their sprint: none of their tickets is on a live rock.");
  const stalled = data.open.filter((t) => t.signal === "stalled");
  if (stalled.length) points.push(`${plural(stalled.length, "ticket has", "tickets have")} stalled: ${stalled.slice(0, 3).map((t) => `"${t.name}" (${t.idleDays}d)`).join(", ")}.`);
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  for (const t of data.open.filter((t) => t.dueDate && t.dueDate < startOfToday)) {
    points.push(`"${t.name}" was due ${new Date(t.dueDate).toLocaleDateString()} and is still ${t.status}. New date, or cut it?`);
  }
  for (const t of data.open.filter((t) => ["review", "deploy", "blocked"].includes(stageOf(t).id))) points.push(`"${t.name}": ${waitingOn(t).text.toLowerCase()}, ${t.statusAge ? `${t.statusAge.exact ? "" : "at least "}${t.statusAge.days} days` : "time unknown"}.`);
  if (!data.queued.some((t) => t.ready) && data.rocks.some((r) => r.state === "active")) points.push("Nothing of theirs is marked Ready in the backlog for next sprint.");
  for (const f of data.waiting) points.push(`Waiting on them: ${f.message}`);
  for (const f of data.openFlags.filter((f) => f.severity === "p1").slice(0, 3)) points.push(`P1: ${f.message}`);
  for (const t of data.tests) points.push(`Test "${t.name}": ${t.recommendation?.recommendation ?? "running"}, ${t.daysRunning ?? "?"} days in.`);
  if (data.doneThisWeek.length) points.push(`Shipped this week: ${data.doneThisWeek.slice(0, 5).map((t) => `"${t.name}"`).join(", ")}.`);
  return points;
}

function renderPeople() {
  const people = (state.people ?? []).filter((p) => p.clickupUserId);
  const pick = $("people-pick");
  const host = $("people-view");
  if (!pick || !host) return;
  if (!state.report) {
    host.innerHTML = `<p class="sub">Loading the readout…</p>`;
    return;
  }
  if (!people.length) {
    pick.innerHTML = "";
    host.innerHTML = `<p class="sub">No team roster in config/people.json.</p>`;
    return;
  }
  const selected = people.find((p) => String(p.clickupUserId) === String(state.peopleSelected)) ?? people[0];
  state.peopleSelected = String(selected.clickupUserId);
  pick.innerHTML = people
    .map((p) => `<button type="button" class="ghost dod-window${p === selected ? " on" : ""}" data-person="${esc(p.clickupUserId)}" aria-pressed="${p === selected}">${esc(p.name.split(/\s+/)[0])}</button>`)
    .join("");

  const data = personData(selected);
  const points = talkingPoints(selected, data);
  const labels = state.rocks?.statusLabels ?? {};
  const chip = (n, one, many, bad = false) => `<span class="chip${bad && n ? " bad" : ""}">${esc(plural(n, one, many))}</span>`;

  host.innerHTML = `
    <div class="person-head">
      <h3>${esc(selected.name)}</h3>
      <span class="person-chips">${chip(data.rocks.filter((r) => r.state === "active").length, "active rock", "active rocks")} ${chip(data.open.length, "open ticket", "open tickets")} ${chip(data.cross?.distinctBigSwings ?? 0, "big swing", "big swings")} ${chip(data.openFlags.length, "open flag", "open flags", true)} ${chip(data.waiting.length, "item waiting on them", "items waiting on them", true)}</span>
    </div>

    <div class="person-points">
      <div class="bar" style="margin:0 0 6px"><strong>Talking points</strong><span class="grow"></span><button type="button" class="ghost sm" id="copy-points">Copy for my notes</button></div>
      ${points.length ? `<ul>${points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : `<p class="sub">Nothing to raise from the data. Ask what is in their way.</p>`}
      <p class="meta" id="copy-points-note"></p>
    </div>

    <h3>Rocks</h3>
    ${data.rocks.length
      ? `<div class="flag-links">${data.rocks.map((r) => `<a href="#rocks/${encodeURIComponent(r.id)}">${esc(r.title)} · ${esc(labels[r.status] ?? r.status)} · ${esc(r.state === "shipped" ? "shipped" : r.targetMonth ? `due ${r.targetMonth}` : "no month set")}</a>`).join("")}</div>`
      : `<p class="sub">No rocks.</p>`}

    <h3>This sprint, and what each is waiting on</h3>
    ${data.open.length
      ? [...data.open].sort((a, b) => stageRank(a) - stageRank(b)).map((t) => ticketRow(t, { showOwner: false })).join("")
      : `<p class="sub">Nothing open in the current sprint.</p>`}
    ${data.cross ? `<p class="meta">${esc(plural(data.cross.bauTickets?.length ?? 0, "BAU ticket", "BAU tickets"))}, ${esc(plural(data.cross.unrelatedTickets?.length ?? 0, "ticket", "tickets"))} on no rock.</p>` : ""}

    <h3>Queued for them in the backlog</h3>
    ${data.queued.length
      ? `<ul class="plain">${data.queued.map((t) => { const rock = rockForTask(t); return `<li>${t.ready ? '<span class="chip good">Ready</span> ' : ""}${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.name)}</a>` : esc(t.name)} <span class="meta">${esc(rock ? rock.title : t.bigSwing?.label ?? "no Big Swing")}</span></li>`; }).join("")}</ul>`
      : `<p class="sub">${state.report?.detail?.backlog?.available ? "Nothing in the backlog with their name on it." : "The backlog was not loaded."}</p>`}

    ${data.doneThisWeek.length ? `<h3>Done this week</h3><ul class="plain">${data.doneThisWeek.map((t) => `<li>${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.name)}</a>` : esc(t.name)}</li>`).join("")}</ul>` : ""}

    ${data.tests.length ? `<h3>Tests they own</h3><div class="flag-links">${data.tests.map((t) => `<a href="#tests/${encodeURIComponent(t.id)}">${esc(t.name)} · ${esc(t.recommendation?.recommendation ?? "")}</a>`).join("")}</div>` : ""}

    <h3>Open flags about them</h3>
    <div id="people-flags">${data.openFlags.length ? data.openFlags.map(flagCard).join("") : `<p class="sub">None.</p>`}</div>

    ${data.waiting.length ? `<h3>Waiting on them</h3>${data.waiting.map(flagCard).join("")}` : ""}`;
  state.peoplePoints = points;
}

$("people-pick")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-person]");
  if (!button) return;
  state.peopleSelected = button.dataset.person;
  history.replaceState(null, "", `#people/${encodeURIComponent(button.dataset.person)}`);
  renderPeople();
});
document.addEventListener("click", async (event) => {
  if (event.target.id !== "copy-points") return;
  const person = (state.people ?? []).find((p) => String(p.clickupUserId) === String(state.peopleSelected));
  const text = [`1:1 with ${person?.name ?? ""}`, ...(state.peoplePoints ?? []).map((p) => `- ${p}`)].join("\n");
  try {
    await navigator.clipboard.writeText(text);
    $("copy-points-note").textContent = "Copied.";
  } catch {
    $("copy-points-note").textContent = "The browser would not copy. Select the points and copy them by hand.";
  }
});

/* -------------------------------- settings -------------------------------- */

async function loadSettings() {
  try {
    const res = await fetch(`${FN}/settings`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    state.settings = await res.json();
    renderSettings();
  } catch (err) {
    settingsError(`Could not load settings: ${err.message}`);
  }
}

function settingsError(message) {
  const box = $("settings-error");
  if (!message) return box.classList.add("hidden");
  box.textContent = message;
  box.classList.remove("hidden");
}

function renderSettings() {
  const d = state.settings;
  if (!d) return;
  const fields = Object.entries(d.schema)
    .map(([key, spec]) => {
      const value = d.settings[key];
      const type = spec.type === "date" ? "date" : "number";
      const step = spec.type === "money" || spec.type === "probability" || spec.type === "multiplier" ? "0.01" : "1";
      const stepAttr = type === "number" ? `step="${step}"` : "";
      return `<label class="wide">${esc(spec.label)}
        <input class="st" data-k="${esc(key)}" type="${type}" ${stepAttr} value="${esc(value ?? "")}" placeholder="not set">
        <span class="meta">${esc(spec.help)}</span>
      </label>`;
    })
    .join("");
  $("settings-form").innerHTML = `<div class="form-grid">${fields}</div>`;
  $("settings-meta").textContent = `version ${d.version}${d.updatedAt ? ` · last changed ${new Date(d.updatedAt).toLocaleString()}` : " · never set"}`;
  if (d.settings._warning) settingsError(d.settings._warning);
}

$("settings-save").addEventListener("click", async () => {
  settingsError("");
  const payload = {};
  for (const el of document.querySelectorAll("#settings-form .st")) payload[el.dataset.k] = el.value.trim();

  const res = await fetch(`${FN}/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: payload, version: state.settings.version }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    settingsError(body.error ?? `HTTP ${res.status}`);
    if (res.status === 409) await loadSettings();
    return;
  }
  state.settings = body;
  renderSettings();

  // Every projection rests on these, so the tests view must not keep showing the old one.
  const fresh = await fetch(`${FN}/report`).then((r) => r.json()).catch(() => null);
  if (fresh && !fresh.empty) {
    state.report = fresh.report;
    renderTests();
  }
});


/* Measure the LTV references from Shopify's cohort analysis.
   Measuring and saving are separate on purpose: these two numbers are what every
   projection rests on, so you see what it found before it replaces them. */
$("measure-ltv").addEventListener("click", async () => {
  const button = $("measure-ltv");
  const out = $("ltv-result");
  button.disabled = true;
  button.textContent = "Measuring…";
  out.innerHTML = '<p class="meta">Running two cohort queries against Shopify. This takes a few seconds.</p>';

  try {
    const res = await fetch(`${FN}/measure-ltv`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ horizonMonths: state.settings?.settings?.ltvHorizonMonths ?? 6 }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error ?? `HTTP ${res.status}`);

    const money = (v) => (v == null ? "—" : `$${Number(v).toFixed(2)}`);
    const block = (title, m) => `<tr>
        <td>${esc(title)}</td>
        <td><strong>${esc(money(m.value))}</strong></td>
        <td>${esc(m.cohorts)} cohorts</td>
        <td>${esc((m.customers ?? 0).toLocaleString())} customers</td>
        <td class="meta">${esc(m.firstCohort ?? "")}${m.lastCohort ? ` to ${esc(m.lastCohort)}` : ""}${m.reason ? esc(m.reason) : ""}</td>
      </tr>`;

    const excluded = r.subscription.excludedCohorts ?? [];
    out.innerHTML = `
      <div class="fv">
        <div class="scroll"><table>
          <thead><tr><th>First order</th><th>${esc(r.horizonMonths)} month LTV</th><th></th><th></th><th>Cohorts used</th></tr></thead>
          <tbody>
            ${block("Subscription", r.subscription)}
            ${block("One-time", r.oneTime)}
          </tbody>
        </table></div>
        <p class="meta">${r.ratio ? `A subscriber is worth <strong>${r.ratio.toFixed(2)}x</strong> a one-time buyer over ${esc(r.horizonMonths)} months.` : ""}
          ${excluded.length ? ` ${excluded.length} cohort(s) excluded for not having reached month ${esc(r.horizonMonths - 1)} yet: ${esc(excluded.join(", "))}. Including them would average incomplete lifetimes in and understate both figures.` : ""}</p>
        <div class="bar">
          <button id="apply-ltv" data-sub="${esc(r.subscription.value ?? "")}" data-one="${esc(r.oneTime.value ?? "")}">Use these values</button>
          <span class="meta">Saves them as the references, dated today.</span>
        </div>
      </div>`;
  } catch (err) {
    out.innerHTML = `<div class="missing">Could not measure: ${esc(err.message)}</div>`;
  } finally {
    button.disabled = false;
    button.textContent = "Measure from Shopify";
  }
});

document.addEventListener("click", async (event) => {
  const apply = event.target.closest("#apply-ltv");
  if (!apply) return;
  const sub = apply.dataset.sub;
  const one = apply.dataset.one;
  if (!sub || !one) return;

  for (const el of document.querySelectorAll("#settings-form .st")) {
    if (el.dataset.k === "subscriptionLtv6mo") el.value = Number(sub).toFixed(2);
    if (el.dataset.k === "oneTimeLtv6mo") el.value = Number(one).toFixed(2);
    if (el.dataset.k === "ltvAsOf") el.value = new Date().toISOString().slice(0, 10);
  }
  $("settings-save").click();
});

$("settings-audit-wrap")?.addEventListener("toggle", async (event) => {
  if (!event.target.open) return;
  const res = await fetch(`${FN}/settings?audit=true`).then((r) => r.json()).catch(() => null);
  const entries = res?.audit ?? [];
  $("settings-audit").innerHTML = entries.length
    ? entries
        .map((e) => {
          const changes = Object.entries(e.changes ?? {})
            .map(([k, v]) => `<p class="meta">${esc(k)}: ${esc(v.from ?? "unset")} → ${esc(v.to ?? "unset")}</p>`)
            .join("");
          return `<div class="flag"><p class="meta">${esc(new Date(e.at).toLocaleString())} · v${esc(e.version)} · ${esc(e.actor)}</p>${changes || '<p class="meta">no field changed</p>'}</div>`;
        })
        .join("")
    : '<p class="sub">No changes recorded yet.</p>';
});

/* ------------------------------ deep links ------------------------------
   `#tests/<experienceId>` opens the Tests view with that test already expanded and
   scrolled to. This is what makes a rock's experiment link useful: a big swing points at
   the test that is meant to prove it, and following it should land on the answer rather
   than on a list of nine cards to hunt through.

   Keyed on the experience id rather than the card's position, so a link keeps working
   as tests start and end. */

function parseHash(hash) {
  const [raw, ...rest] = (hash || "#sprint").slice(1).split("/");
  // Staleness folded into the Sprint view; an old link to it still lands somewhere useful.
  const name = raw === "staleness" ? "sprint" : raw || "sprint";
  return { name, target: rest.join("/") ? decodeURIComponent(rest.join("/")) : null };
}

/** Expands the named test and brings it into view. Safe to call before it has rendered. */
function focusTest(testId, { attempt = 0 } = {}) {
  if (!testId) return;

  const card = document.querySelector(`.test-card[data-test-id="${CSS.escape(testId)}"]`);
  if (!card) {
    // The Tests view loads its notes asynchronously and re-renders. Retry briefly rather
    // than silently doing nothing, then give up rather than spinning forever.
    if (attempt < 20) setTimeout(() => focusTest(testId, { attempt: attempt + 1 }), 150);
    return;
  }

  const key = card.querySelector(".test-head")?.dataset.node;
  if (key && !state.openTests.has(key)) {
    state.openTests.add(key);
    renderTests();
    // renderTests replaced the node, so re-find it before scrolling.
    return focusTest(testId, { attempt });
  }

  card.scrollIntoView({ behavior: "smooth", block: "start" });
  // A brief highlight, because scrolling alone leaves you unsure which card was meant.
  card.classList.add("test-focused");
  setTimeout(() => card.classList.remove("test-focused"), 2200);
}

function showView(name) {
  for (const section of document.querySelectorAll(".view")) {
    section.classList.toggle("hidden", section.id !== `view-${name}`);
  }
  for (const button of document.querySelectorAll(".nav, .tab")) {
    button.classList.toggle("active", button.dataset.view === name);
    if (button.classList.contains("tab")) button.setAttribute("aria-selected", String(button.dataset.view === name));
  }
  $("view-title").textContent = TAB_VIEWS.has(name) ? "" : VIEW_TITLES[name] ?? name;
  $("view-title").hidden = TAB_VIEWS.has(name);
  // Keep an existing deep-link target: showView is also called on boot from the hash,
  // and overwriting it there would drop the very test we were asked to open.
  if (parseHash(location.hash).name !== name) location.hash = name;
  closeDrawer();
  if (name === "rocks" && !state.rocks) loadRocks();
  if (name === "setup" && !state.settings) loadSettings();
  if (name === "people") renderPeople();
  if (name === "tests" && !state.testNotes) loadTestNotes().then(renderTests);
}

function openDrawer() {
  $("drawer").classList.add("open");
  $("drawer").setAttribute("aria-hidden", "false");
  $("menu-toggle").setAttribute("aria-expanded", "true");
  $("scrim").hidden = false;
}
function closeDrawer() {
  $("drawer").classList.remove("open");
  $("drawer").setAttribute("aria-hidden", "true");
  $("menu-toggle").setAttribute("aria-expanded", "false");
  $("scrim").hidden = true;
}

$("menu-toggle").addEventListener("click", () =>
  $("drawer").classList.contains("open") ? closeDrawer() : openDrawer(),
);
$("scrim").addEventListener("click", closeDrawer);
for (const button of document.querySelectorAll(".nav, .tab")) {
  button.addEventListener("click", () => showView(button.dataset.view));
}
/**
 * `#rocks/<id>` opens that rock in the editor. Anything else after `#rocks/` is taken as
 * filter text, which is how a person's flag links to their rocks. Waits for the rocks to load.
 */
function focusRock(target, { attempt = 0 } = {}) {
  if (!state.rocks) {
    if (attempt < 40) setTimeout(() => focusRock(target, { attempt: attempt + 1 }), 150);
    return;
  }
  if ((state.rocks.rocks ?? []).some((r) => String(r.id) === target)) {
    openRock(target);
    return;
  }
  $("rock-filter").value = target;
  renderRocks();
}

function routeFromHash() {
  const { name, target } = parseHash(location.hash);
  showView(name);
  if (name === "tests" && target) focusTest(target);
  if (name === "rocks" && target) focusRock(target);
  if (name === "people" && target) {
    state.peopleSelected = target;
    renderPeople();
  }
  if (name === "readout" && target) {
    // Sections start collapsed, so open the one holding the target before scrolling to it.
    const el = $(target);
    for (let node = el; node; node = node.parentElement) if (node.tagName === "DETAILS") node.open = true;
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    // Same reason as closeRock: a second click on the same link has to fire again.
    history.replaceState(null, "", "#readout");
  }
}

/* ------------------------------ newer version ------------------------------
   A tab left open keeps running the dashboard it loaded, so a change deployed since is
   invisible until a reload, and looks like the change did not work. When the tab comes
   back into view, compare the script on the server with the one this page loaded; if it
   changed, say so. Uses the ETag, or Last-Modified where there is none; with neither, it
   stays quiet rather than guess. */

const scriptVersion = async () => {
  try {
    const res = await nativeFetch("/app.js", { method: "HEAD", cache: "no-store" });
    return res.headers.get("etag") ?? res.headers.get("last-modified") ?? null;
  } catch {
    return null;
  }
};
let loadedVersion = null;
scriptVersion().then((v) => (loadedVersion = v));

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !loadedVersion || $("new-version")) return;
  const current = await scriptVersion();
  if (!current || current === loadedVersion) return;
  const bar = document.createElement("div");
  bar.id = "new-version";
  bar.className = "note";
  bar.innerHTML = `<strong>A newer version of the dashboard is live.</strong> <button type="button" class="sm">Reload</button>`;
  bar.querySelector("button").addEventListener("click", () => location.reload());
  document.querySelector("main")?.prepend(bar);
});

addEventListener("hashchange", routeFromHash);
routeFromHash();

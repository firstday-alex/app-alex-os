// The dashboard. Reads the same storage the 8 AM readout is built from, and can trigger
// the same pipeline on demand.
//
// The refresh path polls rather than awaits: a background function returns 202 straight
// away and the caller cannot wait for its result.

import { groupByPerson, groupLine, YOU, NOBODY } from "./flag-groups.js";
import { weekStartOf as qWeekStartOf, monthName as qMonthName, shortDay as qShortDay } from "./quarter.js";
import { buildAgenda, agendaText } from "./workshop.js";
import { buildChanges, buildLastWeekWins, buildStandupUpdate, buildThisWeekWins, changeLine, changesText, lastWeekText, standupUpdateText, windowStart } from "./update-text.js";

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
let state = { report: null, openItems: [], advisorButtonText: "Ask for recommendation", rocks: null, settings: null, testNotes: null };

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
  state.quietRules = body.quietRules ?? {};
  state.alexName = body.alexName ?? null;
  state.people = body.people ?? [];
  state.me = body.me ?? null;

  if (body.empty) {
    $("banners").innerHTML = `<div class="note"><strong>Nothing yet.</strong> ${esc(body.message)}</div>`;
    return;
  }
  state.report = body.report;
  render();
  // Test owners live in the notes. Fetched alongside so the attention list can use them.
  if (!state.testNotes) loadTestNotes().then(() => state.report && renderAllFlags({ rebuildTools: true }));
}

/* --------------------------------- render --------------------------------- */

// Rules that no longer exist. Each run recomputes flags, so they only appear in a readout
// saved before the rule went; hiding them here keeps an older readout from showing them.
// The Project Owner (Task Owner) field was deleted in ClickUp: assignees are who a ticket belongs to.
const RETIRED_RULES = new Set(["clickup.no_task_owner", "clickup.multiple_task_owners", "clickup.owner_field_missing"]);

function render() {
  const report = state.report;
  report.flags = (report.flags ?? []).filter((f) => !RETIRED_RULES.has(f.rule));
  const s = report.summary;

  $("chip-mode").textContent = { official: "8 AM readout", test: "test send" }[report.mode] ?? "refreshed";
  $("drawer-baseline").textContent = `Baseline ${report.baseline.describe}`;
  $("drawer-generated").textContent = `Pulled ${new Date(report.generatedAt).toLocaleString()}`;

  const banners = [];
  if (report.mode !== "official") {
    banners.push(
      `<p class="meta preview-line">Live preview against the previous working day's 8 AM snapshot. The 8 AM send is still the official readout.</p>`,
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
  part("Layer 1", () => renderLayer1(report));
  part("the workshop", () => renderWorkshop(report));
  part("the sprint", () => renderLayer2(report));
  part("the backlog", () => renderBacklog());
  part("the update", () => renderUpdate(report));
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
// Store moves and control-group moves are context for reading results, not things to
// act on: shown with the store numbers, never in a flag list. Mirrors CONTEXT_RULES.
const CONTEXT_RULES = new Set(["shopify.metric_moved", "intelligems.control_moved"]);
const isContextFlag = (f) => CONTEXT_RULES.has(f?.rule);
// Store numbers (month to date, the funnel) live in the separate reporting dashboard,
// linked from Resources in the top bar.
const ECOM_HUB = "https://ecomreporting.netlify.app/";

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

/** Everything that shows flags, redrawn together so a triage moves a flag everywhere at once. */
function renderAllFlags({ rebuildTools = false } = {}) {
  const flags = state.report?.flags ?? [];
  if (moves.data) renderMoves();
  renderTopThree(flags);
  // The 1:1 view shows the same flags, so a triage there redraws it too.
  if (!$("view-people")?.classList.contains("hidden")) renderPeople();
  renderNextSteps();
  renderRuleCheck();
}

/* -------------------------------- rule check --------------------------------
   Which kinds of flag get acted on and which sit ignored, from the last two weeks of
   readouts (src/delta/rule-health.js). A rule can be moved to Hygiene here: its P2s stop
   coming to the queue and never escalate, from the next run. P1 rules cannot be. */

const RULE_VERDICT = {
  ignored: { label: "Ignored", cls: "bad", sub: "Never acted on; most sit untouched or get marked not a problem." },
  "clears itself": { label: "Clears itself", cls: "warn", sub: "Never acted on, and most are gone within two days anyway." },
  mixed: { label: "Mixed", cls: "", sub: "" },
  "needs you": { label: "Needs you", cls: "good", sub: "You act on a fair share of these." },
};

function ruleHealthText(r) {
  const parts = [`${r.acted} of ${r.raised} acted on`];
  if (r.ignored) parts.push(`${r.ignored} sat a working week or more untouched`);
  if (r.dismissed) parts.push(`${r.dismissed} marked not a problem`);
  if (r.cleared) parts.push(`${r.cleared} cleared without you${r.fast ? ` (${r.fast} within two days)` : ""}`);
  if (r.open) parts.push(`${r.open} open under a week`);
  return parts.join(", ");
}

function renderRuleCheck() {
  const host = $("rule-check");
  if (!host) return;
  const h = state.report?.detail?.ruleHealth;
  if (!h?.rules) {
    host.innerHTML = `<p class="sub">The rule check appears after the next refresh.</p>`;
    sectionCount("rules", "");
    return;
  }
  const quiet = state.quietRules ?? {};
  const isQuiet = (rule) => Object.hasOwn(quiet, rule);
  const suggested = h.rules.filter((r) => r.suggest && !isQuiet(r.rule));
  const quieted = Object.keys(quiet);
  sectionCount("rules", [suggested.length ? `${suggested.length} suggested for Tidy-ups` : "", quieted.length ? `${quieted.length} in Tidy-ups` : ""].filter(Boolean).join(" · ") || "nothing to change", suggested.length > 0);

  const row = (r) => {
    const v = RULE_VERDICT[r.verdict] ?? RULE_VERDICT.mixed;
    const q = isQuiet(r.rule);
    const button = q
      ? `<button type="button" class="ghost sm" data-quiet="${esc(r.rule)}" data-on="0">Bring back to the queue</button>`
      : r.canQuiet
        ? `<button type="button" class="${r.suggest ? "sm" : "ghost sm"}" data-quiet="${esc(r.rule)}" data-on="1">Move to Tidy-ups</button>`
        : `<span class="meta" title="Raised as a P1, so it is never moved out of the queue">P1 rule</span>`;
    return `<tr${r.suggest && !q ? ' class="rc-suggest"' : ""}>
        <td class="wrap"><strong>${esc(ruleLabel(r.rule))}</strong><br><span class="meta">${esc(r.rule)}</span></td>
        <td><span class="chip ${esc(v.cls)}"${v.sub ? ` title="${esc(v.sub)}"` : ""}>${esc(q ? "In Tidy-ups" : v.label)}</span></td>
        <td class="wrap">${esc(ruleHealthText(r))}</td>
        <td>${button}</td>
      </tr>`;
  };
  // A rule quieted since it last fired still needs a way back.
  const missing = quieted.filter((rule) => !h.rules.some((r) => r.rule === rule)).map((rule) => ({ rule, raised: 0, acted: 0, verdict: "mixed", canQuiet: true }));
  host.innerHTML = `
    <p class="sub">${esc(plural(h.readouts, "readout", "readouts"))} since ${esc(fmtDay(h.since))}: how many flags each rule raised and what became of them.
      A rule you never act on, whose flags mostly sit untouched, is suggested for Tidy-ups. It is still in your queue, under the Tidy-ups filter, but sits below everything else and never escalates.
      Changes apply from the next refresh. Acted on means marked Done or Waiting on, here or in Slack.</p>
    ${suggested.length ? "" : `<p class="sub"><strong>No rule qualifies for Tidy-ups right now.</strong> ${esc(h.rules.filter((r) => r.verdict === "clears itself").length ? "Several clear within two days without you, shown below; that may be the readout working, so they are shown, not suggested." : "")}</p>`}
    <p class="triage-error hidden" id="rule-check-error"></p>
    <div class="scroll"><table class="rule-check">
      <thead><tr><th>Rule</th><th>Verdict</th><th>Last two weeks</th><th></th></tr></thead>
      <tbody>${[...h.rules, ...missing].map(row).join("")}</tbody>
    </table></div>`;
}

document.addEventListener("click", async (event) => {
  const el = event.target.closest("[data-quiet]");
  if (!el) return;
  const rule = el.dataset.quiet;
  const on = el.dataset.on === "1";
  el.disabled = true;
  try {
    const res = await fetch(`${FN}/flags`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quietRule: rule, quiet: on }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    state.quietRules = body.quietRules ?? {};
    renderRuleCheck();
  } catch (err) {
    el.disabled = false;
    const box = $("rule-check-error");
    if (box) {
      box.textContent = `Not saved: ${err.message}`;
      box.classList.remove("hidden");
    }
  }
});

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
  // A rock off course is the decision the week turns on: it leads the queue over aged
  // ticket flags, which can climb to +40 by age and escalation alone.
  const course = flag.rule === "leadership.rock_off_course" ? 30 : 0;
  return base + age + escalated + rock + course;
}
// Today's 3 is the top of the queue (rankedFlags, below).
function topFlags(flags, n = 3) {
  return rankedFlags(flags).slice(0, n);
}

/* ---------------------------------- queue ----------------------------------
   Everything open that needs Alex, ranked the same way as Today's 3, on one screen: the
   top 3 as full cards, the rest one line each (click a line to open it), and a tray of
   what was hidden or handled, so × never makes a flag disappear without a way back. */

const QUEUE_ROWS = 10;
const SEV_SHORT = { p1: "P1", attention: "P2", prompt: "Decision", info: "Tidy-up" };
const queue = { all: false, open: new Set() };

function rankedFlags(flags) {
  return flags
    .map((flag, index) => ({ flag, index, score: triageOf(flag) || isContextFlag(flag) ? null : priorityScore(flag) }))
    .filter((x) => x.score != null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.flag);
}

function triageShort(t) {
  if (!t) return "";
  if (t.status === "snoozed") return t.note === "hidden for today" ? "Hidden today" : `Snoozed to ${fmtDay(t.until)}`;
  if (t.status === "waiting") return `Waiting on ${t.waitingOn} to ${fmtDay(t.until)}`;
  return TRIAGE_LABEL[t.status] ?? t.status;
}

/** Whom a flag's nudge goes to: the first person on it who is not Alex. */
function nudgeTarget(flag) {
  const me = String(state.alexName ?? "").toLowerCase();
  return flagContext(flag).owners.find((o) => String(o).toLowerCase() !== me) ?? null;
}
// Replies Alex owes are his to answer, not someone to nudge.
const canNudge = (flag) => Boolean(nudgeTarget(flag)) && !UNBLOCK_RULES.has(flag.rule);

/* Nudge on a row: open the row's full card, then its nudge draft. */
document.addEventListener("click", (event) => {
  const b = event.target.closest("[data-q-nudge]");
  if (!b) return;
  const id = b.dataset.qNudge;
  const row = b.closest(".q-row");
  row?.querySelector("[data-q-open], [data-ns-open], [data-mv-open]")?.click();
  requestAnimationFrame(() => {
    const card = [...document.querySelectorAll(`.q-opened .flag[data-flag="${CSS.escape(id)}"]`)].find((el) => el.getClientRects().length);
    if (!card) return;
    openPanel(card, "nudge");
    card.scrollIntoView({ behavior: "smooth", block: "center" });
  });
});

/** One line: severity, what, who and how long, the main link, Nudge, and Done / × (or Bring back). */
function queueRow(flag, { also = 0, who = null } = {}) {
  const ctx = flagContext(flag);
  const t = triageOf(flag);
  const link = ctx.links.find((l) => l.clickup) ?? ctx.links.find((l) => l.external) ?? ctx.links.find((l) => !l.more);
  const age = flag.isNew ? "new today" : flag.openDays ? `${plural(flag.openDays, "day", "days")} open` : "";
  const meta = [who ?? ctx.owners.join(", "), age, flag.escalated ? "escalated" : "", also ? `+${also} more on this ticket` : "", t ? triageShort(t) : ""].filter(Boolean).join(" · ");
  return `<div class="flag q-row sev-${esc(flag.severity)}"${t ? " data-triaged" : ""} data-flag="${esc(flag.id)}" data-key="${esc(keyOf(flag))}" data-layer="${esc(flag.layer)}">
      <span class="q-sev">${esc(SEV_SHORT[flag.severity] ?? flag.severity)}</span>
      <button type="button" class="q-msg" data-q-open="${esc(flag.id)}" title="Open the full card">${esc(flag.message)}</button>
      <span class="q-meta">${esc(meta)}</span>
      <span class="q-acts">
        ${link ? `<a class="ql" href="${esc(link.href)}"${link.external ? ' target="_blank" rel="noreferrer"' : ""}>${esc(link.label)}${link.external ? " ↗" : ""}</a>` : ""}
        ${t
          ? `<button type="button" class="ghost sm" data-triage="clear">Bring back</button>`
          : `${canNudge(flag) ? `<button type="button" class="ghost sm" data-q-nudge="${esc(flag.id)}" title="Draft a nudge to ${esc(nudgeTarget(flag))}, to copy or schedule in Slack">Nudge</button>` : ""}
             <button type="button" class="ghost sm" data-triage="done" title="Handled. Hidden until the condition clears and comes back.">Done</button>
             <button type="button" class="q-x" data-triage="hide-today" title="Hide for today. It goes to Hidden or handled below, and is back tomorrow if it still holds." aria-label="Hide for today">×</button>`}
      </span>
    </div>`;
}

/* Routine sprint checks, one item per person (public/flag-groups.js, shared with the
   readout). A group sits where its highest-ranked flag would, so a person with an old
   overdue ticket rises with it. */
const groupOpts = () => ({ tasks: state.flagCtx?.tasks ?? new Map(), alexName: state.alexName });
const groupId = (g) => `group:${g.person}`;

/** A person's routine items as one card: the summary, each item one line, and the actions for all of them. */
function groupCard(g) {
  const who = g.person === YOU ? "Yours" : g.person;
  const canNudge = g.person !== YOU && g.person !== NOBODY;
  const oldest = Math.max(...g.flags.map((f) => f.openDays ?? 0));
  return `<div class="flag q-group sev-attention" data-group-person="${esc(g.person)}">
      <p class="msg"><strong>${esc(who)}</strong> · ${esc(plural(g.flags.length, "sprint item", "sprint items"))}: ${esc(g.summary)}</p>
      <p class="meta">Sprint · grouped by person${oldest ? ` · oldest open ${esc(plural(oldest, "working day", "working days"))}` : ""}</p>
      ${(() => {
        const none = g.flags.filter((f) => f.rule === "nextstep.no_assignee" && !triageOf(f));
        return none.length > 1 ? ownerPicker(none, { label: `Assign the ${none.length} tickets with nobody on them to` }) : "";
      })()}
      <div class="q-list">${g.flags.map((f) => (queue.open.has(f.id) ? `<div class="q-opened">${flagCard(f)}<button type="button" class="link-btn" data-q-open="${esc(f.id)}">Close</button></div>` : queueRow(f))).join("")}</div>
      <div class="triage-actions">
        ${canNudge ? `<button type="button" class="sm" data-group-act="nudge">Draft one nudge to ${esc(g.person)}</button>` : ""}
        <button type="button" class="ghost sm" data-group-act="done" title="Mark every item here Done. Each comes back only if its condition clears and returns.">Done all</button>
        <button type="button" class="ghost sm" data-group-act="hide" title="Hide all of these for today. Back tomorrow if they still hold.">Hide all for today</button>
      </div>
      <div class="group-panel hidden"></div>
    </div>`;
}

/** The group, folded to one line in the "Then" list. */
function groupRow(g) {
  const oldest = Math.max(...g.flags.map((f) => f.openDays ?? 0));
  const meta = [plural(g.flags.length, "item", "items"), oldest ? `oldest ${plural(oldest, "day", "days")} open` : "new today"].join(" · ");
  return `<div class="flag q-row q-group-row sev-attention">
      <span class="q-sev">P2 ×${esc(g.flags.length)}</span>
      <button type="button" class="q-msg" data-q-open="${esc(groupId(g))}" title="Open ${esc(g.person)}'s items">${esc(groupLine(g))}</button>
      <span class="q-meta">${esc(meta)}</span>
      <span class="q-acts"><button type="button" class="ghost sm" data-q-open="${esc(groupId(g))}">Open</button></span>
    </div>`;
}

/**
 * Rock decisions that Today's rock moves already offers (or that Alex picked), so the queue
 * does not show the same decision a second time. They stay under Needs your attention.
 */
function inRockMoves(flags) {
  const d = moves.data;
  const unblock = new Set(flags.filter((f) => UNBLOCK_RULES.has(f.rule)).map((f) => f.id));
  if (!d) return unblock;
  const rocks = new Set([...d.picks, ...d.suggestions].filter((m) => m.source === "course").map((m) => String(m.impact?.rockId)));
  return new Set([...unblock, ...flags.filter((f) => f.rule === "leadership.rock_off_course" && rocks.has(String(f.subject?.id ?? "").split(":")[0])).map((f) => f.id)]);
}

/* The queue's filters: which pile (open, waiting, handled), what kind (P1, P2, decision,
   tidy-up), whose, which area, and a search. With no filter the queue is ranked with the
   top three in full; with any filter it is a flat list to work down quickly. */
const QUEUE_KINDS = [["", "All"], ["p1", "P1"], ["attention", "P2"], ["prompt", "Decisions"], ["info", "Tidy-ups"]];
const QUEUE_VIEWS = [["open", "Open"], ["waiting", "Waiting"], ["parked", "Handled"]];
queue.f = { view: "open", kind: "", person: "", area: "", q: "" };
const queueFiltered = () => Boolean(queue.f.kind || queue.f.person || queue.f.area || queue.f.q.trim());

/** Every flag in a pile, ranked: P1, P2 and decisions by priority, then tidy-ups by age. */
function queuePool(flags, view, covered) {
  if (view !== "open") return flags.filter((f) => !isContextFlag(f) && viewOf(f) === view);
  const tidy = flags
    .filter((f) => f.severity === "info" && viewOf(f) === "open")
    .sort((a, b) => (b.openDays ?? 0) - (a.openDays ?? 0));
  return [...rankedFlags(flags), ...tidy].filter((f) => !covered.has(f.id));
}

/* A test's alerts as one line: every metric that moved, every probability crossed and the
   verdict, under the test's name, placed where its highest-ranked alert would be. */
const TEST_RULE_WORD = {
  "intelligems.ready_for_call": "ready for a call",
  "intelligems.verdict_changed": "verdict changed",
  "intelligems.gate_disagreement": "past the readiness gate",
  "intelligems.probability_crossed": "crossed 95%",
};
function foldTests(items) {
  const byTest = new Map();
  const out = [];
  for (const i of items) {
    const f = i.kind === "flag" || !i.kind ? i.flag ?? i : null;
    const sub = f ? subjectOf(f) : null;
    if (sub?.type === "test" && sub.label) {
      if (!byTest.has(sub.label)) {
        const g = { kind: "test", name: sub.label, flags: [] };
        byTest.set(sub.label, g);
        out.push(g);
      }
      byTest.get(sub.label).flags.push(f);
    } else out.push(i.kind ? i : { kind: "flag", flag: i });
  }
  return out.map((i) => (i.kind === "test" && i.flags.length === 1 ? { kind: "flag", flag: i.flags[0] } : i));
}
const testKey = (g) => `test:${g.name}`;

/** "6 updates: 3 metrics moved (conversion rate, …) · crossed 95% ×3". */
function testSummary(g) {
  const metrics = [];
  const counts = new Map();
  for (const f of g.flags) {
    if (f.rule === "intelligems.p1_out_of_band") {
      const m = String(f.message).match(/:\s*([^:]+?)(?:,| moved)/);
      if (m) metrics.push(m[1].trim());
      continue;
    }
    const w = TEST_RULE_WORD[f.rule] ?? ruleLabel(f.rule);
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const bits = [];
  if (metrics.length) bits.push(`${plural(metrics.length, "metric", "metrics")} moved (${[...new Set(metrics)].join(", ")})`);
  for (const [w, n] of counts) bits.push(n > 1 ? `${w} ×${n}` : w);
  return `${plural(g.flags.length, "update", "updates")}: ${bits.join(" · ")}`;
}

function testRow(g) {
  const sev = g.flags.some((f) => f.severity === "p1") ? "p1" : g.flags.some((f) => f.severity === "attention") ? "attention" : g.flags[0].severity;
  const isNew = g.flags.some((f) => f.isNew);
  const days = Math.max(...g.flags.map((f) => f.openDays ?? 0));
  return `<div class="flag q-row q-group-row q-test-row sev-${esc(sev)}">
      <span class="q-sev">${esc(SEV_SHORT[sev] ?? sev)} ×${esc(g.flags.length)}</span>
      <button type="button" class="q-msg" data-q-open="${esc(testKey(g))}" title="Open each update">"${esc(g.name)}" · ${esc(testSummary(g))}</button>
      <span class="q-meta">Test · ${esc(isNew ? "new today" : days ? `${plural(days, "day", "days")} open` : "")}</span>
      <span class="q-acts">
        <a class="ql" href="${AB_TESTING}" target="_blank" rel="noreferrer">AB Testing ↗</a>
        <button type="button" class="ghost sm" data-q-open="${esc(testKey(g))}">Open</button>
        <button type="button" class="ghost sm" data-test-done="${esc(g.name)}" title="Mark all ${g.flags.length} updates on this test Done">Done all</button>
      </span>
    </div>`;
}

function testOpened(g, close) {
  return `<div class="q-opened q-test-open">
      <p class="q-test-head">"${esc(g.name)}" <span class="meta">${esc(testSummary(g))}</span>
        <button type="button" class="ghost sm" data-test-done="${esc(g.name)}">Done all</button></p>
      <div class="q-list">${g.flags.map((f) => queueRow(f)).join("")}</div>
      ${close}
    </div>`;
}

document.addEventListener("click", async (event) => {
  const b = event.target.closest("[data-test-done]");
  if (!b) return;
  b.disabled = true;
  const name = b.dataset.testDone;
  const flags = (state.report?.flags ?? []).filter((f) => subjectOf(f).type === "test" && subjectOf(f).label === name && !triageOf(f));
  const failed = await saveTriageMany(flags, { status: "done", note: "all updates on this test handled" });
  if (failed.length) alert(`Not saved on ${failed.length}: ${failed[0]}`);
});

/* Alerts of the same kind sit together within a priority, and a run of two or more gets a
   thin vertical label ("No due date"), so a batch of the same fix is seen at once. */
const itemRule = (i) => (i.kind === "flag" ? i.flag.rule : null);
const itemSev = (i) => (i.kind === "flag" ? i.flag.severity : i.kind === "test" ? (i.flags.some((f) => f.severity === "p1") ? "p1" : "attention") : "attention");
function clusterByKind(items) {
  const order = new Map();
  items.forEach((i, n) => {
    const k = `${itemSev(i)}|${itemRule(i) ?? `#${n}`}`;
    if (!order.has(k)) order.set(k, n);
  });
  const key = (i, n) => `${itemSev(i)}|${itemRule(i) ?? `#${n}`}`;
  return items
    .map((i, n) => ({ i, n, at: order.get(key(i, n)) }))
    .sort((a, b) => a.at - b.at || a.n - b.n)
    .map((x) => x.i);
}
function runs(list, line) {
  const out = [];
  for (let n = 0; n < list.length; ) {
    const rule = itemRule(list[n]);
    let m = n + 1;
    while (rule && m < list.length && itemRule(list[m]) === rule) m++;
    if (m - n >= 2) {
      out.push(`<div class="q-run" title="${esc(m - n)} × ${esc(ruleLabel(rule))}"><span class="q-run-label">${esc(ruleLabel(rule))}</span><div class="q-run-rows">${list.slice(n, m).map(line).join("")}</div></div>`);
    } else out.push(line(list[n]));
    n = m;
  }
  return out.join("");
}

function queueMatches(f, { kind = true } = {}) {
  const { person, area } = queue.f;
  const q = queue.f.q.trim().toLowerCase();
  if (kind && queue.f.kind && f.severity !== queue.f.kind) return false;
  if (area && String(f.layer) !== area) return false;
  const ctx = flagContext(f);
  if (person && !(ctx.owners.length ? ctx.owners : [NO_OWNER]).includes(person)) return false;
  if (q && !`${f.message} ${ctx.owners.join(" ")} ${ctx.itemLabel} ${triageOf(f)?.waitingOn ?? ""}`.toLowerCase().includes(q)) return false;
  return true;
}

function renderTopThree(flags) {
  const host = $("start-here");
  if (!host) return;
  // The frame (and the search box in it) is built once, so typing never loses focus.
  if (!$("q-body")) {
    host.innerHTML = `<div class="glass q-glass">
      <header class="q-header">
        <div><h2>Your queue</h2><p class="mv-sub" id="q-sub"></p></div>
        <div class="q-score" id="q-score"></div>
      </header>
      <div id="q-moved"></div>
      <div class="q-tools">
        <div id="q-filters"></div>
        <input type="search" id="q-search" class="q-search" placeholder="Search the queue" aria-label="Search the queue">
      </div>
      <div id="q-body"></div>
    </div>`;
  }
  const covered = inRockMoves(flags);
  const f = queue.f;
  const pool = queuePool(flags, f.view, covered);
  const base = pool.filter((x) => queueMatches(x, { kind: false }));
  const shownFlags = base.filter((x) => !f.kind || x.severity === f.kind);
  const openPool = f.view === "open" ? pool : queuePool(flags, "open", covered);
  queue.lines = openPool.length;
  queue.p1 = openPool.filter((x) => x.severity === "p1").length;
  const cleared = flags.filter((x) => triageOf(x)?.status === "done").length;

  $("q-sub").textContent = f.view === "open"
    ? `${plural(openPool.length, "item", "items")} open${queue.p1 ? ` · ${queue.p1} P1` : ""}`
    : `${plural(pool.length, "item", "items")} ${f.view === "waiting" ? "waiting on someone" : "done, snoozed or hidden"}`;
  $("q-score").innerHTML = `<span class="q-big">${esc(openPool.length)}</span><span class="q-big-k">open</span>${cleared ? `<span class="q-cleared">✓ ${esc(cleared)} cleared</span>` : ""}`;
  $("q-moved").innerHTML = covered.size && f.view === "open"
    ? (() => {
        const waiting = flags.filter((x) => covered.has(x.id) && UNBLOCK_RULES.has(x.rule) && viewOf(x) === "open").length;
        const rocks = flags.filter((x) => covered.has(x.id) && !UNBLOCK_RULES.has(x.rule) && viewOf(x) === "open").length;
        const bits = [waiting ? plural(waiting, "person waiting on you", "people waiting on you") : "", rocks ? plural(rocks, "rock decision", "rock decisions") : ""].filter(Boolean);
        return bits.length ? `<button type="button" class="q-moved" data-q-focus>↑ ${esc(bits.join(" and "))} in Today's moves</button>` : "";
      })() : "";

  // Filters. People and areas come from the whole pile, so a choice never hides itself.
  const owners = [...new Set(pool.flatMap((x) => { const o = flagContext(x).owners; return o.length ? o : [NO_OWNER]; }))]
    .sort((x, y) => (x === NO_OWNER) - (y === NO_OWNER) || x.localeCompare(y));
  const areas = AREA_ORDER.filter((k) => pool.some((x) => String(x.layer) === k));
  if (f.person && !owners.includes(f.person)) f.person = "";
  if (f.area && !areas.includes(f.area)) f.area = "";
  const option = (value, label, selected) => `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`;
  const viewCount = (v) => (v === "open" ? openPool.length : flags.filter((x) => !isContextFlag(x) && viewOf(x) === v).length);
  $("q-filters").innerHTML = `
    <div class="q-seg" role="group" aria-label="Pile">${QUEUE_VIEWS
      .map(([k, l]) => `<button type="button" class="${f.view === k ? "on" : ""}" aria-pressed="${f.view === k}" data-qf-view="${k}">${esc(l)} <span>${esc(viewCount(k))}</span></button>`)
      .join("")}</div>
    <div class="q-kinds" role="group" aria-label="Kind">${QUEUE_KINDS
      .map(([k, l]) => {
        const n = k ? base.filter((x) => x.severity === k).length : base.length;
        if (k && !n && f.kind !== k) return "";
        return `<button type="button" class="q-kind ${k || "all"}${f.kind === k ? " on" : ""}" aria-pressed="${f.kind === k}" data-qf-kind="${k}">${esc(l)} <span>${esc(n)}</span></button>`;
      })
      .join("")}</div>
    <select id="q-person" class="sm" aria-label="Person">${option("", "Everyone", f.person)}${owners.map((o) => option(o, o, f.person)).join("")}</select>
    <select id="q-area" class="sm" aria-label="Area">${option("", "All areas", f.area)}${areas.map((k) => option(k, AREA_LABEL[k] ?? k, f.area)).join("")}</select>
    ${queueFiltered() ? `<button type="button" class="link-btn" data-qf-clear>Clear</button>` : ""}`;

  const close = (id) => `<button type="button" class="link-btn" data-q-open="${esc(id)}">Close</button>`;
  const row = (x) => (queue.open.has(x.id) ? `<div class="q-opened">${flagCard(x)}${close(x.id)}</div>` : queueRow(x));
  const body = $("q-body");
  if (!shownFlags.length) {
    body.innerHTML = (f.view === "waiting" ? scheduledList() : "") + (pool.length
      ? `<p class="sub q-empty">Nothing matches these filters. <button type="button" class="link-btn" data-qf-clear>Clear filters</button></p>`
      : `<p class="sub q-empty">${esc({ open: "Nothing open that needs you.", waiting: "Nothing is waiting on anyone.", parked: "Nothing done, snoozed or hidden." }[f.view])}</p>`);
    return;
  }
  const more = (n) => (n > 0 ? `<button type="button" class="link-btn q-all" data-q-more>${queue.all ? "Show fewer" : `Show all ${n}`}</button>` : "");

  // Filtered, or a pile other than open: a flat list, newest decisions first as ranked.
  if (f.view !== "open" || queueFiltered()) {
    const folded = clusterByKind(foldTests(shownFlags.map((x) => ({ kind: "flag", flag: x }))));
    const list = queue.all ? folded : folded.slice(0, 25);
    const line = (i) => (i.kind === "test" ? (queue.open.has(testKey(i)) ? testOpened(i, close(testKey(i))) : testRow(i)) : row(i.flag));
    body.innerHTML = `${f.view === "waiting" ? scheduledList() : ""}<div class="q-list">${runs(list, line)}</div>${more(folded.length > 25 ? folded.length : 0)}`;
    return;
  }

  // Unfiltered open queue: routine sprint checks fold into one line per person, top three in full.
  const grouped = groupByPerson(shownFlags, groupOpts());
  const groups = grouped.groups;
  const items = foldTests(grouped.items);
  state.queueGroups = new Map(groups.map((g) => [g.person, g]));
  const top = items.slice(0, 3);
  const rest = clusterByKind(items.slice(3));
  const shown = queue.all ? rest : rest.slice(0, QUEUE_ROWS);
  const card = (i) => (i.kind === "group" ? groupCard(i) : i.kind === "test" ? testOpened(i, "") : flagCard(i.flag));
  const line = (i) => {
    if (i.kind === "group") return queue.open.has(groupId(i)) ? `<div class="q-opened">${groupCard(i)}${close(groupId(i))}</div>` : groupRow(i);
    if (i.kind === "test") return queue.open.has(testKey(i)) ? testOpened(i, close(testKey(i))) : testRow(i);
    return row(i.flag);
  };
  body.innerHTML = `
    ${top.length ? `<p class="q-label">Do first</p><div class="q-tops">${top.map((i, n) => `<div class="q-top"><span class="q-rank">${n + 1}</span>${card(i)}</div>`).join("")}</div>` : ""}
    ${rest.length ? `<p class="q-label">Then <span class="meta">${rest.length} more, highest first</span></p>
      <div class="q-list">${runs(shown, line)}</div>
      ${rest.length > QUEUE_ROWS ? more(rest.length) : ""}` : ""}`;
}

$("start-here")?.addEventListener("click", (event) => {
  const v = event.target.closest("[data-qf-view]");
  const k = event.target.closest("[data-qf-kind]");
  const clear = event.target.closest("[data-qf-clear]");
  if (!v && !k && !clear) return;
  if (v) {
    queue.f.view = v.dataset.qfView;
    if (queue.f.view === "waiting") { sched.data = null; loadScheduled(); }
  }
  if (k) queue.f.kind = k.dataset.qfKind;
  if (clear) {
    Object.assign(queue.f, { kind: "", person: "", area: "", q: "" });
    if ($("q-search")) $("q-search").value = "";
  }
  queue.all = false;
  renderTopThree(state.report?.flags ?? []);
});
$("start-here")?.addEventListener("change", (event) => {
  const key = { "q-person": "person", "q-area": "area" }[event.target.id];
  if (!key) return;
  queue.f[key] = event.target.value;
  queue.all = false;
  renderTopThree(state.report?.flags ?? []);
});
$("start-here")?.addEventListener("input", (event) => {
  if (event.target.id !== "q-search") return;
  queue.f.q = event.target.value;
  renderTopThree(state.report?.flags ?? []);
});

/**
 * One message for everything a person has open: each ticket once, with where it is, when
 * it is due and the question to answer, the same reasoning as a single ticket's nudge.
 * For Alex to send himself; nothing is sent from here.
 */
function groupNudgeText(g) {
  const tasks = state.flagCtx?.tasks ?? new Map();
  const seen = new Set();
  const lines = [];
  const found = [];
  const addTicket = (id, fallbackName, fallbackUrl) => {
    const key = String(id);
    if (seen.has(key)) return;
    seen.add(key);
    const task = tasks.get(key);
    if (task) {
      found.push(task);
      const f = ticketFacts(task);
      const url = task.url ?? fallbackUrl;
      lines.push(`"${task.name}": ${f.where} ${f.ask}${url ? ` ${url}` : ""}`);
    } else if (fallbackName) lines.push(`"${fallbackName}"${fallbackUrl ? ` ${fallbackUrl}` : ""}`);
  };
  for (const f of g.flags) {
    const subject = subjectOf(f);
    if (subject.type === "task") addTicket(baseId(subject.id), subject.label, subject.url ?? f.url);
    else if (Array.isArray(f.values?.tickets) && f.values.tickets.length) for (const t of f.values.tickets) addTicket(t.id, t.name, t.url);
    else if (!seen.has(f.id)) {
      seen.add(f.id);
      lines.push(f.message);
    }
  }
  const shown = lines.slice(0, 10);
  const more = lines.length - shown.length;
  const name = matchPerson(g.person)?.name ?? g.person;
  return [
    nudgeEmojis(found),
    `@${name} Can you give me a quick update on a few of your sprint items?`,
    [...shown.map((l) => `• ${l}`), ...(more > 0 ? [`• and ${more} more on the sprint board`] : [])].join("\n"),
    NUDGE_CLOSE.replace("keep it moving", "keep them moving"),
  ].filter(Boolean).join("\n\n");
}

/** Triage on several flags at once: saved one after another, drawn once at the end. */
async function saveTriageMany(flags, payload) {
  const failed = [];
  for (const f of flags) {
    try {
      const res = await fetch(`${FN}/flags`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: keyOf(f), layer: f.layer, ...payload }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      state.flagEntries = { ...(state.flagEntries ?? {}), [body.key]: body.entry };
      if (body.today) state.today = body.today;
    } catch (err) {
      failed.push(err.message);
    }
  }
  renderAllFlags();
  return failed;
}

/** "Assign in ClickUp" on a nobody-assigned card: adds the assignee, then marks the cards Done. */
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-owner-set]");
  if (!button) return;
  const box = button.closest("[data-owner-fix]");
  const ownerId = box.querySelector("[data-owner-pick]")?.value;
  const say = (text, bad = true) => {
    box.querySelector(".owner-msg")?.remove();
    box.insertAdjacentHTML("beforeend", `<span class="owner-msg ${bad ? "triage-error" : "meta"}">${esc(text)}</span>`);
  };
  if (!ownerId) return say("Choose someone first.");
  const keys = new Set(box.dataset.ownerFix.split("|"));
  const flags = (state.report?.flags ?? []).filter((f) => keys.has(keyOf(f)));
  const taskIds = flags.map((f) => baseId(subjectOf(f).id));
  const name = box.querySelector("[data-owner-pick]").selectedOptions[0]?.textContent ?? "them";
  button.disabled = true;
  say("Saving to ClickUp…", false);
  try {
    const res = await fetch(`${FN}/ticket-assignee`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskIds, assigneeId: ownerId }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && !body.set?.length) throw new Error(body.error ?? body.failed?.[0]?.error ?? `HTTP ${res.status}`);
    const done = new Set((body.set ?? []).map(String));
    for (const t of state.report?.detail?.clickup?.tasks ?? []) {
      if (done.has(String(t.id))) t.assignees = [...(t.assignees ?? []), { id: ownerId, username: body.assignee?.name ?? name }];
    }
    const failed = await saveTriageMany(
      flags.filter((f) => done.has(baseId(subjectOf(f).id))),
      { status: "done", note: `Assigned to ${body.assignee?.name ?? name} in ClickUp` },
    );
    if (body.failed?.length || failed.length) alert(`Assigned on ${done.size} of ${taskIds.length}. Not set: ${body.failed?.[0]?.error ?? failed[0]}`);
  } catch (err) {
    button.disabled = false;
    say(`Not set: ${err.message}`);
  }
});

$("start-here").addEventListener("click", async (event) => {
  const act = event.target.closest("[data-group-act]");
  if (!act) return;
  const box = act.closest("[data-group-person]");
  const g = state.queueGroups?.get(box?.dataset.groupPerson);
  if (!g) return;
  const panel = box.querySelector(".group-panel");
  const open = g.flags.filter((f) => !triageOf(f));
  const report = (failed) => {
    if (!failed.length) return;
    const again = $("start-here").querySelector(`[data-group-person="${CSS.escape(g.person)}"] .group-panel`) ?? panel;
    again.classList.remove("hidden");
    again.innerHTML = `<p class="triage-error">${esc(plural(failed.length, "item was", "items were"))} not saved: ${esc(failed[0])}</p>`;
  };
  if (act.dataset.groupAct === "done") return report(await saveTriageMany(open, { status: "done" }));
  if (act.dataset.groupAct === "hide") return report(await saveTriageMany(open, { status: "snoozed", calendarDays: 1, note: "hidden for today" }));
  if (act.dataset.groupAct === "nudge") {
    if (!panel.classList.contains("hidden") && panel.dataset.kind === "nudge") return panel.classList.add("hidden");
    const name = matchPerson(g.person)?.name ?? g.person;
    panel.dataset.kind = "nudge";
    panel.innerHTML = `
      <label class="wide">To ${esc(name)} <span class="meta">Copy it to send yourself, or schedule it below.</span>
        <textarea class="group-nudge-text" rows="${Math.min(14, g.flags.length + 4)}">${esc(groupNudgeText(g))}</textarea></label>
      <button type="button" class="sm" data-group-act="nudge-copy">Copy, and mark all waiting on ${esc(name)}</button>
      ${scheduleRow()}`;
    panel.classList.remove("hidden");
    return;
  }
  if (act.dataset.groupAct === "nudge-copy") {
    const name = matchPerson(g.person)?.name ?? g.person;
    try {
      await navigator.clipboard.writeText(panel.querySelector(".group-nudge-text")?.value ?? "");
    } catch {
      panel.insertAdjacentHTML("afterbegin", `<p class="triage-error">The browser would not copy. Select the message and copy it by hand.</p>`);
      return;
    }
    return report(await saveTriageMany(open, { status: "waiting", waitingOn: name }));
  }
});

$("start-here").addEventListener("click", (event) => {
  if (event.target.closest("[data-q-focus]")) return $("focus")?.scrollIntoView({ behavior: "smooth", block: "start" });
  const more = event.target.closest("[data-q-more]");
  const open = event.target.closest("[data-q-open]");
  if (more) queue.all = !queue.all;
  else if (open) {
    const id = open.dataset.qOpen;
    queue.open.has(id) ? queue.open.delete(id) : queue.open.add(id);
  } else return;
  renderTopThree(state.report?.flags ?? []);
});
$("start-here").addEventListener("toggle", (event) => {
}, true);

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

// Done and the advisor stay out; everything else that handles a flag sits under one menu.
// A compact card keeps its quick fix folded until "Fix it here".
/** What each action in Take action does, for the ⓘ beside it. */
const ACTION_HELP = {
  fix: "Opens this flag's quick fix right here on the card.",
  nudge: "Writes a short message to the person on this, for you to copy and send yourself. Nothing is sent from here. Copying it marks the flag Waiting on them for 2 working days.",
  waiting: "You have asked someone and are waiting to hear back. Pick who, and when to check back (2 working days unless you change it). It leaves your queue until then, and comes back if it still holds.",
  snooze1: "Hides it until the next working day. If the problem is still there, it comes back.",
  snooze3: "Hides it for 3 working days, skipping weekends. If the problem is still there, it comes back.",
  snooze5: "Hides it for 5 working days. If the problem is still there, it comes back.",
  done: "You have dealt with it. It leaves your queue and stays hidden while the same problem is raised. If it clears and happens again later, it comes back as new. Undo from Hidden or handled.",
  advise: "Asks Claude for a recommendation on this flag: what to do, why, and the trade-offs, weighed against this quarter's rocks. One model call per click; a second click shows the same answer.",
  dismiss: "The flag is wrong, or this does not matter here. It stays hidden as long as the same problem is raised; if it clears and happens again later, it is new. Add why if you like: the Rule check counts these to find noisy rules.",
};
const SNOOZE_NOTE = " It keeps aging while hidden, so a P2 can come back as a P1.";

const infoIcon = (help) => `<span class="act-info" tabindex="0" role="note" aria-label="${esc(help)}" data-tip="${esc(help)}">i</span>`;

function triageActions(flag, { compact = false, fix = false } = {}) {
  const item = (act, label, help, extra = "") =>
    `<div class="menu-row"><button type="button" class="menu-item" data-triage="${act}"${extra}>${esc(label)}</button>${infoIcon(help)}</div>`;
  return `<div class="triage-actions">
      <span class="act-with-info"><button type="button" class="sm" data-triage="done">Done</button>${infoIcon(ACTION_HELP.done)}</span>
      <details class="act-menu">
        <summary class="btn-ghost sm">Take action ▾</summary>
        <div class="act-pop">
          ${compact && fix ? item("fix-toggle", "Fix it here", ACTION_HELP.fix) : ""}
          ${item("nudge-open", "Draft a nudge", ACTION_HELP.nudge)}
          ${item("waiting-open", "Waiting on…", ACTION_HELP.waiting)}
          ${flagTask(flag) ? item("due-open", "Set due date…", "Set this ticket's due date in ClickUp. Only the due date changes.") : ""}
          <span class="menu-sep">Snooze</span>
          ${item("snooze", "1 working day", ACTION_HELP.snooze1 + SNOOZE_NOTE, ' data-days="1"')}
          ${item("snooze", "3 working days", ACTION_HELP.snooze3 + SNOOZE_NOTE, ' data-days="3"')}
          ${item("snooze", "1 week", ACTION_HELP.snooze5 + SNOOZE_NOTE, ' data-days="5"')}
          <span class="menu-sep"></span>
          ${item("dismiss-open", "Not a problem…", ACTION_HELP.dismiss)}
        </div>
      </details>
      ${flag.advisable ? `<span class="act-with-info"><button type="button" class="ghost sm advise" data-flag="${esc(flag.id)}">${esc(state.advisorButtonText)}</button>${infoIcon(ACTION_HELP.advise)}</span>` : ""}
    </div>
    <div class="triage-panel hidden"></div>`;
}

/**
 * A flag: what is wrong and why, then where to go and what to do. The first external link
 * (the ClickUp ticket, the Intelligems test) is the primary quicklink. The × hides the
 * flag for the rest of the calendar day; it is back tomorrow if the condition still holds.
 * `compact` is the Next steps card: no rule line, quick fix folded, `also` on the badges.
 */
function flagCard(flag, { compact = false, also = 0 } = {}) {
  const ctx = flagContext(flag);
  const t = triageOf(flag);
  // ClickUp links are primary; on a card without one, the first external link is.
  const primary = ctx.links.some((l) => l.clickup) ? -1 : ctx.links.findIndex((l) => l.external);
  const links = ctx.links
    .map((l, i) =>
      l.more
        ? `<span class="ql more">${esc(l.label)}</span>`
        : l.external
          ? `<a class="ql${l.clickup || i === primary ? " primary" : ""}" href="${esc(l.href)}" target="_blank" rel="noreferrer"${l.title ? ` title="${esc(l.title)}"` : ""}>${esc(l.label)} ↗</a>`
          : `<a class="ql" href="${esc(l.href)}">${esc(l.label)}</a>`,
    )
    .join("");
  const fix = t ? "" : quickFix(flag);
  const badges = `${also ? `<span class="chip">+${esc(also)} more on this ticket</span>` : ""}${ageBadges(flag)}`;
  return `
      <div class="flag sev-${esc(flag.severity)}${compact ? " ns-compact" : ""}"${t ? " data-triaged" : ""} data-flag="${esc(flag.id)}" data-key="${esc(keyOf(flag))}" data-layer="${esc(flag.layer)}">
        ${t ? "" : `<button type="button" class="flag-x" data-triage="hide-today" title="Hide for today. Back tomorrow if it still holds." aria-label="Hide for today">×</button>`}
        <p class="msg">${esc(flag.message)}</p>
        <p class="meta" title="${esc(flag.rule)}">${esc(AREA_LABEL[flag.layer] ?? layerLabel(flag.layer))}${ctx.owners.length ? ` · ${esc(ctx.owners.join(", "))}` : ""}</p>
        ${badges || links ? `<div class="flag-foot">${links ? `<span class="quicklinks">${links}</span>` : ""}<span class="flag-badges">${badges}</span></div>` : ""}
        ${t ? triageBanner(flag, t) : `${fix}${triageActions(flag, { compact, fix: Boolean(fix) })}`}
        <div class="advice hidden"></div>
      </div>`;
}

/* --------------------------- needs your attention ---------------------------
   A flag names its subject by type and id. These lookups turn that into who owns it and
   where to go to fix it: the ClickUp ticket, the rock editor, the test's readout and its
   Intelligems page. Subject ids carry a suffix per rule (`<rockId>:status`,
   `<testId>:gate`), so they are matched on the part before the first colon. */

const AREA_LABEL = { 1: "Rocks", cross: "Team", 3: "Tests", 2: "Sprint", 0: "Store" };
const AREA_ORDER = ["1", "cross", "3", "2", "0"]; // the same order sortFlags uses
const NO_OWNER = "No owner";

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
      // The assignees: a nudge goes to the person doing the work.
      owners = [...new Set((task?.assignees ?? []).map((u) => u.username).filter(Boolean))];
      url = subject.url ?? flag.url ?? task?.url ?? null;
      // ClickUp only: a Sprint link was the same on every ticket.
      if (url) links.push({ label: "ClickUp", href: url, external: true, clickup: true });
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
      if (test) links.push({ label: "AB Testing", href: AB_TESTING, external: true });
      if (url) links.push({ label: "Intelligems", href: url, external: true });
      break;
    }
    case "priority": {
      const rock = idx.rocks.get(id);
      if (rock?.owner?.name) owners = [rock.owner.name];
      links.push({ label: "Edit rock", href: `#rocks/${encodeURIComponent(id)}` });
      if (rock?.intelligemsExperienceId) {
        links.push({ label: "AB Testing", href: AB_TESTING, external: true });
      }
      break;
    }
    case "person":
      owners = subject.label ? [subject.label] : [];
      links.push({ label: "Their rocks", href: `#rocks/${encodeURIComponent(subject.label ?? "")}` });
      // Person subject ids start with their ClickUp id (`<id>:carried:<week>`); the 1:1 page opens on it.
      if (subject.id) links.push({ label: "Their 1:1", href: `#people/${encodeURIComponent(String(subject.id).split(":")[0])}` });
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
      links.push({ label: "Ecom Reporting Hub", href: ECOM_HUB, external: true });
      break;
  }
  // A flag about a person or a rock names several tickets: each gets its ClickUp link,
  // ahead of the in-app ones. A long list stops at four and the rest are a count.
  const tickets = Array.isArray(flag.values?.tickets) ? flag.values.tickets.filter((t) => t?.url) : [];
  if (subject.type !== "task" && tickets.length) {
    const short = (name) => (String(name).length > 28 ? `${String(name).slice(0, 26).trimEnd()}…` : String(name));
    links.unshift(
      ...tickets.slice(0, 4).map((t) => ({ label: short(t.name), title: t.name, href: t.url, external: true, clickup: true })),
      ...(tickets.length > 4 ? [{ label: `+${tickets.length - 4} more`, more: true }] : []),
    );
  }
  return { owners, links, url, itemKey: `${subject.type}:${id}`, itemLabel: itemLabel ?? ruleLabel(flag.rule) };
}

/* -------------------------------- quick fixes --------------------------------
   A Layer 1 flag is about a rock, and rocks are this system's own data, so the fix can
   sit on the flag: the one field the rule is about, saved through the same rocks API
   the editor uses, versioned and audited the same way. A flag fixed here is marked Done,
   and the next run clears it for good once the rule no longer fires.

   ClickUp and Intelligems flags get no quick fix. The system does not write to those
   platforms; their links go there instead. */

const todayKey = () => state.today ?? new Date().toISOString().slice(0, 10);
const rockById = (id) => (state.rocks?.rocks ?? []).find((r) => String(r.id) === String(id)) ?? null;

/* When the rocks come from Supabase they are read only here. What can still be set is
   what only this app holds, per rock and per tactic: the ClickUp owner, the Big Swing,
   and the links. */
const fromSupabase = () => state.rocks?.source === "supabase";
const SB_NOTE = "This rock comes from Supabase. Change it in the standup app; the dashboard reads it from there.";
/** Every Big Swing option a rock is reached through: its own and, from Supabase, its tactics'. */
const swingIdsOf = (r) => (r?.clickupBigSwingOptionIds ?? (r?.clickupBigSwingOptionId ? [r.clickupBigSwingOptionId] : [])).map(String);
const ownsSwing = (r, optionId) => optionId != null && swingIdsOf(r).includes(String(optionId));
/** A rock, or a Supabase tactic, by id: anything a Big Swing or an owner can be set on. */
function linkTargetById(id) {
  for (const r of state.rocks?.rocks ?? []) {
    if (String(r.id) === String(id)) return { ...r, kind: "rock" };
    for (const t of r.tactics ?? []) if (String(t.id) === String(id)) return { ...t, kind: "tactic", rock: r };
  }
  return null;
}

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

/**
 * Who should be on the tickets with nobody assigned: a roster picker that adds the
 * assignee in ClickUp, then marks the cards Done.
 */
function ownerPicker(flags, { label = "Assign to" } = {}) {
  const people = (state.people ?? []).filter((p) => p.clickupUserId);
  const options = [...(state.me ? [{ clickupUserId: state.me, name: "Me" }] : []), ...people];
  if (!options.length) return "";
  const guess = "";
  return `<div class="quick-fix" data-owner-fix="${esc(flags.map(keyOf).join("|"))}">
      <label>${esc(label)} <select class="sm" data-owner-pick><option value="">Choose…</option>${options
        .map((p) => `<option value="${esc(p.clickupUserId)}"${String(p.clickupUserId) === String(guess) ? " selected" : ""}>${esc(p.name)}</option>`)
        .join("")}</select></label>
      <button type="button" class="sm" data-owner-set>Assign in ClickUp</button>
    </div>`;
}

/* --------------------------------- set ROCK ---------------------------------
   On a card about tickets with no ROCK (the ClickUp field once called Big Swing): pick a
   live rock per ticket and set it in ClickUp (netlify/functions/ticket-rock.mjs). */

const ROCK_FIX_RULES = new Set(["clickup.no_big_swing_set", "crosslayer.no_big_swing", "crosslayer.unrelated_pile"]);

/** Active rocks with a ClickUp ROCK option: what a ticket can be put on. Mirrors src/send/clickup-rock.js. */
function rockChoices() {
  return (state.report?.detail?.leadership?.queue ?? [])
    .filter((r) => r.state === "active")
    .map((r) => ({ id: r.id, title: r.title, bau: Boolean(r.bau), optionIds: r.clickupBigSwingOptionIds ?? (r.clickupBigSwingOptionId ? [r.clickupBigSwingOptionId] : []) }))
    .filter((r) => r.optionIds.length)
    .sort((a, b) => a.bau - b.bau || a.title.localeCompare(b.title));
}

/** The open tickets a flag is about that have no ROCK on a live rock. */
function ticketsWithoutRock(flag) {
  const tasks = state.flagCtx?.tasks ?? new Map();
  const live = new Set(rockChoices().flatMap((r) => r.optionIds.map(String)));
  const unplaced = (t) => t && t.bucket !== "done" && !t.archived && !(t.bigSwing?.optionId && live.has(String(t.bigSwing.optionId)));
  const subject = subjectOf(flag);
  if (subject.type === "task") return [tasks.get(baseId(subject.id))].filter(unplaced);
  if (subject.type === "person") {
    const who = baseId(subject.id);
    return [...tasks.values()].filter((t) => (t.assignees ?? []).some((u) => String(u.id) === who)).filter(unplaced);
  }
  return [];
}

function rockPicker(flag) {
  const tickets = ticketsWithoutRock(flag).slice(0, 8);
  const rocks = rockChoices();
  if (!tickets.length || !rocks.length) return "";
  const options = `<option value="">ROCK…</option>${rocks.map((r) => `<option value="${esc(r.id)}">${esc(r.title)}</option>`).join("")}`;
  return `<div class="quick-fix rock-fix" data-rock-fix="${esc(keyOf(flag))}">
      <p class="rock-fix-head">Set ROCK in ClickUp</p>
      ${tickets
        .map((t) => `<div class="rock-fix-row">
          <span class="rock-fix-name">${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.name)}</a>` : esc(t.name)}</span>
          <select class="sm" data-rock-pick="${esc(t.id)}" aria-label="ROCK for ${esc(t.name)}">${options}</select>
        </div>`)
        .join("")}
      <div class="rock-fix-acts"><button type="button" class="sm" data-rock-set>Set ROCK</button><span class="rock-fix-msg meta"></span></div>
    </div>`;
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-rock-set]");
  if (!button) return;
  const box = button.closest("[data-rock-fix]");
  const say = (text, bad = false) => {
    const el = box.querySelector(".rock-fix-msg");
    el.textContent = text;
    el.classList.toggle("triage-error", bad);
  };
  const picks = [...box.querySelectorAll("[data-rock-pick]")].filter((sel) => sel.value).map((sel) => ({ taskId: sel.dataset.rockPick, rockId: sel.value }));
  if (!picks.length) return say("Choose a ROCK for at least one ticket.", true);
  const byRock = new Map();
  for (const p of picks) byRock.set(p.rockId, [...(byRock.get(p.rockId) ?? []), p.taskId]);
  button.disabled = true;
  say("Saving to ClickUp…");
  const done = [];
  const failed = [];
  for (const [rockId, taskIds] of byRock) {
    try {
      const res = await fetch(`${FN}/ticket-rock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskIds, rockId }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && !body.set?.length) throw new Error(body.error ?? body.failed?.[0]?.error ?? `HTTP ${res.status}`);
      for (const id of body.set ?? []) {
        const t = state.flagCtx?.tasks.get(String(id));
        if (t) t.bigSwing = { optionId: body.rock.optionId, label: body.rock.title };
        done.push(id);
      }
      for (const f of body.failed ?? []) failed.push(f.error);
    } catch (err) {
      failed.push(err.message);
    }
  }
  if (!done.length) {
    button.disabled = false;
    return say(`Not set: ${failed[0]}`, true);
  }
  // The card is handled once none of its tickets is left without a ROCK.
  const flag = (state.report?.flags ?? []).find((f) => keyOf(f) === box.dataset.rockFix);
  if (flag && !ticketsWithoutRock(flag).length) {
    await saveTriageMany([flag], { status: "done", note: `ROCK set in ClickUp on ${plural(done.length, "ticket", "tickets")}` });
  } else {
    renderAllFlags();
  }
  if (failed.length) alert(`ROCK set on ${done.length}. Not set on ${failed.length}: ${failed[0]}`);
});

/* -------------------------------- set due date --------------------------------
   On a card about a ticket's due date (none, overdue, due and not started), or from Take
   action on any ticket card: pick a date and set it in ClickUp (netlify/functions/ticket-due.mjs). */

const DUE_RULES = new Set(["nextstep.no_due_date", "nextstep.overdue", "nextstep.due_not_started"]);

/** The open ticket a flag is about, if it is about one. */
function flagTask(flag) {
  const sub = subjectOf(flag);
  const t = sub.type === "task" ? state.flagCtx?.tasks.get(baseId(sub.id)) : null;
  return t && t.bucket !== "done" ? t : null;
}

/** Friday this week, or next Friday from the weekend, as YYYY-MM-DD. */
function nextFriday() {
  const d = new Date();
  const add = (5 - d.getDay() + 7) % 7 || (d.getDay() === 5 ? 0 : 7);
  d.setDate(d.getDate() + add);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dueFix(flag) {
  const t = flagTask(flag);
  if (!t) return "";
  const today = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const min = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const now = t.dueDate ? `Now due ${new Date(t.dueDate).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}.` : "No due date yet.";
  return `<div class="quick-fix due-fix" data-due-fix="${esc(keyOf(flag))}" data-task="${esc(t.id)}">
      <label>Due date <input type="date" class="sm" data-due-date min="${min}" value="${esc(nextFriday())}"></label>
      <button type="button" class="sm" data-due-set>Set in ClickUp</button>
      <span class="meta">${esc(now)}</span>
      <span class="due-msg meta"></span>
    </div>`;
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-due-set]");
  if (!button) return;
  const box = button.closest("[data-due-fix]");
  const msg = box.querySelector(".due-msg");
  const date = box.querySelector("[data-due-date]")?.value;
  if (!date) {
    msg.textContent = "Pick a date.";
    return;
  }
  button.disabled = true;
  msg.textContent = "Saving to ClickUp…";
  try {
    const res = await fetch(`${FN}/ticket-due`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: box.dataset.task, date }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    const t = state.flagCtx?.tasks.get(String(box.dataset.task));
    if (t) t.dueDate = body.dueDate;
    const when = new Date(body.dueDate).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
    // A card about the due date is handled by setting one; any other card just learns the date.
    const flag = (state.report?.flags ?? []).find((f) => keyOf(f) === box.dataset.dueFix);
    if (flag && DUE_RULES.has(flag.rule)) await saveTriageMany([flag], { status: "done", note: `Due date set to ${when} in ClickUp` });
    else {
      msg.textContent = `Due ${when} in ClickUp.`;
      button.disabled = false;
    }
  } catch (err) {
    button.disabled = false;
    msg.textContent = `Not set: ${err.message}`;
    msg.classList.add("triage-error");
  }
});

function quickFix(flag) {
  if (flag.rule === "nextstep.no_assignee") return ownerPicker([flag]);
  if (DUE_RULES.has(flag.rule)) return dueFix(flag);
  if (ROCK_FIX_RULES.has(flag.rule)) return rockPicker(flag);
  // A rock off course: every reason with its fix, and the plan to re-plan it in.
  if (flag.rule === "leadership.rock_off_course") {
    const signals = flag.values?.signals ?? [];
    return `<div class="quick-fix quick-fix-rows">
      ${signals.length ? `<ul class="plain qp-flag-sigs">${signals.map((x) => `<li class="qp-sig ${esc(x.level)}">${esc(x.text)}. <span class="meta">Fix: ${esc(x.fix)}.</span></li>`).join("")}</ul>` : ""}
      <a class="ql primary" href="#plan/${esc(baseId(subjectOf(flag).id))}">Open in the Quarter plan</a>
    </div>`;
  }
  if (!String(flag.rule).startsWith("leadership.") && !["crosslayer.big_swing_without_rock", "crosslayer.rock_work_stalled"].includes(flag.rule)) return "";
  if (!state.rocks) return `<div class="quick-fix"><span class="meta">Loading the rock to edit…</span></div>`;
  const subject = subjectOf(flag);
  const kind = ROCK_FIXES[flag.rule];

  if (kind) {
    const rock = rockById(baseId(subject.id));
    if (!rock) return "";
    const id = esc(rock.id);
    const field = (inner) => `<div class="quick-fix" data-rock="${id}">${inner}</div>`;
    // Status, check-ins, KPI and dates live in Supabase. The owner and the Big Swing are
    // still this app's, so those two fixes stay.
    if (fromSupabase() && !["owner", "link"].includes(kind)) {
      const tickets = (flag.values?.tickets ?? [])
        .map((t) => `<a href="${esc(t.url ?? "#")}" target="_blank" rel="noreferrer">${esc(t.name)} · ${esc(t.idleDays)}d ↗</a>`)
        .join("");
      return field(`<span class="meta">${esc(SB_NOTE)}</span>${tickets ? `<span class="flag-links">${tickets}</span>` : ""}`);
    }
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
          ${fromSupabase() ? "" : `<button type="button" class="ghost sm" data-qf="set" data-field="state" data-value="backlog">Move to backlog</button>`}`);
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
      <span class="meta">${
        fromSupabase()
          ? "Link it to the rock or tactic it serves. If it is new work, add the tactic in the standup app first."
          : `A new rock is active, on track, owned by ${esc(subjectOf(flag).label ?? "them")} and linked to the Big Swing. Edit it afterwards for the KPI and dates.`
      }</span>
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
      <span class="meta">${
        fromSupabase()
          ? "Link it to the rock or tactic it serves, or set it aside as not a rock."
          : "A new rock is active and on track, linked to this Big Swing. Edit it afterwards for the KPI and dates."
      }</span>
    </div>`;
  }

  // Rocks linked to a Big Swing option that is no longer in the dropdown: relink each.
  // Reports from before the flag carried rock ids name rocks by title only.
  if (flag.rule === "leadership.dropdown_missing_option") {
    // A Supabase rock can hold several Big Swings through its tactics; relink in the editor.
    if (fromSupabase()) return `<div class="quick-fix"><span class="meta">Open the rock on the Rocks tab and relink the rock or tactic whose Big Swing is gone.</span></div>`;
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
  if (fromSupabase()) return `<div class="quick-fix"><span class="meta">Rocks come from Supabase, so there is no backlog here. Reassign owners on the Rocks tab, or change the rocks in the standup app.</span></div>`;
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
      ((ref.optionId && ownsSwing(r, ref.optionId)) ||
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
  // From Supabase, the choices are each rock and the open tactics under it.
  const targets = fromSupabase()
    ? sorted.flatMap((r) => [r, ...(r.tactics ?? []).filter((t) => t.status !== "done").map((t) => ({ ...t, label: `${r.title} › ${t.title}` }))])
    : sorted;
  const best = ref.optionId && fromSupabase() ? likelyRock(ref.label, targets) : likely;
  const rockChoices = targets
    .map((r) => `<option value="${esc(r.id)}"${r.id === best?.id ? " selected" : ""}>${esc(r.label ?? r.title)}${!r.state || r.state === "active" ? "" : ` (${esc(r.state)})`}</option>`)
    .join("");
  const owners = (state.rocks?.people ?? []).map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  return `<div class="qf-row" data-swing="${esc(ref.label)}" data-swing-id="${esc(ref.optionId ?? "")}" data-owner="${esc(ownerId)}">
    <span class="qf-title">${esc(ref.label)}</span>
    ${fromSupabase()
      ? ""
      : parked && parked.state === "backlog"
        ? `<button type="button" class="sm" data-qf="swing-activate" data-rock-id="${esc(parked.id)}">Make "${esc(parked.title)}" active</button>`
        : `${chooseOwner ? `<select class="sm" data-qf-input="swing-owner" aria-label="Owner"><option value="">Owner…</option>${owners}</select>` : ""}
         <button type="button" class="sm" data-qf="swing-add">Add as rock</button>`}
    ${ref.optionId
      ? `<select class="sm" data-qf-input="swing-rock" aria-label="Existing rock"><option value="">${fromSupabase() ? "link a rock or tactic…" : "or link a rock…"}</option>${rockChoices}</select>
         <button type="button" class="${best ? "" : "ghost "}sm" data-qf="swing-link">Link</button>
         ${best ? `<span class="meta">Looks like "${esc(best.title)}"</span>` : ""}`
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
    if (fromSupabase()) {
      // Only the owner and the Big Swing can be set on a Supabase rock or tactic.
      const { id, ...patch } = rock;
      if (!id) throw new Error("Rocks come from Supabase. Add it in the standup app.");
      await saveLinks(id, patch);
    } else {
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
    }

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

/**
 * Sets the owner, Big Swing or links on one Supabase rock or tactic, then reloads the
 * rocks so every view that draws from them catches up. Throws on a refusal.
 */
async function saveLinks(id, links) {
  const allowed = ["owner", "clickupBigSwingOptionId", "experimentLinks", "reportLinks", "websiteUrl", "notes"];
  const patch = Object.fromEntries(Object.entries(links).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(patch).length) throw new Error(SB_NOTE);
  const res = await fetch(`${FN}/rocks?links=1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, title: linkTargetById(id)?.title ?? null, links: patch, version: state.rocks?.version }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 409) await loadRocks();
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  await loadRocks();
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
      const rock = linkTargetById(id) ?? rockById(id);
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

/** After ×: a few seconds to take it back, and a pointer to where it went. */
function undoToast(flagId, key, layer) {
  document.getElementById("undo-toast")?.remove();
  const bar = document.createElement("div");
  bar.id = "undo-toast";
  bar.innerHTML = `Hidden for today. It is under <strong>Handled</strong> in Your queue. <button type="button" class="link-btn">Undo</button>`;
  bar.querySelector("button").addEventListener("click", async () => {
    bar.remove();
    const holder = document.createElement("div");
    Object.assign(holder.dataset, { flag: flagId, key, layer });
    await saveTriage(holder, { status: null });
  });
  document.body.append(bar);
  setTimeout(() => bar.remove(), 8000);
}

const findFlag = (card) => (state.report?.flags ?? []).find((f) => f.id === card.dataset.flag);

/* ------------------------------ schedule a nudge ------------------------------
   Under a drafted nudge: send it in Slack as a DM from Alex at a chosen time
   (netlify/functions/slack-schedule.mjs). Alex chose this on 2026-11-17. A line saying
   Claude drafted it is added at the end; nothing goes until Alex presses Schedule. */

/** 9:00 on the next working day, as a datetime-local value. */
function nextMorning() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function scheduleRow() {
  return `<div class="sched-row">
      <label>Or send it in Slack as you, at <input type="datetime-local" class="sm" data-sched-at value="${esc(nextMorning())}"></label>
      <button type="button" class="ghost sm" data-sched-send>Schedule in Slack</button>
      <span class="meta">A DM from your account. "Drafted with Claude" is added at the end.</span>
      <span class="sched-msg"></span>
    </div>`;
}

/* What is scheduled in Slack right now, read from Slack each time the Waiting pile opens. */
const sched = { data: null, loading: false, error: null };
async function loadScheduled() {
  if (sched.loading) return;
  sched.loading = true;
  try {
    const res = await fetch(`${FN}/slack-schedule`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    sched.data = body;
    sched.error = null;
  } catch (err) {
    sched.error = err.message;
  } finally {
    sched.loading = false;
    if (queue.f.view === "waiting") renderTopThree(state.report?.flags ?? []);
  }
}
function scheduledList() {
  if (sched.error) return `<p class="meta sched-list">Scheduled in Slack: could not read. ${esc(sched.error)}</p>`;
  if (!sched.data) return `<p class="meta sched-list">Reading what is scheduled in Slack…</p>`;
  const items = sched.data.items ?? [];
  const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `<div class="sched-list">
      <p class="q-label">Scheduled in Slack <span class="meta">${items.length ? `from ${esc(sched.data.from ?? "your account")}` : "nothing scheduled"}</span></p>
      ${items.map((m) => `<div class="flag q-row sched-item">
          <span class="q-sev">${esc(when(m.postAt))}</span>
          <span class="q-msg" title="${esc(m.text)}">To ${esc(m.to)}: ${esc(m.text)}</span>
          <span class="q-meta">Waiting to send</span>
          <span class="q-acts"><button type="button" class="ghost sm" data-sched-cancel="${esc(m.scheduledId)}" data-sched-channel="${esc(m.channel)}">Cancel</button></span>
        </div>`).join("")}
    </div>`;
}
document.addEventListener("click", async (event) => {
  const b = event.target.closest("[data-sched-cancel]");
  if (!b) return;
  b.disabled = true;
  const res = await fetch(`${FN}/slack-schedule`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cancel: { channel: b.dataset.schedChannel, scheduledId: b.dataset.schedCancel } }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    b.disabled = false;
    return alert(`Not cancelled: ${body.error ?? `HTTP ${res.status}`}`);
  }
  sched.data = null;
  loadScheduled();
});

function schedToast(result) {
  document.getElementById("undo-toast")?.remove();
  const bar = document.createElement("div");
  bar.id = "undo-toast";
  const when = new Date(result.postAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  bar.innerHTML = `Nudge to ${esc(result.to)} scheduled for ${esc(when)}${result.from ? `, from your Slack account (${esc(result.from)})` : ""}. In Slack it is under Drafts &amp; sent › Scheduled. <button type="button" class="link-btn">Cancel it</button>`;
  bar.querySelector("button").addEventListener("click", async () => {
    const res = await fetch(`${FN}/slack-schedule`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cancel: { channel: result.channel, scheduledId: result.scheduledId } }) });
    const body = await res.json().catch(() => ({}));
    bar.innerHTML = res.ok ? `Cancelled. Nothing will be sent to ${esc(result.to)}.` : `Not cancelled: ${esc(body.error ?? `HTTP ${res.status}`)}`;
    sched.data = null;
    setTimeout(() => bar.remove(), 5000);
  });
  document.body.append(bar);
  setTimeout(() => bar.remove(), 15000);
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-sched-send]");
  if (!button) return;
  const panel = button.closest(".triage-panel, .group-panel, .delegate-panel");
  const card = button.closest(".flag[data-key]");
  const group = button.closest("[data-group-person]");
  const msg = panel.querySelector(".sched-msg");
  const say = (text, bad = true) => { msg.textContent = text; msg.classList.toggle("triage-error", bad); };
  const text = panel.querySelector("#tp-text, .group-nudge-text")?.value ?? "";
  const g = group ? state.queueGroups?.get(group.dataset.groupPerson) : null;
  const to = g ? matchPerson(g.person)?.name ?? g.person : panel.querySelector("#tp-person")?.value;
  if (!to || to === "__other") return say("Pick who it goes to.");
  const at = panel.querySelector("[data-sched-at]")?.value;
  if (!at) return say("Pick a time.");
  button.disabled = true;
  say("Scheduling…", false);
  try {
    const res = await fetch(`${FN}/slack-schedule`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to, text, postAt: new Date(at).toISOString() }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    schedToast(body);
    // Scheduled is as good as sent: the card waits on them, as Copy does.
    if (g) await saveTriageMany(g.flags.filter((f) => !triageOf(f)), { status: "waiting", waitingOn: body.to });
    else if (card) await saveTriage(card, { status: "waiting", waitingOn: body.to });
  } catch (err) {
    button.disabled = false;
    say(`Not scheduled: ${err.message}`);
  }
});

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
/* ------------------------------- nudge drafts -------------------------------
   Written the way Alex writes them (his example, 2026-11-17):

     :package: :test_tube:

     @Blake Tucker Can we send a message ... getting alignment on test options for
     shipping test. I see that Oleks left comment last morning so want to keep that moving.
     ... Just want to make sure we are all on the same page ... and can keep it moving.
     Thanks! Feel free to adjust whatever you think will have better performance ...

   So: topic emojis, @ the person, the ask, what Alex saw (status, due date, the last
   comment and who left it), the why (keep it moving, same page), room for them to adjust,
   and thanks. Every fact comes from ClickUp; nothing is guessed. */

const NUDGE_EMOJI = [
  [/\b(a\/?b|ab)\b.*test|\btest\b/i, ":test_tube:"],
  [/bundle|box|shipping|ship\b|kit|gift/i, ":package:"],
  [/checkout|cart/i, ":shopping_trolley:"],
  [/subscri/i, ":repeat:"],
  [/\b(lp|pdp|plp|landing|page|hero|homepage)\b/i, ":page_facing_up:"],
  [/launch|new product/i, ":rocket:"],
  [/\b(bug|fix|broken)\b/i, ":hammer_and_wrench:"],
];
/** Up to two topic emojis for the tickets, from their names and rocks. */
function nudgeEmojis(tasks) {
  const text = tasks.map((t) => `${t.name ?? ""} ${t.bigSwing?.label ?? ""}`).join(" ");
  return NUDGE_EMOJI.filter(([re]) => re.test(text)).slice(0, 2).map(([, e]) => e).join(" ");
}

/** "today", "yesterday morning", "Monday afternoon", "4 days ago". */
function whenSaid(ms) {
  const d = new Date(ms);
  const part = d.getHours() < 12 ? "morning" : d.getHours() < 17 ? "afternoon" : "evening";
  const midnight = (x) => new Date(new Date(x).toDateString()).getTime();
  const days = Math.round((midnight(Date.now()) - midnight(ms)) / 86_400_000);
  if (days <= 0) return `this ${part}`;
  if (days === 1) return `yesterday ${part}`;
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: "long" })} ${part}`;
  return `${days} days ago`;
}

/** What Alex can see on a ticket, in his words: where it is, the due date, the last comment, and the ask. */
function ticketFacts(task) {
  const stage = stageOf(task);
  const status = String(task.status ?? "").toLowerCase();
  const midnight = (ms) => new Date(new Date(ms).toDateString()).getTime();
  const daysToDue = task.dueDate ? Math.round((midnight(task.dueDate) - midnight(Date.now())) / 86_400_000) : null;
  const dueOn = task.dueDate ? new Date(task.dueDate).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : null;
  const days = task.statusAge?.days;
  const forDays = days != null ? ` for ${task.statusAge.exact ? "" : "at least "}${plural(days, "day", "days")}` : "";
  const label = { work: status || "in progress", review: status || "review", deploy: "ready for deploy", blocked: "blocked" }[stage.id];
  const where = stage.id === "start"
    ? "It hasn't been started yet"
    : days === 0
      ? `It just moved to ${label}`
      : stage.id === "review" ? `It's been in ${label}${forDays}` : `It's been ${label}${forDays}`;
  const when =
    daysToDue == null ? " and there's no due date on it" : daysToDue < 0 ? ` and was due ${dueOn}` : daysToDue === 0 ? " and it's due today" : ` and it's due ${dueOn}`;
  const late = daysToDue != null && daysToDue < 0;
  const ask = {
    start: late ? "When can we get it started, and what's a realistic new date?" : daysToDue == null ? "When are you planning to start it? Can you add a due date too?" : `When are you starting it, so it still lands by ${dueOn}?`,
    work: late ? "What's left, and what's the new date?" : daysToDue == null ? "What's left, and when do you think it's done? Can you add a due date too?" : `What's left, and are we still on track for ${daysToDue === 0 ? "today" : dueOn}?`,
    review: late ? "What's left in review, and what's the new date?" : "What's left in review, and who's it waiting on?",
    deploy: "What's holding the deploy, and when can it go out?",
    blocked: "What's it blocked on? Happy to help unblock it.",
  }[stage.id];
  const c = task.lastComment;
  const who = c ? (state.me != null && String(c.userId) === String(state.me) ? "I" : String(c.user ?? "someone").split(/\s+/)[0]) : null;
  const fresh = c?.date && Date.now() - c.date < 3 * 86_400_000;
  const comment = !c?.date ? "" : fresh
    ? `I see ${who} left a comment ${whenSaid(c.date)}, so want to keep that moving.`
    : who === "I"
      ? `I last commented ${whenSaid(c.date)}, so want to get it moving again.`
      : `The last comment was ${whenSaid(c.date)} (${who}), so want to get it moving again.`;
  return { where: `${where}${when}.`, ask, comment };
}

const NUDGE_CLOSE = "Just want to make sure we're all on the same page and can keep it moving. Feel free to adjust whatever you think works best. Thanks!";

/** A ticket's nudge, in Alex's voice. `to` is who it goes to (a full name). */
function ticketNudge(task, url, to) {
  const f = ticketFacts(task);
  const head = nudgeEmojis([task]);
  return [
    head,
    `${to ? `@${to} ` : ""}Can you give me a quick update on "${task.name}"? ${f.where}${f.comment ? ` ${f.comment}` : ""}`,
    `${f.ask} ${NUDGE_CLOSE}${url ? `\n${url}` : ""}`,
  ].filter(Boolean).join("\n\n");
}

function nudgeText(flag) {
  const { url } = flagContext(flag);
  const subject = subjectOf(flag);
  const task = subject.type === "task" ? state.flagCtx?.tasks.get(baseId(subject.id)) : null;
  const to = peopleFor(flag)[0] ?? null;
  if (task) return ticketNudge(task, url, to);
  // A flag about several tickets (carried over, not started, ...): one bullet per ticket.
  const listed = (flag.values?.tickets ?? []).map((t) => state.flagCtx?.tasks.get(String(t.id)) ?? null).filter(Boolean);
  if (listed.length) {
    return [
      nudgeEmojis(listed),
      `${to ? `@${to} ` : ""}Can you give me a quick update on ${listed.length === 1 ? "this one" : "these"}?`,
      listed.map((t) => { const f = ticketFacts(t); return `• "${t.name}": ${f.where} ${f.ask}${t.url ? ` ${t.url}` : ""}`; }).join("\n"),
      NUDGE_CLOSE.replace("keep it moving", listed.length === 1 ? "keep it moving" : "keep them moving"),
    ].filter(Boolean).join("\n\n");
  }
  return `${to ? `@${to} ` : ""}Can you give me a quick update on this? ${flag.message}\n\nWhat's the next step, and when do you think it moves? ${NUDGE_CLOSE}${url ? `\n${url}` : ""}`;
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
  } else if (kind === "due") {
    panel.innerHTML = dueFix(flag) || `<p class="meta">This card is not about one open ticket.</p>`;
  } else if (kind === "nudge") {
    panel.innerHTML = `
      <label>To ${personSelect("tp-person")}</label>
      <label class="wide">Message <span class="meta">Copy it to send yourself, or schedule it below.</span>
        <textarea id="tp-text" rows="4">${esc(nudgeText(flag))}</textarea></label>
      <button type="button" class="sm" data-triage="nudge-copy">Copy, and mark waiting</button>
      ${scheduleRow()}`;
  }
  panel.classList.remove("hidden");
}

function chosenPerson(card) {
  const value = card.querySelector("#tp-person")?.value;
  if (value !== "__other") return value;
  return (window.prompt("Who is it waiting on?") ?? "").trim();
}

document.addEventListener("click", async (event) => {
  const el = event.target.closest("[data-triage]");
  if (!el || el.tagName === "SELECT") return;
  const card = el.closest(".flag[data-key]");
  if (!card) return;
  const action = el.dataset.triage;
  el.closest("details.act-menu")?.removeAttribute("open");

  if (action === "done") return saveTriage(card, { status: "done" });
  if (action === "hide-today") {
    const { key, layer, flag } = card.dataset;
    await saveTriage(card, { status: "snoozed", calendarDays: 1, note: "hidden for today" });
    return undoToast(flag, key, layer);
  }
  if (action === "snooze") return saveTriage(card, { status: "snoozed", workingDays: Number(el.dataset.days) });
  if (action === "fix-toggle") return card.classList.toggle("open");
  if (action === "clear") return saveTriage(card, { status: null });
  if (action === "waiting-open") return openPanel(card, "waiting");
  if (action === "dismiss-open") return openPanel(card, "dismiss");
  if (action === "nudge-open") return openPanel(card, "nudge");
  if (action === "due-open") return openPanel(card, "due");
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

/* -------------------------------- Ecom Rocks map --------------------------------
   Each rock as a hub: a circle with its title and owner, ringed by its course; its
   tactics branch out with their owners and status. Click a tactic for the tickets on it;
   click a rock to fold its tactics away (and back). Tickets are placed as the rock check
   places them (src/delta/rock-course.js placeTicket): a TACTIC value naming one of the
   rock's tactics, else a ROCK option the rock or a tactic is linked through, else a ROCK
   label equal to the rock's title. */

const rmap = { collapsed: new Set(), tactic: null, rockTickets: null };

/* -------------------------------- workshop --------------------------------
   The rock workshop agenda (public/workshop.js): live rock × tactic items ranked, quiet ones
   grayed. Skip / Discuss anyway are kept in this browser for the week. */
const ws = { include: new Set(), skip: new Set(), week: null, agenda: null };
function wsLoad(since) {
  if (ws.week === since) return;
  ws.week = since;
  try {
    const saved = JSON.parse(localStorage.getItem("workshop-picks") ?? "{}");
    const mine = saved.week === since ? saved : {};
    ws.include = new Set(mine.include ?? []);
    ws.skip = new Set(mine.skip ?? []);
  } catch {
    ws.include = new Set();
    ws.skip = new Set();
  }
}
function wsSave() {
  try {
    localStorage.setItem("workshop-picks", JSON.stringify({ week: ws.week, include: [...ws.include], skip: [...ws.skip] }));
  } catch {}
}
function renderWorkshop(report) {
  const host = $("workshop");
  if (!host) return;
  const detail = report.detail?.leadership;
  if (!detail?.queue) {
    host.innerHTML = `<div class="missing">The rocks were not in the latest readout.</div>`;
    return;
  }
  const rocks = detail.queue.filter((r) => r.state === "active");
  const courses = new Map((report.detail?.rockCourse ?? []).map((c) => [c.id, c]));
  const tasks = [...(report.detail?.clickup?.tasks ?? []), ...(report.detail?.backlog?.items ?? []).map((t) => ({ ...t, fromBacklog: true }))];
  const agenda = (ws.agenda = buildAgenda({ rocks, courses, tasks, placeOf: (t) => placeTicketOnRock(rocks, t) }));
  wsLoad(agenda.since);
  const on = [...agenda.live.filter((i) => !ws.skip.has(i.key)), ...agenda.quiet.filter((i) => ws.include.has(i.key))];
  const off = [...agenda.live.filter((i) => ws.skip.has(i.key)), ...agenda.quiet.filter((i) => !ws.include.has(i.key))];
  const first = (n) => (n ? String(n).split(/\s+/)[0] : "");
  const link = (x) => (x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noreferrer">${esc(x.name)}</a>` : esc(x.name));
  const item = (i, n) => {
    const owner = i.tactic?.owner ?? i.rock.owner;
    const tone = TACTIC_TONE[i.tactic ? i.tactic.status : i.rock.status] ?? "on";
    const added = !i.live;
    return `<li class="wk-item${n == null ? " wk-quiet" : ""}">
      <span class="dw-rank">${n ?? "–"}</span>
      <div class="wk-body">
        <div class="wk-rock">${esc(i.rock.title)}${i.rock.course !== "on" ? ` <span class="wk-course course-${esc(i.rock.course)}">${i.rock.course === "off" ? "off course" : "drifting"}</span>` : ""}</div>
        <div class="wk-title">${i.tactic ? esc(i.tactic.title) : "Rock update"}${owner ? ` <span class="meta">· ${esc(first(owner))}</span>` : ""}</div>
        <div class="dw-tags">
          ${i.workshop ? `<span class="dw-tag dw-rock">Workshop Priority</span>` : ""}
          ${i.bau ? `<span class="dw-tag">business as usual</span>` : ""}
          ${tone !== "on" ? `<span class="dw-tag wk-tone tone-${esc(tone)}">${esc(TACTIC_WORD[i.tactic ? i.tactic.status : i.rock.status] ?? "")}</span>` : ""}
          ${i.reasons.map((r) => `<span class="dw-tag">${esc(r)}</span>`).join("")}
          ${i.quietWhy ? `<span class="dw-tag">${esc(i.quietWhy)}</span>` : ""}
          ${added && n != null ? `<span class="dw-tag dw-carry">added by you</span>` : ""}
        </div>
        ${i.tactic?.notes ? `<p class="wk-notes">${esc(i.tactic.notes)}</p>` : ""}
        ${i.show.length || i.moving.length ? `<ul class="wk-tickets">
          ${i.show.slice(0, 4).map((x) => `<li><span class="wk-done">✓</span> ${link(x)} <span class="meta">${esc(x.who.join(", "))}</span></li>`).join("")}
          ${i.moving.slice(0, 3).map((x) => `<li><span class="mt-status">${esc(x.status ?? "")}</span> ${link(x)} <span class="meta">${esc(x.who.join(", "))}</span></li>`).join("")}
          ${i.show.length + i.moving.length > 7 ? `<li class="meta">and ${esc(i.show.length + i.moving.length - 7)} more</li>` : ""}
        </ul>` : ""}
      </div>
      <button type="button" class="ghost sm" data-wk="${esc(i.key)}">${n == null ? "Discuss anyway" : "Skip"}</button>
    </li>`;
  };
  host.innerHTML = `
    <div class="bar up-bar">
      <button type="button" id="wk-copy">Copy agenda</button>
      <span class="meta" data-copy-note="workshop">${esc(plural(on.length, "item", "items"))} to go over, ${esc(off.length)} grayed. Activity since ${esc(new Date(agenda.since).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }))}.</span>
    </div>
    <article class="ds-speech wk">
      ${on.length ? `<ol class="dw-list">${on.map((i, n) => item(i, n + 1)).join("")}</ol>` : `<p class="sub">Nothing on the rocks has moved in the last two sprints.</p>`}
    </article>
    ${off.length ? `<section class="wk-off"><div class="sp-group-head"><h3>Not worth going over</h3><span class="meta">${esc(plural(off.length, "item", "items"))}: nothing done or moving, or skipped by you</span></div>
      <ol class="dw-list">${off.map((i) => item(i, null)).join("")}</ol></section>` : ""}`;
}
document.addEventListener("click", async (event) => {
  const b = event.target.closest("[data-wk]");
  if (b) {
    const key = b.dataset.wk;
    const live = ws.agenda?.live.some((i) => i.key === key);
    const set = live ? ws.skip : ws.include;
    set.has(key) ? set.delete(key) : set.add(key);
    wsSave();
    if (state.report) renderWorkshop(state.report);
    return;
  }
  if (event.target.closest("#wk-copy") && ws.agenda) {
    const note = document.querySelector('[data-copy-note="workshop"]');
    try {
      await navigator.clipboard.writeText(agendaText(ws.agenda, { include: ws.include, skip: ws.skip }));
      if (note) note.textContent = "Copied.";
    } catch {
      if (note) note.textContent = "The browser would not copy.";
    }
  }
});

function placeTicketOnRock(rocks, task) {
  const ids = (xs) => (xs ?? []).filter(Boolean).map(String);
  const tacticOpt = task?.leadershipPriority?.optionId == null ? null : String(task.leadershipPriority.optionId);
  const swingOpt = task?.bigSwing?.optionId == null ? null : String(task.bigSwing.optionId);
  const swingLabel = String(task?.bigSwing?.label ?? "").trim().toLowerCase();
  const swingsOf = (r) => ids(r.clickupBigSwingOptionIds ?? (r.clickupBigSwingOptionId ? [r.clickupBigSwingOptionId] : []));
  const rock =
    rocks.find((r) => tacticOpt && ids(r.clickupTacticOptionIds).includes(tacticOpt)) ??
    (swingOpt ? rocks.find((r) => swingsOf(r).includes(swingOpt)) : null) ??
    (swingLabel ? rocks.find((r) => String(r.title ?? "").trim().toLowerCase() === swingLabel) : null);
  if (!rock) return null;
  const tactic = (rock.tactics ?? []).find(
    (t) => (tacticOpt && String(t.clickupTacticOptionId ?? "") === tacticOpt) || (swingOpt && String(t.clickupBigSwingOptionId ?? "") === swingOpt),
  );
  return { rockId: rock.id, tacticId: tactic?.id ?? null };
}

const ownerName = (o) => (o && typeof o === "object" ? o.name : o) || null;
const initials = (name) => (name ? String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() : "?");
const TACTIC_TONE = { done: "done", shipped: "done", on_track: "on", at_risk: "risk", off_track: "off", overdue: "off", blocked: "off" };
const TACTIC_WORD = { done: "done", shipped: "shipped", on_track: "on track", at_risk: "at risk", off_track: "off track", overdue: "overdue", blocked: "blocked" };

function renderLayer1(report) {
  const host = $("layer1");
  if (!host) return;
  const section = report.sections.leadership;
  const detail = report.detail?.leadership;
  if (!section?.present) {
    host.innerHTML = `<div class="missing">Missing. ${esc(section?.reason ?? "not collected")}</div>`;
    return;
  }
  const rocks = (detail.queue ?? []).filter((r) => r.state === "active");
  const courses = new Map((report.detail?.rockCourse ?? []).map((c) => [c.id, c]));
  const tasks = [...(report.detail?.clickup?.tasks ?? []), ...(report.detail?.backlog?.items ?? []).map((t) => ({ ...t, fromBacklog: true }))]
    .filter((t) => !t.archived);
  // tickets per rock and per tactic
  const onRock = new Map();
  const onTactic = new Map();
  for (const t of tasks) {
    const place = placeTicketOnRock(rocks, t);
    if (!place) continue;
    const key = place.tacticId ? `${place.rockId}:${place.tacticId}` : place.rockId;
    const map = place.tacticId ? onTactic : onRock;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }
  const allIds = rocks.map((r) => r.id);
  const allFolded = allIds.length && allIds.every((id) => rmap.collapsed.has(id));

  const ticketList = (list, title, rock) => {
    const open = list.filter((t) => t.bucket !== "done");
    const done = list.length - open.length;
    return `<div class="glass rm-tickets">
        <p class="rm-tickets-head">${esc(title)} <span class="meta">${esc(plural(open.length, "open ticket", "open tickets"))}${done ? ` · ${esc(done)} done` : ""}</span>${rock ? `<a class="meta rm-edit" href="#rocks/${encodeURIComponent(rock.id)}">Edit rock →</a>` : ""}</p>
        ${list.length
          ? `<ul class="plain">${[...list].sort((a, b) => (a.bucket === "done") - (b.bucket === "done")).map((t) => `<li class="${t.bucket === "done" ? "rm-done" : ""}">
              <span class="mt-status st-${esc(stageOf(t).id)}">${esc(t.status ?? "")}</span>
              ${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.name)}</a>` : esc(t.name)}
              <span class="meta">${esc((t.assignees ?? []).map((u) => String(u.username ?? "").split(/\s+/)[0]).join(", ") || "nobody")}${t.fromBacklog ? " · backlog" : ""}${t.dueDate && t.bucket !== "done" ? ` · ${esc(dueText(t))}` : ""}</span>
            </li>`).join("")}</ul>`
          : `<p class="meta">No tickets carry this in ClickUp yet. Set the ticket's ROCK or TACTIC to it.</p>`}
      </div>`;
  };

  // One column per rock: the rock's circle on top, its tactics hanging below on a branch.
  const column = (rock) => {
    const course = courses.get(rock.id)?.course ?? "on";
    const tactics = rock.tactics ?? [];
    const folded = rmap.collapsed.has(rock.id);
    const owner = ownerName(rock.owner);
    const rockTickets = onRock.get(rock.id) ?? [];
    const tacticNode = (t) => {
      const key = `${rock.id}:${t.id}`;
      const tickets = onTactic.get(key) ?? [];
      const openN = tickets.filter((x) => x.bucket !== "done").length;
      const tone = TACTIC_TONE[t.status] ?? "on";
      const tOwner = ownerName(t.owner);
      return `<button type="button" class="rb-tactic tone-${tone}${rmap.tactic === key ? " picked" : ""}" data-rm-tactic="${esc(key)}" title="${esc(t.title)} · ${esc(tOwner ?? "No owner")} · ${esc(TACTIC_WORD[t.status] ?? t.status ?? "")}${openN ? ` · ${esc(plural(openN, "open ticket", "open tickets"))}` : ""}">
          <span class="rb-tnode">${esc(tOwner ? initials(tOwner) : "–")}${openN ? `<span class="rb-count">${openN}</span>` : ""}</span>
          <span class="rb-tlabel"><span class="rb-ttitle">${esc(t.title)}</span><span class="rb-tmeta">${esc(tOwner ? tOwner.split(/\s+/)[0] : "No owner")}${tone !== "on" ? ` · <span class="rb-tstatus tone-${tone}">${esc(TACTIC_WORD[t.status] ?? t.status ?? "")}</span>` : ""}</span></span>
        </button>`;
    };
    return `<div class="rb-col course-${esc(course)}${folded ? " folded" : ""}">
        <button type="button" class="rb-rock" data-rm-rock="${esc(rock.id)}" aria-expanded="${!folded}" title="${esc(rock.title)}: click to ${folded ? "show" : "fold"} its tactics">
          <span class="rb-hub"><span class="rb-title">${esc(rock.title)}</span></span>
          <span class="rb-owner"><span class="rm-av">${esc(initials(owner))}</span>${esc(owner ? owner.split(/\s+/)[0] : "No owner")}</span>
          <span class="rm-course course-${esc(course)}">${esc(COURSE_WORD[course] ?? course)}</span>
        </button>
        ${folded
          ? `<button type="button" class="rb-more" data-rm-rock="${esc(rock.id)}">+${tactics.length} ${tactics.length === 1 ? "tactic" : "tactics"}</button>`
          : tactics.length ? `<div class="rb-tactics">${tactics.map(tacticNode).join("")}</div>` : `<p class="rb-none">No tactics yet</p>`}
        ${rockTickets.length && !folded ? `<button type="button" class="rb-rocklink${rmap.rockTickets === rock.id ? " on" : ""}" data-rm-rocktickets="${esc(rock.id)}">${esc(plural(rockTickets.length, "ticket", "tickets"))} on the rock</button>` : ""}
      </div>`;
  };

  // The tickets for whatever is picked, under the board.
  let detailHtml = "";
  if (rmap.tactic) {
    const [rid, tid] = rmap.tactic.split(":");
    const rock = rocks.find((r) => r.id === rid);
    const t = rock?.tactics?.find((x) => x.id === tid);
    if (t && !rmap.collapsed.has(rid)) detailHtml = ticketList(onTactic.get(rmap.tactic) ?? [], `${t.title} · ${rock.title}`, rock);
  } else if (rmap.rockTickets) {
    const rock = rocks.find((r) => r.id === rmap.rockTickets);
    if (rock) detailHtml = ticketList(onRock.get(rock.id) ?? [], `${rock.title}, no tactic`, rock);
  }

  host.innerHTML = `
    <div class="rm-bar">
      <span class="meta">${esc(plural(rocks.length, "active rock", "active rocks"))} · ${esc(plural(rocks.reduce((n, r) => n + (r.tactics ?? []).length, 0), "tactic", "tactics"))}. Click a tactic for its tickets; click a rock to fold it.</span>
      <button type="button" class="ghost sm" data-rm-all="${allFolded ? "open" : "fold"}">${allFolded ? "Show all tactics" : "Fold all"}</button>
    </div>
    <div class="glass rb-board" style="--cols:${rocks.length}">${rocks.map(column).join("")}</div>
    ${detailHtml}`;
}

$("layer1")?.addEventListener("click", (event) => {
  const all = event.target.closest("[data-rm-all]");
  const rock = event.target.closest("[data-rm-rock]");
  const tactic = event.target.closest("[data-rm-tactic]");
  const rockT = event.target.closest("[data-rm-rocktickets]");
  if (all) {
    const ids = (state.report?.detail?.leadership?.queue ?? []).filter((r) => r.state === "active").map((r) => r.id);
    rmap.collapsed = all.dataset.rmAll === "fold" ? new Set(ids) : new Set();
    rmap.tactic = null;
  } else if (rock) {
    const id = rock.dataset.rmRock;
    rmap.collapsed.has(id) ? rmap.collapsed.delete(id) : rmap.collapsed.add(id);
    if (rmap.tactic?.startsWith(`${id}:`)) rmap.tactic = null;
  } else if (tactic) {
    rmap.tactic = rmap.tactic === tactic.dataset.rmTactic ? null : tactic.dataset.rmTactic;
    rmap.rockTickets = null;
  } else if (rockT) {
    rmap.rockTickets = rmap.rockTickets === rockT.dataset.rmRocktickets ? null : rockT.dataset.rmRocktickets;
    rmap.tactic = null;
  } else return;
  if (state.report) renderLayer1(state.report);
});


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
 * Who a backlog ticket is queued for: its primary assignee, the first one listed. Other
 * assignees are collaborators, so they do not count as having the work queued.
 */
function primaryAssignee(task) {
  return toPeople(task.assignees).slice(0, 1);
}

/** One backlog ticket as a list line: Ready chip, link, its primary assignee. */
function backlogLine(t) {
  const who = primaryAssignee(t).map((p) => p.name).join(", ");
  return `<li>${t.ready ? '<span class="chip good">Ready</span> ' : ""}${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.name)}</a>` : esc(t.name)} <span class="meta">${esc(who || "nobody assigned")}</span></li>`;
}

/* ---------------------------------- backlog ----------------------------------
   Its own tab, apart from the sprint: the pre-planning check on the Ready pool, then
   every open backlog ticket under the rock it reaches through its Big Swing, Ready first.
   Tickets on no rock are grouped by their Big Swing so the missing link is plain. */

function renderBacklog() {
  const box = $("backlog-view");
  if (!box || !state.report) return;
  const info = state.report.detail?.backlog;
  if (!info?.available) {
    box.innerHTML = `<div class="note"><strong>Backlog not loaded.</strong> ${esc(info?.reason ?? "")}</div>`;
    return;
  }
  const open = info.items.filter((t) => t.bucket !== "done");
  const byRock = new Map();
  const offRock = new Map();
  for (const t of open) {
    const rock = rockForTask(t);
    const [map, key, title] = rock ? [byRock, rock.id, rock.title] : [offRock, t.bigSwing?.label ?? "No Big Swing", t.bigSwing?.label ?? "No Big Swing"];
    if (!map.has(key)) map.set(key, { title, rockId: rock?.id ?? null, tasks: [] });
    map.get(key).tasks.push(t);
  }
  const readyFirst = (list) => [...list].sort((a, b) => Number(b.ready) - Number(a.ready));
  const group = (g) => {
    const ready = g.tasks.filter((t) => t.ready).length;
    return `<section class="rk-month-group">
      <div class="sp-group-head"><h3>${esc(g.title)}</h3><span class="meta">${esc(plural(g.tasks.length, "ticket", "tickets"))}${ready ? `, ${esc(ready)} Ready` : ""}</span>
        ${g.rockId ? `<span class="grow"></span><a class="meta" href="#rocks/${encodeURIComponent(g.rockId)}">Rock →</a>` : ""}</div>
      <ul class="plain">${readyFirst(g.tasks).map(backlogLine).join("")}</ul>
    </section>`;
  };
  const sortGroups = (map) => [...map.values()].sort((a, b) => b.tasks.filter((t) => t.ready).length - a.tasks.filter((t) => t.ready).length || b.tasks.length - a.tasks.length);
  const off = sortGroups(offRock);
  box.innerHTML = `
    ${state.rocks ? "" : `<p class="sub">Loading the rocks to place each ticket…</p>`}
    <details class="section" open><summary><h2>By rock</h2><span class="sec-count">${esc(open.length - off.reduce((n, g) => n + g.tasks.length, 0))}</span></summary>
      ${sortGroups(byRock).map(group).join("") || `<p class="sub">No open backlog ticket reaches a rock yet.</p>`}
    </details>
    ${off.length
      ? `<details class="section"><summary><h2>On no rock</h2><span class="sec-count">${esc(off.reduce((n, g) => n + g.tasks.length, 0))}</span></summary>
          <p class="sub">Open backlog tickets whose Big Swing no rock claims, or that have none. Either they belong under a rock, or they are BAU.</p>
          ${off.map(group).join("")}
        </details>`
      : ""}
    ${coverageHtml(open)}`;
}

// The backlog's urgent and high tickets are what Alex queues for the following week's
// sprint, so coverage is read from those, by ClickUp priority.
const QUEUED_PRIORITIES = ["urgent", "high"];

/**
 * Next sprint coverage: does each person, and each active rock, have at least one urgent
 * or high ticket queued. A zero is information for planning, not a fault, so it is
 * shown plainly rather than flagged.
 */
function coverageHtml(open) {
  const queued = open
    .filter((t) => QUEUED_PRIORITIES.includes(String(t.priority ?? "").toLowerCase()))
    .sort((a, b) => QUEUED_PRIORITIES.indexOf(a.priority) - QUEUED_PRIORITIES.indexOf(b.priority));
  const line = (t, { showRock = true, showWho = true } = {}) => {
    const rock = rockForTask(t);
    const who = primaryAssignee(t).map((p) => p.name).join(", ");
    const bits = [showRock ? rock?.title ?? t.bigSwing?.label ?? "no Big Swing" : null, showWho ? who || "nobody assigned" : null].filter(Boolean);
    return `<li><span class="chip${t.priority === "urgent" ? " bad" : " warn"}">${esc(t.priority)}</span> ${
      t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.name)}</a>` : esc(t.name)
    }${bits.length ? ` <span class="meta">${esc(bits.join(" · "))}</span>` : ""}</li>`;
  };
  const cell = (list, opts) => (list.length ? `<ul class="plain">${list.map((t) => line(t, opts)).join("")}</ul>` : `<span class="meta">none queued</span>`);

  // People: everyone on the roster, then anyone else a queued ticket names.
  const people = new Map(
    (state.people ?? []).filter((p) => p.clickupUserId && p.countsTowardCapacity !== false).map((p) => [String(p.clickupUserId), { name: p.name, tasks: [] }]),
  );
  for (const t of queued) {
    for (const p of primaryAssignee(t)) {
      if (!people.has(p.id)) people.set(p.id, { name: p.name, tasks: [] });
      people.get(p.id).tasks.push(t);
    }
  }
  const personRows = [...people.values()]
    .map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.tasks.length)}</td><td class="wrap">${cell(p.tasks, { showWho: false })}</td></tr>`)
    .join("");

  const rocks = (state.rocks?.rocks ?? []).filter((r) => r.state === "active");
  const rockRows = rocks
    .map((r) => {
      const list = queued.filter((t) => rockForTask(t)?.id === r.id);
      return `<tr><td><a href="#rocks/${encodeURIComponent(r.id)}">${esc(r.title)}</a></td><td>${esc(list.length)}</td><td class="wrap">${cell(list, { showRock: false })}</td></tr>`;
    })
    .join("");
  const onNoRock = queued.filter((t) => !rockForTask(t));
  const emptyPeople = [...people.values()].filter((p) => !p.tasks.length).length;
  const emptyRocks = rocks.filter((r) => !queued.some((t) => rockForTask(t)?.id === r.id)).length;

  return `<details class="section" open><summary><h2>Next sprint coverage</h2><span class="sec-count">${esc(queued.length)}</span></summary>
    <p class="sub">The backlog's urgent and high priority tickets, the work queued for next sprint, laid out by person and by rock. ${esc(
      plural(emptyPeople, "person has", "people have"),
    )} nothing queued and ${esc(plural(emptyRocks, "rock has", "rocks have"))} nothing queued. That can be fine; it is here to plan against.</p>
    <h3>By person</h3>
    <div class="scroll"><table><thead><tr><th>Person</th><th>Queued</th><th>Urgent and high tickets</th></tr></thead><tbody>${personRows}</tbody></table></div>
    <h3>By rock</h3>
    ${state.rocks
      ? `<div class="scroll"><table><thead><tr><th>Rock</th><th>Queued</th><th>Urgent and high tickets</th></tr></thead><tbody>${rockRows}${
          onNoRock.length ? `<tr><td class="meta">On no rock</td><td>${esc(onNoRock.length)}</td><td class="wrap">${cell(onNoRock)}</td></tr>` : ""
        }</tbody></table></div>`
      : `<p class="sub">Loading the rocks…</p>`}
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
  const rocks = (state.rocks?.rocks ?? []).filter((r) => r.state !== "shipped" || swingIdsOf(r).length);
  // A TACTIC naming one of a rock's open tactics links the ticket too (linkByName, server side).
  const tacticId = task?.leadershipPriority?.optionId;
  const byTactic = tacticId != null ? rocks.find((r) => (r.clickupTacticOptionIds ?? []).map(String).includes(String(tacticId))) ?? null : null;
  if (!swing?.optionId && !swing?.label) return byTactic;
  return (
    rocks.find((r) => ownsSwing(r, swing.optionId)) ??
    rocks.find((r) => swing.label && String(r.title).trim().toLowerCase() === String(swing.label).trim().toLowerCase()) ??
    byTactic
  );
}

// A ticket belongs to its assignees: who it is followed up with and who gets the kudos.
// Ownership above the ticket is the rocks'. (The Project Owner field was retired 2026-11-17.)
const toPeople = (list) => (list ?? []).map((u) => ({ id: String(u.id), name: u.username ?? String(u.id) }));
const doersOf = (task) => toPeople(task.assignees);
/** Who a ticket belongs to: its assignees. Same rule as the cross layer. */
const accountable = (task) => doersOf(task);
const firstName = (p) => String(p.name).split(/\s+/)[0];
const isMe = (p) => state.me != null && p.id === String(state.me);
const nameList = (list) => list.map(firstName).join(", ");

/** Whose turn it is on a ticket: its assignees. */
const doing = (task) => doersOf(task);

/**
 * Who Alex should reach out to about a ticket, and why. In order: someone the ticket is
 * waiting on by name; someone who asked Alex a question in the last comment; the owner,
 * whose job it is to keep it moving; and, when Alex owns it or nobody does, whoever is
 * doing the work.
 */
function reachOut(task) {
  const marked = (state.report?.flags ?? []).find(
    (f) => viewOf(f) === "waiting" && baseId(f.subject?.id) === String(task.id) && triageOf(f)?.waitingOn,
  );
  if (marked) return { verb: "Ask", who: triageOf(marked).waitingOn, why: "you marked it waiting on them" };

  const first = (name) => String(name ?? "someone").split(/\s+/)[0];
  const c = task.lastComment;
  if (c && task.bucket !== "done") {
    const mentions = (c.mentions ?? []).filter((m) => String(m.id) !== String(c.userId));
    if (mentions.some((m) => isMe({ id: String(m.id) }))) return { verb: "Reply to", who: first(c.user), why: `asked you ${agoText(c.date)}`, tone: "warn" };
    const others = mentions.filter((m) => !isMe({ id: String(m.id) }));
    if (others.length) {
      const asker = isMe({ id: String(c.userId) }) ? "you asked" : `${first(c.user)} asked`;
      return { verb: "Ask", who: others.map((m) => first(m.username)).join(", "), why: `${asker} ${agoText(c.date)}` };
    }
  }

  const doers = doersOf(task).filter((p) => !isMe(p));
  if (doers.length) return { verb: "Ask", who: nameList(doers), why: "", isOwner: true };
  if (doersOf(task).length) return { verb: "On you", who: "", why: "" };
  return { verb: "Nobody to ask", who: "", why: "nobody assigned", tone: "bad" };
}

/** "Robson, Cristobal on it". Empty when the Ask line already names them. */
function rolesText(task, ask = null) {
  const doers = doersOf(task);
  if (ask?.isOwner) return "";
  return doers.length ? `${nameList(doers)} on it` : "nobody assigned";
}

function stageOf(task) {
  return STAGE_BY_STATUS.get(String(task.status ?? "").toLowerCase()) ?? { id: "work", label: task.status ?? "Unknown status" };
}

/** What a ticket is waiting on, and why we think so. */
function waitingOn(task) {
  // Marked on the ticket as fine where it is ("[Waiting for Test Slot]"): not chased.
  if (task.parked) return { text: `Parked: ${task.parked}`, why: "marked on the ticket", tone: "" };
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
    const who = nameList(doing(task));
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
function ticketRow(task, { lane = false } = {}) {
  const wait = waitingOn(task);
  const stage = stageOf(task);
  // In a lane the column already says the status, unless the lane holds several.
  const showStatus = !lane || stage.id === "review" || !STAGE_BY_STATUS.has(String(task.status ?? "").toLowerCase());
  // "Waiting to start" under a To do column says nothing; only a question put to someone does.
  const quietStart = lane && stage.id === "start" && wait.text === stage.label;
  // "With Cristobal" says nothing the who line has not; only a stall or a wait does.
  const ask = task.bucket === "done" ? null : reachOut(task);
  const quietWork = stage.id === "work" && !wait.tone && wait.text.startsWith("With ");
  // A wait read off a comment or marked by hand is what the Ask line already says. Fold it
  // in, keeping its colour, rather than saying it twice.
  const askCarriesWait = Boolean(ask) && /asked|you marked it/.test(wait.why ?? "");
  if (askCarriesWait && wait.tone && (!ask.tone || wait.tone === "bad")) ask.tone = wait.tone;
  const rock = rockForTask(task);
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
      <div class="sp-line sp-sub sp-who">
        ${ask ? `<span class="sp-ask${ask.tone ? ` sp-wait-${ask.tone}` : ""}">${esc([ask.verb, ask.who].filter(Boolean).join(" "))}</span>${ask.why ? `<span class="meta">${esc(ask.why)}</span>` : ""}` : ""}
        <span class="meta">${esc(rolesText(task, ask))}</span>
      </div>
      ${quietStart || quietWork || askCarriesWait ? "" : `<div class="sp-line sp-sub">
        <span class="sp-wait${wait.tone ? ` sp-wait-${wait.tone}` : ""}">${esc(wait.text)}</span>
        <span class="meta">${esc(wait.why ?? "")}</span>
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
  const doneThisWeek = doneThisSprint(tasks);

  // One line, read left to right from what needs a question to what is fine. A count
  // that needs attention is coloured only when it is above zero; the rest stay quiet.
  const count = (fn) => open.filter(fn).length;
  const stat = (n, k, tone = "") => `<span class="sp-stat${n && tone ? ` ${tone}` : ""}${n ? "" : " zero"}"><strong>${esc(n)}</strong> ${esc(k)}</span>`;
  const tiles = [
    stat(count((t) => t.signal === "stalled" || stageOf(t).id === "blocked"), "stalled or blocked", "bad"),
    stat(count((t) => stageOf(t).id === "review"), "waiting on QA", "warn"),
    stat(count((t) => stageOf(t).id === "deploy"), "waiting on deploy", "warn"),
    stat(count((t) => stageOf(t).id === "work" && t.signal !== "stalled"), "being worked"),
    stat(count((t) => stageOf(t).id === "start"), "not started"),
    stat(doneThisWeek.length, "done this week", "good"),
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
      // By person: the assignees.
      const who = doing(t);
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
          ${inLane.map((t) => ticketRow(t, { lane: true })).join("")}
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
        ${sprintGroup !== "stage" ? laneHtml(g.tasks) : g.tasks.map((t) => ticketRow(t)).join("")}
      </section>`;
    })
    .join("");

  $("layer2").innerHTML = `
    <p class="sp-stats">${tiles}</p>
    <details class="section ns" id="sec-next" open>
      <summary><h2>Next steps</h2><span class="sec-count" id="next-steps-count"></span></summary>
      <div id="next-steps"></div>
    </details>
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
      ${doneThisWeek.length ? doneThisWeek.map((t) => ticketRow(t)).join("") : `<p class="sub">Nothing in done (this sprint) yet.</p>`}
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
  renderNextSteps();
}

/* -------------------------------- next steps --------------------------------
   Every ticket check that ends in something Alex does, filed under the action: reply,
   nudge, decide, fix. The nextstep.* flags say their own action; the older ticket flags
   are filed here by rule. A stalled or stuck ticket Alex owns with nobody else assigned is
   a reply, not a nudge: nobody else will move it. Same cards and buttons as the readout. */

// In the order to work them: what only Alex can unblock, then the sprint calls, then
// asking others, then ticket hygiene. `show` is how many are listed before "more", and a
// group with show 0 starts folded.
const NEXT_ACTIONS = [
  { id: "reply", label: "Reply", sub: "Waiting on you. Start here.", show: 5 },
  { id: "decide", label: "Decide", sub: "A call on the sprint.", show: 3 },
  { id: "nudge", label: "Nudge", sub: "Ask whoever is doing it.", show: 3 },
  { id: "fix", label: "Fix the ticket", sub: "Missing fields. Tidy when there is time.", show: 0 },
];
const RULE_ACTION = {
  "clickup.stalled": "nudge",
  "clickup.stale_in_status": "nudge",
  "clickup.no_big_swing_set": "fix",
};

function nextActionOf(flag) {
  const own = flag.values?.action ?? RULE_ACTION[flag.rule];
  if (!own) return null;
  if (own === "nudge" && subjectOf(flag).type === "task") {
    const task = state.flagCtx?.tasks.get(baseId(subjectOf(flag).id));
    // Alex's own ticket is a reply only when nobody else is assigned; otherwise the nudge
    // goes to the assignee, as the drafted nudge does.
    if (task && doersOf(task).some(isMe) && !doersOf(task).some((p) => !isMe(p))) return "reply";
  }
  return own;
}

/* Next steps on the Sprint page: the same compact rows as Your queue, grouped by what to
   do (reply, decide, nudge, fix), with tabs to show one kind. A row opens to the full card. */
const ns = { action: "", open: new Set(), all: new Set() };
const NS_ROWS = 6;

function renderNextSteps() {
  const root = $("next-steps");
  if (!root) return;
  const all = (state.report?.flags ?? []).filter((f) => nextActionOf(f));
  const open = all.filter((f) => viewOf(f) === "open");
  const handled = all.length - open.length;
  const sev = { p1: 0, attention: 1, prompt: 2, info: 3 };

  const groups = NEXT_ACTIONS.map((a) => {
    const sorted = open.filter((f) => nextActionOf(f) === a.id).sort((x, y) => (sev[x.severity] ?? 9) - (sev[y.severity] ?? 9));
    // One row per ticket per action: "stalled" and "stuck in its status" are often the
    // same ticket and the same nudge. The others ride along as a count.
    const seen = new Map();
    const list = [];
    for (const f of sorted) {
      const sub = subjectOf(f);
      const k = sub.type === "task" ? `task:${baseId(sub.id)}` : f.key ?? f.id;
      if (seen.has(k)) seen.get(k).also += 1;
      else {
        const entry = { flag: f, also: 0 };
        seen.set(k, entry);
        list.push(entry);
      }
    }
    return { a, list };
  }).filter((g) => g.list.length);
  const total = groups.reduce((n, g) => n + g.list.length, 0);
  $("next-steps-count").textContent = total ? `${total} open` : "nothing open";
  if (ns.action && !groups.some((g) => g.a.id === ns.action)) ns.action = "";

  if (!total) {
    root.innerHTML = `<div class="glass ns-glass"><p class="sub">Nothing to do on the sprint right now.${handled ? ` ${esc(plural(handled, "handled item is", "handled items are"))} under Handled in Your queue (Today).` : ""}</p></div>`;
    return;
  }
  const tabs = `<div class="q-kinds ns-tabs" role="group" aria-label="Show">
      <button type="button" class="q-kind all${ns.action ? "" : " on"}" data-ns-action="">All <span>${esc(total)}</span></button>
      ${groups.map((g) => `<button type="button" class="q-kind ns-${g.a.id}${ns.action === g.a.id ? " on" : ""}" data-ns-action="${g.a.id}">${esc(g.a.label)} <span>${esc(g.list.length)}</span></button>`).join("")}
    </div>`;
  const close = (id) => `<button type="button" class="link-btn" data-ns-open="${esc(id)}">Close</button>`;
  const row = ({ flag, also }) =>
    ns.open.has(flag.id)
      ? `<div class="q-opened">${flagCard(flag, { also })}${close(flag.id)}</div>`
      : queueRow(flag, { also }).replace(`data-q-open="${esc(flag.id)}"`, `data-ns-open="${esc(flag.id)}"`);
  const sections = groups
    .filter((g) => !ns.action || g.a.id === ns.action)
    .map((g) => {
      const full = ns.action === g.a.id || ns.all.has(g.a.id);
      const list = full ? g.list : g.list.slice(0, NS_ROWS);
      const more = g.list.length - NS_ROWS;
      return `<section class="ns-group ns-${g.a.id}">
        <div class="ns-head"><span class="ns-pill">${esc(g.a.label)}</span><span class="ns-n">${esc(g.list.length)}</span><span class="ns-sub">${esc(g.a.sub)}</span></div>
        <div class="q-list">${list.map(row).join("")}</div>
        ${more > 0 && ns.action !== g.a.id ? `<button type="button" class="link-btn q-all" data-ns-all="${g.a.id}">${full ? "Show fewer" : `Show all ${g.list.length}`}</button>` : ""}
      </section>`;
    })
    .join("");
  root.innerHTML = `<div class="glass ns-glass">${tabs}${sections}${handled ? `<p class="meta ns-handled">${esc(plural(handled, "handled item is", "handled items are"))} under Handled in Your queue (Today).</p>` : ""}</div>`;
}

document.addEventListener("click", (event) => {
  if (!event.target.closest("#next-steps")) return;
  const tab = event.target.closest("[data-ns-action]");
  const open = event.target.closest("[data-ns-open]");
  const all = event.target.closest("[data-ns-all]");
  if (tab) ns.action = tab.dataset.nsAction;
  else if (open) {
    const id = open.dataset.nsOpen;
    ns.open.has(id) ? ns.open.delete(id) : ns.open.add(id);
  } else if (all) {
    const id = all.dataset.nsAll;
    ns.all.has(id) ? ns.all.delete(id) : ns.all.add(id);
  } else return;
  renderNextSteps();
});

// One action menu open at a time; a click anywhere else closes it.
document.addEventListener("click", (event) => {
  const inside = event.target.closest("details.act-menu");
  for (const menu of document.querySelectorAll("details.act-menu[open]")) if (menu !== inside) menu.removeAttribute("open");
});

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

/* ------------------------------- write-ups -------------------------------
   Pasteable lists, built in update-text.js from the tickets the report already holds;
   this only draws them and copies them. */

/** The @name for a ClickUp user: their handle from the roster, else their first name. */
function handleFor(user) {
  const person = (state.people ?? []).find((p) => p.clickupUserId && String(p.clickupUserId) === String(user.id));
  return person?.handle || String(person?.name ?? user.username ?? user.id).split(/\s+/)[0];
}

function renderUpdate(report) {
  renderWins("thisweek", report);
  renderWins("lastweek", report);
  if (standup.data) renderUpsu();
}

/* ---------------------------- this / last week's wins ----------------------------
   The same write-up twice: this week's from tickets done this sprint, last week's from
   last sprint's closed status. By rock, then kudos by person; untick, then copy. */

const winsViews = {
  thisweek: { title: "This week's wins", build: buildThisWeekWins, excluded: new Set(), wins: null, empty: 'No tickets are in "done (this sprint)" right now.' },
  lastweek: { title: "Last week's wins", build: buildLastWeekWins, excluded: new Set(), wins: null, empty: 'No tickets are in last sprint\'s closed status ("dont use", formerly "complete") right now.' },
};

function renderWins(kind, report) {
  const v = winsViews[kind];
  const root = $(kind);
  if (!root) return;
  const section = report.sections.clickup;
  if (!section?.present) {
    root.innerHTML = `<div class="missing">Missing. ${esc(section?.reason ?? "not collected")}</div>`;
    return;
  }
  const wins = (v.wins = v.build(report.detail?.clickup?.tasks ?? [], { handleFor }));
  if (!wins.count) {
    root.innerHTML = `<p class="sub">${esc(v.empty)}</p>`;
    return;
  }
  const day = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const text = lastWeekText(wins, v.excluded, { title: v.title });
  const item = (t) => `<label class="up-item">
      <input type="checkbox" data-wins-kind="${kind}" data-wins-task="${esc(t.id)}"${v.excluded.has(String(t.id)) ? "" : " checked"}>
      <span>${esc(t.plainName ?? t.name)}</span>
      ${t.url ? `<a class="meta" href="${esc(t.url)}" target="_blank" rel="noreferrer">open</a>` : ""}
    </label>`;
  root.innerHTML = `
    <p class="meta">${esc(plural(wins.count, "ticket", "tickets"))} done ${wins.from ? `${esc(day(wins.from))} to ${esc(day(wins.to))}` : ""} · ${esc(plural(wins.rocks.length, "rock", "rocks"))} · ${esc(plural(wins.kudos.length, "person", "people"))}. From ClickUp as pulled ${esc(new Date(report.generatedAt).toLocaleString())}.</p>
    <div class="bar up-bar"><button type="button" data-wins-copy="${kind}">Copy all</button><span class="meta" data-wins-note="${kind}"></span></div>
    <textarea class="up-text" data-wins-text="${kind}" rows="${Math.min(20, text.split("\n").length + 1)}" readonly>${esc(text)}</textarea>
    <h3 class="lw-head">By rock</h3>
    ${wins.rocks
      .map(
        (r) => `<section class="up-group">
        <div class="sp-group-head"><h3>${esc(r.label)}</h3></div>
        ${r.tasks.map(item).join("")}
      </section>`,
      )
      .join("")}
    <h3 class="lw-head">Kudos</h3>
    <div class="lw-kudos">${wins.kudos
      .map(
        (p) => `<div class="lw-person">
        <div class="lw-person-head"><strong>🙌 ${esc(p.who)}</strong>${p.rocks.length ? `<span class="meta">${esc(p.rocks.join(", "))}</span>` : ""}</div>
        <ul class="plain">${p.tasks.map((t) => `<li>${esc(t.plainName ?? t.name)}</li>`).join("")}</ul>
      </div>`,
      )
      .join("")}</div>`;
}

document.addEventListener("change", (event) => {
  const kind = event.target.dataset?.winsKind;
  const v = winsViews[kind];
  if (!v?.wins) return;
  const id = event.target.dataset.winsTask;
  if (event.target.checked) v.excluded.delete(id);
  else v.excluded.add(id);
  document.querySelector(`[data-wins-text="${kind}"]`).value = lastWeekText(v.wins, v.excluded, { title: v.title });
});
document.addEventListener("click", async (event) => {
  const kind = event.target.dataset?.winsCopy;
  if (!kind) return;
  const note = document.querySelector(`[data-wins-note="${kind}"]`);
  try {
    await navigator.clipboard.writeText(document.querySelector(`[data-wins-text="${kind}"]`).value);
    note.textContent = "Copied.";
  } catch {
    note.textContent = "The browser would not copy. Select the text and copy it by hand.";
  }
});

/** Where the changelog was read from, or why it was not. */
function changelogNote(changelog) {
  if (!changelog) return "";
  if (changelog.error) return `<p class="meta">Changes to production: not read. ${esc(changelog.error)}</p>`;
  const link = changelog.sheet?.url ? `<a href="${esc(changelog.sheet.url)}" target="_blank" rel="noreferrer">${esc(changelog.sheet.tab ?? "changelog")}</a>` : "the changelog sheet";
  return `<p class="meta">Changes to production from ${link}, read ${esc(new Date(changelog.takenAt).toLocaleString())}${changelog.latest ? `; latest row ${esc(changelog.latest)}` : ""}.</p>`;
}

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
  // Only the day over day windows. The same button style is used for other toggles
  // (sprint grouping, the update mode), and those must not change the window.
  const button = event.target.closest(".dod-window[data-window]");
  if (!button) return;
  dodWindow = button.dataset.window;
  try { localStorage.setItem("mos.dodWindow", dodWindow); } catch { /* per-viewer nicety only */ }
  document.querySelectorAll(".dod-window[data-window]").forEach((b) => {
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
  for (const [list, what] of [[ch.assigneeChanges, "assignee"], [ch.ownerChanges ?? [], "owner"], [ch.priorityChanges, "priority"]]) {
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

/* Tests live in the Ecom Roadmap's AB Testing view (Resources). The test notes are still
   read here, because a flag about a test names its owner from them. */
const AB_TESTING = "https://ecom-fd-roadmap.netlify.app/?view=tests";

async function loadTestNotes() {
  const res = await fetch(`${FN}/test-notes`).then((r) => r.json()).catch(() => null);
  if (res) state.testNotes = res;
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
    // Nothing to create, import or file by queue when the rocks are read from Supabase.
    for (const id of ["new-rock-btn", "import-rocks-btn", "rock-state-filter"]) $(id)?.classList.toggle("hidden", fromSupabase());
    $("rocks-sub").textContent = fromSupabase()
      ? "Each rock, the tactics under it, and the sprint and backlog tickets that reach them through ClickUp: a ROCK value with the rock's name, or a TACTIC value with a tactic's name."
      : $("rocks-sub").dataset.storeText;
    renderRocks();
    // The flags' quick fixes and the sprint's rock links are drawn from the rocks, so
    // they wait for them.
    if (state.report) {
      renderAllFlags();
      renderLayer2(state.report);
      renderBacklog();
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

/* ------------------------- ClickUp names vs the standup -------------------------
   ROCK and TACTIC in ClickUp should carry the standup's rock and tactic names, 1:1.
   Tickets link by those names (src/collectors/clickup-names.js), so this lists what
   lines up and what to rename, as a checklist to work through in ClickUp. */

function namesChecklist(data) {
  const n = data.names;
  if (!n) return "";
  const lines = [];
  for (const r of (data.rocks ?? []).filter((r) => !r.bau)) {
    lines.push(`${r.rockMatch ? "✓" : "✗"} ROCK "${r.title}"${r.rockMatch ? (r.rockMatch.match === "exact" ? "" : ` (close: "${r.rockMatch.label}", rename to match)`) : " – no ROCK value names it"}`);
    for (const t of (r.tactics ?? []).filter((t) => t.status !== "done")) {
      lines.push(`    ${t.tacticMatch ? "✓" : "✗"} TACTIC "${t.title}"${t.tacticMatch ? (t.tacticMatch.match === "exact" ? "" : ` (close: "${t.tacticMatch.label}", rename to match)`) : " – no TACTIC value names it"}`);
    }
  }
  if (n.staleRockOptions.length) lines.push("", "Old ROCK values (name no rock): rename or remove", ...n.staleRockOptions.map((o) => `    ${o.label}`));
  if (n.staleTacticOptions.length) lines.push("", "Old TACTIC values (name no open tactic): rename or remove", ...n.staleTacticOptions.map((o) => `    ${o.label}`));
  return lines.join("\n");
}

function renderNames(data) {
  const host = $("rocks-names");
  if (!host) return;
  const n = data.names;
  if (!n) {
    host.innerHTML = "";
    return;
  }
  const rocks = (data.rocks ?? []).filter((r) => !r.bau);
  const tactics = rocks.flatMap((r) => (r.tactics ?? []).filter((t) => t.status !== "done"));
  const rocksOk = rocks.filter((r) => r.rockMatch?.match === "exact").length;
  const tacticsOk = tactics.filter((t) => t.tacticMatch?.match === "exact").length;
  const todo = rocks.length - rocksOk + tactics.length - tacticsOk + n.staleRockOptions.length + n.staleTacticOptions.length;
  const mark = (m) => (m ? (m.match === "exact" ? `<span class="nm-ok">✓</span>` : `<span class="nm-close">≈</span>`) : `<span class="nm-bad">✗</span>`);
  const said = (m, kind) => (m ? (m.match === "exact" ? "" : ` <span class="meta">close: "${esc(m.label)}", rename to match</span>`) : ` <span class="meta">no ${kind} value names it</span>`);
  host.innerHTML = `<details class="nm-box"${todo ? " open" : ""}>
    <summary><strong>ClickUp ROCK and TACTIC vs the standup</strong> <span class="meta">${rocksOk} of ${rocks.length} rocks and ${tacticsOk} of ${tactics.length} open tactics match exactly${todo ? ` · ${todo} to fix in ClickUp` : ""}</span></summary>
    <p class="sub">Tickets reach a rock through a ROCK value with the rock's name, or a TACTIC value with one of its tactic's names. Rename the values in ClickUp to match these exactly; this updates on the next load.</p>
    <div class="bar"><button type="button" class="ghost sm" id="nm-copy">Copy as a checklist</button><span class="meta" id="nm-note"></span></div>
    <ul class="nm-list">${rocks
      .map(
        (r) => `<li>${mark(r.rockMatch)} <strong>${esc(r.title)}</strong> <span class="meta">ROCK</span>${said(r.rockMatch, "ROCK")}
          <ul>${(r.tactics ?? []).filter((t) => t.status !== "done").map((t) => `<li>${mark(t.tacticMatch)} ${esc(t.title)} <span class="meta">TACTIC</span>${said(t.tacticMatch, "TACTIC")}</li>`).join("")}</ul></li>`,
      )
      .join("")}</ul>
    ${n.staleRockOptions.length ? `<p class="nm-head">Old ROCK values in ClickUp <span class="meta">name no rock: rename or remove</span></p><p class="nm-chips">${n.staleRockOptions.map((o) => `<span class="chip">${esc(o.label)}</span>`).join(" ")}</p>` : ""}
    ${n.staleTacticOptions.length ? `<p class="nm-head">Old TACTIC values in ClickUp <span class="meta">name no open tactic: rename or remove</span></p><p class="nm-chips">${n.staleTacticOptions.map((o) => `<span class="chip">${esc(o.label)}</span>`).join(" ")}</p>` : ""}
  </details>`;
}

document.addEventListener("click", async (event) => {
  if (event.target.id !== "nm-copy" || !state.rocks) return;
  try {
    await navigator.clipboard.writeText(namesChecklist(state.rocks));
    $("nm-note").textContent = "Copied.";
  } catch {
    $("nm-note").textContent = "The browser would not copy.";
  }
});

function renderRocks() {
  const data = state.rocks;
  if (!data) return;
  renderNames(data);
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
                ? `<a href="${AB_TESTING}" target="_blank" rel="noreferrer" title="Open AB Testing in the Ecom Roadmap">${label} ↗</a>`
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

  const sb = fromSupabase() ? supabaseRocksHtml(rocks, { ticketsFor, peopleById, swingById }) : null;

  $("rocks-list").innerHTML = `
    ${data.clickupOptions?.available === false ? `<div class="note"><strong>ClickUp link unavailable.</strong> ${esc(data.clickupOptions.reason ?? "")}</div>` : ""}
    ${backlogInfo && !backlogInfo.available ? `<div class="note"><strong>Backlog not loaded.</strong> ${esc(backlogInfo.reason ?? "")} Rocks show their sprint tickets only.</div>` : ""}
    ${sb ?? (groups
      .map(
        (g) => `<section class="rk-month-group">
          <div class="sp-group-head"><h3>${esc(g.title)}</h3><span class="meta">${esc(plural(g.rocks.length, "rock", "rocks"))}${g.current ? " · this month" : ""}${
            g.late ? ' · <span class="bad">past its month</span>' : ""
          }${g.unset ? " · set a target month on each to plan it" : ""}</span></div>
          ${g.rocks.map(item).join("")}
        </section>`,
      )
      .join("") || `<p class="sub">${(data.rocks ?? []).length ? "No rocks match that filter." : "No rocks yet. Use New rock to add the first."}</p>`)}
    ${!sb && shipped.length ? `<details class="section"><summary><h2>Shipped</h2><span class="sec-count">${esc(shipped.length)}</span></summary>${shipped.map(item).join("")}</details>` : ""}
    <p class="sub">${rocks.length} of ${(data.rocks ?? []).length} shown · version ${esc(data.version)}${data.updatedAt ? ` · last changed ${new Date(data.updatedAt).toLocaleString()}` : ""}</p>`;
}

const SB_COLOR = { green: ["on_track", "On Track"], amber: ["at_risk", "At Risk"], red: ["off_track", "Off Track"] };
const TACTIC_STATUS = { on_track: ["on_track", "On Track"], at_risk: ["at_risk", "At Risk"], overdue: ["off_track", "Check-in overdue"], done: ["done", "Done"] };

/** Whether the owner and Big Swing pickers are showing on the Rocks tab. Off by default. */
let editingLinks = false;

/**
 * The Supabase rocks, read top down: each rock, the tactics under it, and under each
 * tactic the tickets that reach it through its Big Swing. Read only by default; "Edit
 * links" swaps the owner and Big Swing text on each row for pickers.
 */
function supabaseRocksHtml(rocks, { ticketsFor, peopleById, swingById }) {
  const data = state.rocks;
  const meta = data.supabase ?? {};
  const thisMonth = todayKey().slice(0, 7);
  const people = data.people ?? [];
  const swings = data.bigSwingOptions?.options ?? [];
  const first = (id) => String(peopleById.get(id) ?? "").split(/\s+/)[0] || null;
  const monthName = (m) => new Date(`${m}-01T12:00:00`).toLocaleDateString(undefined, { month: "long" });
  const shortDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  const picker = (id, field, current, list, blank) =>
    `<select class="sm" data-link-id="${esc(id)}" data-link-field="${esc(field)}" aria-label="${esc(blank)}">
      <option value="">${esc(blank)}</option>
      ${current && !list.some((o) => String(o.id) === String(current)) ? `<option value="${esc(current)}" selected>⚠ no longer in ClickUp</option>` : ""}
      ${list.map((o) => `<option value="${esc(o.id)}"${String(o.id) === String(current ?? "") ? " selected" : ""}>${esc(o.label ?? o.name)}</option>`).join("")}
    </select>`;

  // One ticket, on one line: name, status, who.
  const ticket = (t, where) => {
    const who = accountable(t).map(firstName).join(", ");
    return `<li>${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.name)}</a>` : esc(t.name)}
      <span class="meta">${esc(where === "backlog" ? (t.ready ? "backlog · Ready" : "backlog") : t.status ?? "")}${who ? ` · ${esc(who)}` : ""}</span></li>`;
  };
  const ticketList = (list) =>
    list.length ? `<ul class="plain sb-tickets">${list.map(({ t, where }) => ticket(t, where)).join("")}</ul>` : "";

  const tacticRow = (t, tickets) => {
    const [tone, label] = TACTIC_STATUS[t.status] ?? ["", t.status ?? ""];
    // Without the live options (ClickUp unreachable) a link is still a link; only with them
    // can it be told to be gone.
    const gone = data.bigSwingOptions?.available ? "a Big Swing no longer in ClickUp" : "linked";
    const swing = t.clickupBigSwingOptionId ? swingById.get(String(t.clickupBigSwingOptionId)) ?? gone : null;
    const links = editingLinks
      ? `<span class="sb-edit">${picker(t.id, "owner", t.owner, people, "Owner")}${picker(t.id, "clickupBigSwingOptionId", t.clickupBigSwingOptionId, swings, "Big Swing")}</span>`
      : `<span class="meta">${esc(first(t.owner) ?? "no owner")} · ${
          swing ? `Big Swing: ${esc(swing)}` : '<span class="bad">no Big Swing, so no tickets reach it</span>'
        }</span>`;
    return `<li class="sb-tactic">
      <div class="sb-tactic-head">
        <span class="sig ${esc(tone)}">${esc(label)}</span>
        <strong class="sb-tactic-title">${esc(t.title)}</strong>
        <span class="meta sb-count">${esc(swing ? plural(tickets.length, "ticket", "tickets") : "")}${t.checkInDate ? `${swing ? " · " : ""}check-in ${esc(shortDate(t.checkInDate))}` : ""}</span>
      </div>
      <div class="sb-tactic-sub">${links}</div>
      ${ticketList(tickets)}
    </li>`;
  };

  const card = (r) => {
    const [tone, label] = SB_COLOR[r.statusColor] ?? ["", "No status yet"];
    const open = (r.tactics ?? []).filter((t) => t.status !== "done");
    const done = (r.tactics ?? []).filter((t) => t.status === "done");
    const all = ticketsFor(r);
    const tagged = [...all.sprint.map((t) => ({ t, where: "sprint" })), ...all.backlog.map((t) => ({ t, where: "backlog" }))];
    const forSwing = (id) => (id ? tagged.filter(({ t }) => String(t.bigSwing?.optionId ?? "") === String(id)) : []);
    const claimed = new Set(open.map((t) => String(t.clickupBigSwingOptionId ?? "")).filter(Boolean));
    const onRock = tagged.filter(({ t }) => !claimed.has(String(t.bigSwing?.optionId ?? "")));

    // This month's milestones, as one line: how many are done, and what is blocked.
    const month = (r.milestones ?? []).filter((m) => m.month === thisMonth);
    const late = (r.milestones ?? []).filter((m) => m.month < thisMonth && !m.done);
    const blocked = month.filter((m) => m.blocker && !m.done);
    const msLine = month.length || late.length
      ? `<details class="sb-ms"><summary class="meta">${esc(monthName(thisMonth))} milestones: ${esc(month.filter((m) => m.done).length)} of ${esc(month.length)} done${
          late.length ? ` · <span class="bad">${esc(late.length)} from earlier not done</span>` : ""
        }${blocked.length ? ` · <span class="bad">${esc(blocked.length)} blocked</span>` : ""}</summary>
        <ul class="plain">${[...late, ...month]
          .map((m) => `<li class="${m.done ? "sb-done" : ""}">${m.done ? "✓" : "○"} ${esc(m.deliverable ?? "")}${m.month < thisMonth ? ` <span class="meta">(${esc(monthName(m.month))})</span>` : ""}${m.blocker ? ` <span class="chip warn">blocked: ${esc(m.blocker)}</span>` : ""}</li>`)
          .join("")}</ul></details>`
      : "";

    const ownerText = r.bau ? "business as usual" : first(r.owner) ? `owner ${first(r.owner)}` : '<span class="bad">no owner</span>';
    return `<section class="sb-rock" id="rock-${esc(r.id)}">
      <div class="sb-rock-head">
        <span class="sig ${esc(tone)}">${esc(label)}</span>
        <h3>${esc(r.title)}</h3>
        <button type="button" class="ghost sm" data-open="${esc(r.id)}">Details</button>
      </div>
      <p class="meta sb-rock-meta">${ownerText}${r.checkInDate ? ` · checked in ${esc(shortDate(r.checkInDate))}` : ""}${
        r.kpi ? ` · <span title="${esc(r.kpi)}">done when: ${esc(r.kpi.length > 90 ? `${r.kpi.slice(0, 90)}…` : r.kpi)}</span>` : ""
      }</p>
      ${r.statusReason || r.actionPlan ? `<p class="meta sb-rock-meta">${r.statusReason ? `Why: ${esc(r.statusReason)}` : ""}${r.statusReason && r.actionPlan ? " · " : ""}${r.actionPlan ? `Plan: ${esc(r.actionPlan)}` : ""}</p>` : ""}
      ${msLine}
      ${open.length ? `<ul class="plain sb-tactics">${open.map((t) => tacticRow(t, forSwing(t.clickupBigSwingOptionId))).join("")}</ul>` : '<p class="meta sb-rock-meta">No open tactics under this rock.</p>'}
      ${onRock.length ? `<div class="sb-onrock"><p class="meta">On the rock directly (${esc(onRock.length)})</p>${ticketList(onRock)}</div>` : ""}
      ${done.length ? `<p class="meta sb-rock-meta">Done tactics: ${esc(done.map((x) => x.title).join(", "))}</p>` : ""}
    </section>`;
  };

  const ordered = [...rocks.filter((r) => !r.bau), ...rocks.filter((r) => r.bau)];
  return `
    <div class="sb-bar">
      <span class="meta">${esc(meta.team ?? "")} rocks, ${esc(meta.quarter ?? "")}, from Supabase${meta.takenAt ? ` · read ${esc(new Date(meta.takenAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}` : ""}. Edit rocks and tactics in the standup app.</span>
      <button type="button" class="${editingLinks ? "" : "ghost "}sm" data-toggle-links>${editingLinks ? "Done editing" : "Edit links"}</button>
    </div>
    ${editingLinks ? '<p class="meta">Set who owns each tactic and the ClickUp Big Swing its tickets use. Each change saves as you pick it.</p>' : ""}
    ${meta.stale ? `<div class="missing">Supabase could not be read (${esc(meta.stale.reason)}). Showing the copy from ${esc(new Date(meta.stale.takenAt).toLocaleString())}.</div>` : ""}
    ${swingLinksHtml(rocks, swings)}
    ${ordered.map(card).join("") || '<p class="sub">No rocks for this team and quarter in Supabase.</p>'}`;
}

/* ------------------------- Big Swings to link -------------------------
   A ClickUp Big Swing with tickets on it that no rock or tactic claims leaves those
   tickets on nothing. Each is paired with the open tactic, still without a Big Swing,
   whose title shares the most words with it ("1-Step Quiz Buy Box Funnel" and "New
   Problem Based Bundle Buy Box"), one swing per tactic, best pairs first. Nothing is
   linked until Link is pressed. A swing with no likely tactic gets a picker instead. */

const SWING_STOP = new Set(["a", "an", "and", "the", "to", "of", "on", "in", "for", "with", "new", "based", "out", "via"]);
// Numbers alone ("2.0", "90") say little about what a swing is, and paired "Bundles / Upsells 2.0" with any other 2.0.
const swingWords = (s) => new Set(String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !SWING_STOP.has(w) && !/^\d+$/.test(w)));

/** Sprint and backlog tickets per Big Swing option id, open ones only. */
function swingTicketCounts() {
  const counts = new Map();
  const d = state.report?.detail ?? {};
  for (const t of [...(d.clickup?.tasks ?? []), ...(d.backlog?.items ?? [])]) {
    const id = t.bigSwing?.optionId;
    if (!id || t.closed || t.bucket === "done") continue;
    counts.set(String(id), (counts.get(String(id)) ?? 0) + 1);
  }
  return counts;
}

function swingSuggestions(rocks, swings) {
  const counts = swingTicketCounts();
  const loose = swings.filter((o) => counts.get(String(o.id)) && !rocks.some((r) => ownsSwing(r, o.id)));
  const open = rocks.flatMap((r) => (r.tactics ?? []).filter((t) => t.status !== "done" && !t.clickupBigSwingOptionId).map((t) => ({ t, r })));
  const pairs = [];
  for (const o of loose) {
    const sw = swingWords(o.label);
    for (const x of open) {
      const shared = [...swingWords(x.t.title)].filter((w) => sw.has(w)).length;
      if (shared >= 2) pairs.push({ ...x, swing: o, shared });
    }
  }
  pairs.sort((a, b) => b.shared - a.shared);
  const usedSwing = new Set();
  const usedTactic = new Set();
  const suggested = [];
  for (const p of pairs) {
    if (usedSwing.has(p.swing.id) || usedTactic.has(p.t.id)) continue;
    usedSwing.add(p.swing.id);
    usedTactic.add(p.t.id);
    suggested.push(p);
  }
  return { counts, suggested, unplaced: loose.filter((o) => !usedSwing.has(o.id)) };
}

function swingLinksHtml(rocks, swings) {
  if (!swings.length) return "";
  const { counts, suggested, unplaced } = swingSuggestions(rocks, swings);
  if (!suggested.length && !unplaced.length) return "";
  const n = (id) => plural(counts.get(String(id)) ?? 0, "ticket", "tickets");
  const swingName = (id) => swings.find((o) => String(o.id) === String(id))?.label ?? null;
  const targets = rocks.flatMap((r) => [
    ...(r.tactics ?? []).filter((t) => t.status !== "done").map((t) => ({ id: t.id, label: `${r.title} › ${t.title}`, has: t.clickupBigSwingOptionId })),
    { id: r.id, label: `${r.title} (the rock itself)`, has: r.ownBigSwingOptionId },
  ]);
  const place = (o, prompt = "Put it on…") => `<select class="sm" data-place-swing="${esc(o.id)}" aria-label="Put ${esc(o.label)} on">
      <option value="">${esc(prompt)}</option>
      ${targets.map((x) => `<option value="${esc(x.id)}">${esc(x.label)}${x.has ? ` (replaces ${esc(swingName(x.has) ?? "its Big Swing")})` : ""}</option>`).join("")}
    </select>`;
  return `<div class="note sb-link-swings">
    <p><strong>${esc(plural(suggested.length + unplaced.length, "Big Swing has", "Big Swings have"))} tickets but no tactic</strong>, so those tickets reach no rock.${
      suggested.length > 1 ? ` <button type="button" class="sm" data-link-all>Link all ${esc(suggested.length)} suggested</button>` : ""
    }</p>
    <ul class="plain">
      ${suggested
        .map(
          (p) => `<li><strong>${esc(p.swing.label)}</strong> <span class="meta">${esc(n(p.swing.id))}</span> → ${esc(p.t.title)} <span class="meta">under ${esc(p.r.title)}</span>
          <button type="button" class="sm" data-link-swing="${esc(p.swing.id)}" data-link-to="${esc(p.t.id)}">Link</button> ${place(p.swing, "or put it elsewhere…")}</li>`,
        )
        .join("")}
      ${unplaced.map((o) => `<li><strong>${esc(o.label)}</strong> <span class="meta">${esc(n(o.id))} · no tactic with a matching name</span> ${place(o)}</li>`).join("")}
    </ul>
  </div>`;
}

async function linkSwings(list, control) {
  if (control) control.disabled = true;
  try {
    for (const { to, swing } of list) await saveLinks(to, { clickupBigSwingOptionId: swing });
  } catch (err) {
    rocksError(`Not linked: ${err.message}`);
    if (control) control.disabled = false;
  }
}

$("rocks-list").addEventListener("click", (event) => {
  const one = event.target.closest("[data-link-swing]");
  if (one) return linkSwings([{ to: one.dataset.linkTo, swing: one.dataset.linkSwing }], one);
  const all = event.target.closest("[data-link-all]");
  if (!all) return;
  const list = [...document.querySelectorAll("#rocks-list [data-link-swing]")].map((b) => ({ to: b.dataset.linkTo, swing: b.dataset.linkSwing }));
  linkSwings(list, all);
});

$("rocks-list").addEventListener("change", (event) => {
  const select = event.target.closest("[data-place-swing]");
  if (!select?.value) return;
  linkSwings([{ to: select.value, swing: select.dataset.placeSwing }], select);
});

$("rocks-list").addEventListener("click", (event) => {
  if (!event.target.closest("[data-toggle-links]")) return;
  editingLinks = !editingLinks;
  renderRocks();
});

/** An owner or Big Swing picked on a tactic or rock row saves straight away. */
$("rocks-list").addEventListener("change", async (event) => {
  const input = event.target.closest("[data-link-id]");
  if (!input) return;
  input.disabled = true;
  try {
    await saveLinks(input.dataset.linkId, { [input.dataset.linkField]: input.value || null });
  } catch (err) {
    rocksError(`Not saved: ${err.message}`);
    input.disabled = false;
  }
});

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

/* -------------------------------- my stand-up --------------------------------
   Alex's own Yesterday / Today / Blockers. Drafted by /mystandup (one Claude call) from
   facts gathered by code; each line lists the facts it came from, so it can be checked
   before it is pasted. The text box is Alex's to edit; Copy takes what is in it. */

const mine = { latest: null, status: null, loaded: false, polling: null, error: null, edited: null };
const FACT_KIND = { plan: "Your last stand-up", clickup: "ClickUp", slack: "Slack", note: "Your notes", waiting: "Waiting on", reply: "Replies owed", week: "Quarter plan", focus: "Today's rock moves" };

async function loadMine() {
  const res = await fetch(`${FN}/mystandup`).then((r) => r.json()).catch(() => null);
  mine.loaded = true;
  if (res) {
    mine.latest = res.latest;
    mine.status = res.status;
  }
  renderMine();
  if (mine.status?.running) pollMine();
}

function pollMine() {
  if (mine.polling) return;
  mine.polling = setInterval(async () => {
    const res = await fetch(`${FN}/mystandup`).then((r) => r.json()).catch(() => null);
    if (!res) return;
    const changed = res.latest?.generatedAt !== mine.latest?.generatedAt;
    mine.latest = res.latest;
    mine.status = res.status;
    if (changed) mine.edited = null;
    if (!res.status?.running) {
      clearInterval(mine.polling);
      mine.polling = null;
    }
    renderMine();
  }, 3000);
}

function renderMine() {
  const host = $("mystandup");
  const d = mine.latest;
  const running = mine.status?.running;
  const failed = mine.status?.state === "failed" && !running ? mine.status.error : null;
  const today = state.today ?? todayKey();
  const stale = d && d.dateKey !== today;
  const byId = new Map((d?.facts ?? []).map((f) => [f.id, f]));
  const factLi = (f) => `<li><span class="meta">${esc(FACT_KIND[f.kind] ?? f.kind)}</span> ${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noreferrer">${esc(f.text)} ↗</a>` : esc(f.text)}</li>`;
  const line = (k, label) => {
    const l = d[k];
    const cited = l.sources.map((id) => byId.get(id)).filter(Boolean);
    const unsupported = (d.unsupported ?? []).includes(k);
    return `<details class="ms-why"><summary><strong>${esc(label)}</strong> <span class="meta">${unsupported ? '<span class="bad">nothing cited; check this line before posting</span>' : `from ${esc(plural(cited.length, "fact", "facts"))}`}</span></summary>
      <ul class="plain">${cited.map(factLi).join("") || '<li class="meta">No source.</li>'}</ul></details>`;
  };
  const unused = d ? d.facts.filter((f) => !["yesterday", "today", "blockers"].some((k) => d[k].sources.includes(f.id))) : [];
  const read = d?.read ?? {};

  host.innerHTML = `
    <div class="ms-bar">
      <button type="button" data-mine="write"${running ? " disabled" : ""}>${running ? "Writing…" : d ? "Write a new one" : "Write it"}</button>
      ${d ? `<span class="meta">${d.trigger === "morning" ? "Written after the 8 AM readout" : "Written"} ${esc(new Date(d.generatedAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }))}${stale ? ' · <span class="bad">this is from an earlier day</span>' : ""}</span>` : ""}
    </div>
    ${failed ? `<div class="missing">Not written: ${esc(failed)}</div>` : ""}
    ${mine.error ? `<div class="missing">${esc(mine.error)}</div>` : ""}
    ${(d?.notes ?? []).map((n) => `<div class="note">${esc(n)}</div>`).join("")}
    ${d
      ? `<div class="ms-draft">
          <textarea id="ms-text" rows="4" spellcheck="true">${esc(mine.edited ?? d.text)}</textarea>
          <div class="ms-acts"><button type="button" class="sm" data-mine="copy">Copy</button>${mine.edited != null ? '<button type="button" class="ghost sm" data-mine="reset">Back to the draft</button>' : ""}<span class="meta" id="ms-copied"></span></div>
        </div>
        ${d.posted ? `<p class="meta">You already posted today: ${esc(`Yesterday: ${d.posted.yesterday ?? ""} · Today: ${d.posted.today ?? ""} · Blockers: ${d.posted.blockers ?? ""}`)}</p>` : ""}
        <h3>Where each line came from</h3>
        ${line("yesterday", "Yesterday")}${line("today", "Today")}${line("blockers", "Blockers")}
        ${unused.length ? `<details class="ms-why"><summary class="meta">${esc(plural(unused.length, "other fact was", "other facts were"))} read and not used</summary><ul class="plain">${unused.map(factLi).join("")}</ul></details>` : ""}
        <p class="meta">Read: ClickUp from the ${esc(read.readoutDate ?? "latest")} readout · Slack ${read.slack === "no token" ? "not connected" : `${esc(read.slack)} of your messages`} · ${esc(plural(read.notes ?? 0, "note", "notes"))} · ${esc(read.waiting ?? 0)} waiting on someone · your stand-ups ${read.standups ? "read" : "not read"}</p>`
      : running
        ? '<p class="sub">Reading your ClickUp, Slack and notes, then drafting. About half a minute.</p>'
        : '<p class="sub">No draft yet. One is written after each 8 AM readout, or press Write it.</p>'}`;
}

$("mystandup").addEventListener("input", (event) => {
  if (event.target.id === "ms-text") mine.edited = event.target.value;
});

$("mystandup").addEventListener("click", async (event) => {
  const b = event.target.closest("[data-mine]");
  if (!b) return;
  const act = b.dataset.mine;
  if (act === "copy") {
    try {
      await navigator.clipboard.writeText($("ms-text").value);
      $("ms-copied").textContent = "Copied. Paste it in #ecomm-team.";
    } catch {
      $("ms-copied").textContent = "The browser would not copy. Select the text and copy it by hand.";
    }
    return;
  }
  if (act === "reset") {
    mine.edited = null;
    return renderMine();
  }
  if (act === "write") {
    if (mine.edited != null && !confirm("Write a new one? Your edits to this one will be replaced.")) return;
    mine.error = null;
    b.disabled = true;
    const res = await fetch(`${FN}/mystandup`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) mine.error = `Could not start: ${body.reason ?? body.error ?? `HTTP ${res.status}`}`;
    mine.status = { state: "running", running: true, startedAt: body.startedAt };
    renderMine();
    pollMine();
  }
});

/* ------------------------------- quarter plan -------------------------------
   The quarter as months and weeks. Each rock, a line for its milestones, and a row per
   tactic (plus one for tickets on the rock itself); in each week, the work planned for it
   and the tickets that were done or are due then. Planned items are this app's: added
   with +, ticked off, removed. Rocks and tickets are as of the latest readout. */

const plan = { data: null, loading: false, adding: null, focus: null };
const QP_NAME_W = 250;
const QP_WEEK_W = 128;
const QP_UN_W = 90;
const COURSE_CHIP = { off: ["off_track", "Off course"], drift: ["at_risk", "Drifting"], on: ["on_track", "On course"] };
const SB_WORD = { green: "On Track", amber: "At Risk", red: "Off Track" };

async function loadPlan() {
  if (plan.loading) return;
  plan.loading = true;
  try {
    const res = await fetch(`${FN}/plan`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    plan.data = body;
    planError(null);
    renderPlan();
  } catch (err) {
    planError(`Could not load the plan: ${err.message}`);
  } finally {
    plan.loading = false;
  }
}

function planError(message) {
  $("plan-error").classList.toggle("hidden", !message);
  $("plan-error").textContent = message ?? "";
}

async function planChange(change) {
  const d = plan.data;
  const res = await fetch(`${FN}/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quarter: d.quarter, version: d.plan.version, change }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 409) await loadPlan();
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  plan.data = body;
  renderPlan();
}

function renderPlan() {
  const d = plan.data;
  if (!d) return;
  const thisWeek = qWeekStartOf(d.today);
  const thisMonth = d.today.slice(0, 7);
  $("plan-asof").textContent = d.readoutAt
    ? `Rocks and tickets as of ${new Date(d.readoutAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`
    : "No readout yet";

  /* ---- course: the rocks that need a decision, every reason listed ---- */
  const courseOf = new Map((d.course ?? []).map((c) => [c.id, c]));
  const trouble = (d.course ?? []).filter((c) => c.course !== "on").sort((a, b) => (a.course === "off" ? 0 : 1) - (b.course === "off" ? 0 : 1));
  const fine = (d.course ?? []).filter((c) => c.course === "on");
  const signalLi = (s) => `<li class="qp-sig ${esc(s.level)}"><span>${esc(s.text)}.</span> <span class="meta">Fix: ${esc(s.fix)}.</span></li>`;
  $("plan-course").innerHTML = `
    <div class="qp-course">
      ${trouble
        .map((c) => {
          const [tone, label] = COURSE_CHIP[c.course];
          const reasons = c.signals.filter((s) => s.level !== "gap");
          const gaps = c.signals.filter((s) => s.level === "gap");
          return `<div class="qp-course-rock ${esc(c.course)}">
            <div class="qp-course-head"><span class="sig ${esc(tone)}">${esc(label)}</span>
              <a href="#plan/${esc(c.id)}" data-plan-jump="${esc(c.id)}"><strong>${esc(c.title)}</strong></a>
              <span class="meta">${esc(c.owner ? firstName({ name: c.owner }) : "no owner")}${c.statusColor ? ` · standup says ${esc(SB_WORD[c.statusColor] ?? c.statusColor)}` : ""}</span></div>
            <ul class="plain">${reasons.map(signalLi).join("") || '<li class="meta">Its owner marked it At Risk in the standup.</li>'}</ul>
            ${gaps.length ? `<details><summary class="meta">${esc(plural(gaps.length, "thing", "things"))} the check cannot see</summary><ul class="plain">${gaps.map(signalLi).join("")}</ul></details>` : ""}
          </div>`;
        })
        .join("")}
      ${fine.length ? `<p class="meta qp-fine"><span class="sig on_track">On course</span> ${fine.map((c) => `<a href="#plan/${esc(c.id)}" data-plan-jump="${esc(c.id)}">${esc(c.title)}</a>`).join(" · ")}</p>` : ""}
      ${!(d.course ?? []).length ? '<p class="sub">No live rocks on the latest readout.</p>' : ""}
    </div>`;

  /* ---- the grid ---- */
  const weeks = d.weeks;
  const span = (m) => weeks.filter((w) => w.month === m).length;
  const head = `<thead>
      <tr><th class="qp-name" rowspan="2">${esc(d.quarter.replace("-", " "))}</th>${d.months
        .map((m) => `<th class="qp-month${m === thisMonth ? " now" : ""}" colspan="${span(m)}">${esc(qMonthName(m))}</th>`)
        .join("")}<th class="qp-un" rowspan="2" title="Open tickets with no due date">No date</th></tr>
      <tr>${weeks.map((w) => `<th class="qp-week${w.start === thisWeek ? " now" : w.start < thisWeek ? " past" : ""}" title="${esc(qShortDay(w.start))} to ${esc(qShortDay(w.end))}">${esc(qShortDay(w.start))}</th>`).join("")}</tr>
    </thead>`;

  const wkClass = (w) => (w.start === thisWeek ? " now" : w.start < thisWeek ? " past" : "");
  const weekOfKey = (key) => (key ? qWeekStartOf(key) : null);
  const ticketChip = (t) => {
    const done = Boolean(t.doneOn);
    return `<a class="qp-t${done ? " done" : ""}" href="${esc(t.url ?? "#")}" target="_blank" rel="noreferrer" title="${esc(`${t.name}${t.who ? ` · ${t.who}` : ""} · ${done ? `done ${t.doneOn}` : `${t.status ?? "open"}${t.dueOn ? `, due ${t.dueOn}` : ""}`}`)}">${done ? "✓" : "○"} ${esc(t.name)}</a>`;
  };
  const itemChip = (p, past) =>
    `<span class="qp-p${p.done ? " done" : past ? " slipped" : ""}" data-plan-item="${esc(p.id)}">
      <input type="checkbox" data-plan-done${p.done ? " checked" : ""} aria-label="Done">
      <span class="qp-p-text">${esc(p.text)}</span>
      <button type="button" class="qp-x" data-plan-remove title="Remove from the plan" aria-label="Remove">×</button>
    </span>`;

  const cell = (rock, tacticId, w, tickets, items) => {
    const here = (x) => (x.doneOn ? weekOfKey(x.doneOn) : weekOfKey(x.dueOn)) === w.start;
    const ts = tickets.filter(here);
    const ps = items.filter((p) => p.week === w.start);
    const past = w.start < thisWeek;
    const key = `${rock.id}|${tacticId ?? ""}|${w.start}`;
    const adding = plan.adding === key;
    const shown = ts.slice(0, 4);
    return `<td class="qp-cell${wkClass(w)}">
      ${ps.map((p) => itemChip(p, past)).join("")}
      ${shown.map(ticketChip).join("")}${ts.length > shown.length ? `<span class="meta qp-more" title="${esc(ts.slice(4).map((t) => t.name).join("\n"))}">+${ts.length - shown.length} more</span>` : ""}
      ${adding
        ? `<form class="qp-add" data-plan-add="${esc(key)}"><input type="text" maxlength="200" placeholder="What gets done this week" required><button type="submit" class="sm">Add</button></form>`
        : `<button type="button" class="qp-plus" data-plan-open="${esc(key)}" title="Plan work for the week of ${esc(qShortDay(w.start))}" aria-label="Plan work">+</button>`}
    </td>`;
  };

  const rockRows = (rock) => {
    const c = courseOf.get(rock.id);
    const [tone, label] = COURSE_CHIP[c?.course ?? "on"];
    const tickets = (d.tickets ?? []).filter((t) => t.rockId === rock.id);
    const items = (d.plan?.items ?? []).filter((p) => p.rockId === rock.id);
    const ms = rock.milestones ?? [];
    const msDone = ms.filter((m) => m.done).length;
    const elapsed = weeks.filter((w) => w.start <= thisWeek).length / weeks.length;
    const progress = ms.length ? msDone / ms.length : 0;

    // Done per week, planned and tickets together: the shape of progress across the quarter.
    const summaryCells = weeks
      .map((w) => {
        const ps = items.filter((p) => p.week === w.start);
        const doneT = tickets.filter((t) => t.doneOn && weekOfKey(t.doneOn) === w.start).length;
        const bits = [];
        if (ps.length) bits.push(`<span class="${ps.every((p) => p.done) ? "good" : w.start < thisWeek ? "bad" : ""}">${ps.filter((p) => p.done).length}/${ps.length}</span>`);
        if (doneT) bits.push(`<span class="qp-done-n" title="${esc(plural(doneT, "ticket", "tickets"))} done">✓${doneT}</span>`);
        return `<td class="qp-sum${wkClass(w)}">${bits.join(" ")}</td>`;
      })
      .join("");

    const msCells = d.months
      .map((m) => {
        const list = ms.filter((x) => x.month === m);
        return `<td class="qp-ms" colspan="${span(m)}">${list
          .map((x) => `<span class="qp-m${x.done ? " done" : m < thisMonth ? " late" : m === thisMonth ? " now" : ""}" title="${esc(x.deliverable ?? "")}${x.blocker ? `\nBlocked: ${esc(x.blocker)}` : ""}">${x.done ? "✓" : "◇"} ${esc(x.deliverable ?? "")}</span>`)
          .join("") || '<span class="meta">No milestone</span>'}</td>`;
      })
      .join("");

    const unscheduled = (forTactic) => {
      const list = tickets.filter((t) => !t.doneOn && !t.dueOn && forTactic(t));
      return `<td class="qp-un">${list.length ? `<details><summary class="meta">${esc(list.length)}</summary>${list.map(ticketChip).join("")}</details>` : ""}</td>`;
    };

    const tacticRow = (t) => {
      const [ttone, tlabel] = TACTIC_STATUS[t.status] ?? ["", t.status ?? ""];
      const mine = (x) => x.tacticId === t.id;
      return `<tr class="qp-tactic">
        <th class="qp-name"><span class="qp-tactic-title">${esc(t.title)}</span>
          <span class="meta">${tlabel ? `<span class="sig ${esc(ttone)}">${esc(tlabel)}</span> ` : ""}${t.owner ? esc(firstName({ name: t.owner })) : ""}${t.checkInDate ? ` · check-in ${esc(qShortDay(t.checkInDate))}` : ""}</span></th>
        ${weeks.map((w) => cell(rock, t.id, w, tickets.filter(mine), items.filter((p) => p.tacticId === t.id))).join("")}
        ${unscheduled(mine)}
      </tr>`;
    };
    const live = (rock.tactics ?? []).filter((t) => t.status !== "done");
    const direct = (x) => !x.tacticId || !live.some((t) => t.id === x.tacticId);

    return `<tbody class="qp-rock ${esc(c?.course ?? "on")}" id="qp-${esc(rock.id)}">
      <tr class="qp-rock-row">
        <th class="qp-name">
          <span class="sig ${esc(tone)}">${esc(label)}</span> <strong>${esc(rock.title)}</strong>
          <span class="meta">${esc(rock.owner ? firstName({ name: rock.owner }) : "no owner")} · milestones ${esc(msDone)} of ${esc(ms.length)} · planned ${esc(items.filter((p) => p.done).length)} of ${esc(items.length)} done</span>
          <span class="qp-bar" title="${esc(Math.round(elapsed * 100))}% of the quarter gone, ${esc(Math.round(progress * 100))}% of milestones done"><span class="qp-bar-time" style="width:${(elapsed * 100).toFixed(0)}%"></span><span class="qp-bar-done" style="width:${(progress * 100).toFixed(0)}%"></span></span>
        </th>
        ${summaryCells}<td class="qp-un"></td>
      </tr>
      <tr class="qp-ms-row"><th class="qp-name meta">Milestones</th>${msCells}<td class="qp-un"></td></tr>
      ${live.map(tacticRow).join("")}
      <tr class="qp-tactic qp-direct">
        <th class="qp-name"><span class="qp-tactic-title">On the rock itself</span><span class="meta">tickets not tied to one tactic</span></th>
        ${weeks.map((w) => cell(rock, null, w, tickets.filter(direct), items.filter((p) => !p.tacticId || !live.some((t) => t.id === p.tacticId)))).join("")}
        ${unscheduled(direct)}
      </tr>
    </tbody>`;
  };

  // A re-render (adding, ticking) keeps the grid where it was scrolled to.
  const keepLeft = $("plan-grid").querySelector(".qp-scroll")?.scrollLeft ?? null;
  const order = { off: 0, drift: 1, on: 2 };
  const rocks = [...(d.rocks ?? [])].sort((a, b) => order[courseOf.get(a.id)?.course ?? "on"] - order[courseOf.get(b.id)?.course ?? "on"]);
  $("plan-grid").innerHTML = rocks.length
    ? `<p class="meta qp-key"><span class="qp-m now">◇ milestone</span> <span class="qp-p">planned</span> <span class="qp-t done">✓ ticket done</span> <span class="qp-t">○ ticket due</span> · the bar under each rock: quarter gone, with milestones done over it.${d.backfilled ? "" : " Tickets from before today fill in after the next 8 AM readout."}</p>
       <div class="qp-scroll"><table class="qp" style="width:${QP_NAME_W + weeks.length * QP_WEEK_W + QP_UN_W}px"><colgroup><col style="width:${QP_NAME_W}px">${weeks.map(() => `<col style="width:${QP_WEEK_W}px">`).join("")}<col style="width:${QP_UN_W}px"></colgroup>${head}${rocks.map(rockRows).join("")}</table></div>`
    : '<p class="sub">No live rocks on the latest readout.</p>';

  if (plan.focus) {
    const el = $(`qp-${plan.focus}`);
    plan.focus = null;
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    el?.classList.add("qp-flash");
  }
  // Open on this week, with last week still in view.
  const scroller = $("plan-grid").querySelector(".qp-scroll");
  const now = scroller?.querySelector("th.qp-week.now");
  if (scroller && keepLeft != null && plan.scrolled) scroller.scrollLeft = keepLeft;
  else if (scroller && now) {
    const i = weeks.findIndex((w) => w.start === thisWeek);
    scroller.scrollLeft = Math.max(0, (i - 1) * QP_WEEK_W);
    plan.scrolled = true;
  }
  const input = $("plan-grid").querySelector(".qp-add input");
  input?.focus({ preventScroll: true });
}

$("plan-course").addEventListener("click", (event) => {
  const a = event.target.closest("[data-plan-jump]");
  if (!a) return;
  event.preventDefault();
  plan.focus = a.dataset.planJump;
  renderPlan();
});

$("plan-grid").addEventListener("click", async (event) => {
  const open = event.target.closest("[data-plan-open]");
  if (open) {
    plan.adding = open.dataset.planOpen;
    return renderPlan();
  }
  const remove = event.target.closest("[data-plan-remove]");
  if (remove) {
    const id = remove.closest("[data-plan-item]").dataset.planItem;
    remove.disabled = true;
    try {
      await planChange({ remove: id });
    } catch (err) {
      planError(`Not removed: ${err.message}`);
      remove.disabled = false;
    }
  }
});

$("plan-grid").addEventListener("change", async (event) => {
  const box = event.target.closest("[data-plan-done]");
  if (!box) return;
  box.disabled = true;
  try {
    await planChange({ update: { id: box.closest("[data-plan-item]").dataset.planItem, done: box.checked } });
  } catch (err) {
    planError(`Not saved: ${err.message}`);
    box.checked = !box.checked;
    box.disabled = false;
  }
});

$("plan-grid").addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-plan-add]");
  if (!form) return;
  event.preventDefault();
  const [rockId, tacticId, week] = form.dataset.planAdd.split("|");
  const text = form.querySelector("input").value.trim();
  if (!text) return;
  form.querySelector("button").disabled = true;
  try {
    plan.adding = null;
    await planChange({ add: { rockId, tacticId: tacticId || null, week, text } });
  } catch (err) {
    plan.adding = form.dataset.planAdd;
    planError(`Not added: ${err.message}`);
    form.querySelector("button").disabled = false;
  }
});

$("plan-grid").addEventListener("keydown", (event) => {
  if (event.key === "Escape" && event.target.closest(".qp-add")) {
    plan.adding = null;
    renderPlan();
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

  const linkRows = `
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
    }).join("")}`;

  // A Supabase rock: what Supabase says, read only, and the fields this app keeps.
  if (fromSupabase() && r) {
    const [, statusText] = SB_COLOR[r.statusColor] ?? ["", "No status yet"];
    $("rock-modal-title").textContent = "Rock";
    $("rock-delete").classList.add("hidden");
    $("rock-form").innerHTML = `
      <div class="note"><strong>${esc(r.title)}</strong><br>
        ${esc(statusText)}${r.checkInDate ? ` · checked in ${esc(r.checkInDate)}` : ""} · ${esc(r.quarter ?? "")}
        ${r.kpi ? `<br><span class="meta">Done when: ${esc(r.kpi)}</span>` : ""}
        ${r.statusReason ? `<br><span class="meta">Why: ${esc(r.statusReason)}</span>` : ""}
        ${r.actionPlan ? `<br><span class="meta">Plan: ${esc(r.actionPlan)}</span>` : ""}
        <br><span class="meta">${esc(SB_NOTE)}</span></div>
      <div class="form-grid">
        <label>Owner <span class="meta">in ClickUp terms</span><select class="rk" data-f="owner">${opts(people, r.owner, "no owner")}</select></label>
        <label>Big Swing <span class="meta">for tickets on the rock itself</span>${
          swings.available
            ? `<select class="rk" data-f="clickupBigSwingOptionId">${opts(swings.options, r.ownBigSwingOptionId, "not linked")}</select>`
            : `<input class="rk" data-f="clickupBigSwingOptionId" value="" placeholder="option id">`
        }</label>
      </div>
      <p class="meta">Each tactic's own Big Swing and owner are set on its row on the Rocks tab.</p>
      ${linkRows}
      <label class="wide">Notes<textarea class="rk" data-f="notes" rows="3">${esc(r.notes ?? "")}</textarea></label>
      ${renderRockReadout(r.readout)}`;
    $("rock-modal").hidden = false;
    return;
  }

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
    ${linkRows}

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
  if (fromSupabase()) {
    try {
      await saveLinks(editingId, formPayload());
      closeRock();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove("hidden");
    }
    return;
  }
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
/* --------------------------------- stand-up ---------------------------------
   The team's stand-ups from Slack, read live by /standup. One day at a time, blockers
   first, then who has not posted. */

const standup = { data: null, error: null, loading: false, day: null };

async function loadStandup() {
  standup.loading = true;
  renderStandup();
  const res = await fetch(`${FN}/standup`).catch(() => null);
  const body = res ? await res.json().catch(() => null) : null;
  standup.loading = false;
  if (res?.ok && body) {
    standup.data = body;
    standup.error = null;
    if (!standup.day || !body.days.some((d) => d.dateKey === standup.day)) standup.day = body.today;
  } else {
    standup.error = body?.error ?? "Could not reach Slack.";
  }
  renderStandup();
  renderUpsu();
}

/** "Tue Oct 28" for a YYYY-MM-DD key, without a timezone shift. */
function dayLabel(key, today) {
  if (key === today) return "Today";
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

const standupList = (label, list, cls = "") =>
  `<div class="su-sec ${cls}"><span class="su-label">${esc(label)}</span>${
    list.length ? `<ul>${list.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : `<span class="meta">nothing</span>`
  }</div>`;

function renderStandup() {
  const root = $("standup");
  if (!root) return;
  if (standup.loading && !standup.data) {
    root.innerHTML = `<p class="sub">Reading Slack…</p>`;
    return;
  }
  if (standup.error) {
    root.innerHTML = `<div class="missing">${esc(standup.error)}</div><div class="bar up-bar"><button type="button" id="standup-reload">Try again</button></div>`;
    return;
  }
  const data = standup.data;
  if (!data) return;
  const today = data.today;
  // Today always shows, posted to or not; then the days that have posts.
  const days = [today, ...data.days.map((d) => d.dateKey).filter((k) => k !== today)].slice(0, 6);
  const day = data.days.find((d) => d.dateKey === standup.day) ?? { dateKey: standup.day, posts: [] };
  const posted = new Set(day.posts.map((p) => p.name));
  const notPosted = data.expected.filter((n) => !posted.has(n));
  const blocked = day.posts.filter((p) => p.blockers.length);
  const first = (n) => String(n).split(/\s+/)[0];

  root.innerHTML = `
    <div class="bar up-bar">
      <div class="dod-windows" role="group" aria-label="Day">${days
        .map((k) => `<button type="button" class="ghost dod-window${k === standup.day ? " on" : ""}" data-standup-day="${esc(k)}" aria-pressed="${k === standup.day}">${esc(dayLabel(k, today))}</button>`)
        .join("")}</div>
      <button type="button" class="ghost" id="standup-reload">${standup.loading ? "Reading…" : "Reload"}</button>
    </div>
    ${data.namesNote ? `<div class="missing">${esc(data.namesNote)}</div>` : ""}
    <p class="meta">${esc(posted.size)} posted${data.expected.length ? ` of ${esc(data.expected.length)} who usually do` : ""}${
      notPosted.length ? `. Not posted${standup.day === today ? " yet" : ""}: <strong>${esc(notPosted.map(first).join(", "))}</strong>` : ""
    }. Read from Slack ${esc(new Date(data.fetchedAt).toLocaleTimeString())}.</p>
    ${
      blocked.length
        ? `<div class="su-blockers"><strong>Blockers</strong><ul>${blocked
            .map((p) => `<li><strong>${esc(first(p.name))}:</strong> ${esc(p.blockers.join("; "))}</li>`)
            .join("")}</ul></div>`
        : day.posts.length
          ? `<p class="meta">No blockers reported.</p>`
          : ""
    }
    ${
      day.posts.length
        ? `<div class="su-grid">${day.posts
            .map(
              (p) => `<article class="su-card${p.blockers.length ? " su-blocked" : ""}">
              <div class="su-head"><strong>${esc(p.name)}</strong><span class="meta">${esc(new Date(p.postedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}${p.edited ? " · edited" : ""}</span></div>
              ${standupList("Yesterday", p.yesterday)}
              ${standupList("Today", p.today)}
              ${p.blockers.length ? standupList("Blockers", p.blockers, "su-bad") : ""}
            </article>`,
            )
            .join("")}</div>`
        : `<p class="sub">No stand-ups posted ${standup.day === today ? "yet today" : "that day"}.</p>`
    }`;
}

document.addEventListener("click", (event) => {
  const day = event.target.closest("[data-standup-day]")?.dataset.standupDay;
  if (day) {
    standup.day = day;
    renderStandup();
    return;
  }
  if (event.target.closest("#standup-reload")) loadStandup();
});

/* ----------------------------- update + stand-up -----------------------------
   The update with stand-up lines folded in, built in update-text.js from the report's
   tickets and the stand-ups /standup reads live. Shares the Stand-up tab's fetch. */

const upsu = { excluded: new Set(), built: null };
const upsuHandle = (u) => handleFor(u.id ? u : { username: u.username });

function renderUpsu() {
  const root = $("upsu");
  if (!root) return;
  const report = state.report;
  if (!report?.sections?.clickup?.present) {
    root.innerHTML = `<div class="missing">Missing. ${esc(report?.sections?.clickup?.reason ?? "not collected")}</div>`;
    return;
  }
  if (!standup.data) {
    root.innerHTML = standup.error
      ? `<div class="missing">Stand-ups could not be read. ${esc(standup.error)}</div><div class="bar up-bar"><button type="button" id="standup-reload">Try again</button></div>`
      : `<p class="sub">Reading Slack…</p>`;
    return;
  }
  const since = windowStart();
  const tasks = report.detail?.clickup?.tasks ?? [];
  const built = buildStandupUpdate(tasks, standup.data.days, { since, handleFor: upsuHandle });
  built.changes = buildChanges(report.detail?.changelog, { since });
  upsu.built = built;
  const text = upsuText(built);
  const sinceText = new Date(since).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  const posted = built.posts.map((p) => String(p.name).split(/\s+/)[0]);
  const noted = built.groups.reduce((n, g) => n + g.tasks.filter((x) => x.notes.length).length, 0);
  const check = (key) => `<input type="checkbox" data-upsu-key="${esc(key)}"${upsu.excluded.has(key) ? "" : " checked"}>`;

  root.innerHTML = `
    <p class="meta">Since ${esc(sinceText)}. Tickets from ClickUp as pulled ${esc(new Date(report.generatedAt).toLocaleString())}; stand-ups from Slack ${esc(new Date(standup.data.fetchedAt).toLocaleTimeString())} (${
      posted.length ? `${esc(posted.join(", "))}` : "nobody yet"
    }). <button type="button" class="ghost" id="standup-reload">Reload stand-ups</button></p>
    ${standup.data.namesNote ? `<div class="missing">${esc(standup.data.namesNote)}</div>` : ""}
    <div class="bar up-bar"><button type="button" data-copy-upsu>Copy all</button><span class="meta" data-copy-note="upsu">${esc(plural(noted, "ticket has", "tickets have"))} stand-up notes · ${esc(plural(built.extra.length, "other stand-up line", "other stand-up lines"))} · ${esc(plural(built.blockers.length, "blocker", "blockers"))}</span></div>
    <textarea class="up-text" data-upsu-text rows="${Math.min(28, text.split("\n").length + 1)}" readonly>${esc(text)}</textarea>
    ${built.groups
      .map(
        (g) => `<section class="up-group">
        <div class="sp-group-head"><h3>${esc(g.label)}</h3><span class="meta">${esc(plural(g.tasks.length, "ticket", "tickets"))}</span></div>
        ${g.tasks
          .map(
            (x) => `<label class="up-item">
            ${check(String(x.task.id))}
            <span>${esc(x.text)}${x.fromStandup ? ` <span class="chip">from stand-up</span>` : ""}${
              x.notes.length ? `<span class="su-notes">${x.notes.map((n) => `<span>↳ ${esc(n.section)}: ${esc(n.text)}</span>`).join("")}</span>` : ""
            }</span>
            ${x.task.url ? `<a class="meta" href="${esc(x.task.url)}" target="_blank" rel="noreferrer">open</a>` : ""}
          </label>`,
          )
          .join("")}
      </section>`,
      )
      .join("")}
    ${
      built.extra.length
        ? `<section class="up-group"><div class="sp-group-head"><h3>Also from stand-up</h3><span class="meta">matched no ticket</span></div>
        ${built.extra.map((e, i) => `<label class="up-item">${check(`extra:${i}`)}<span>@${esc(upsuHandle({ username: e.who }))} – ${esc(e.section)}: ${esc(e.text)}</span></label>`).join("")}</section>`
        : ""
    }
    ${
      built.blockers.length
        ? `<section class="up-group"><div class="sp-group-head"><h3>Blockers</h3></div>
        ${built.blockers.map((b, i) => `<label class="up-item su-bad">${check(`blocker:${i}`)}<span>@${esc(upsuHandle({ username: b.who }))} – ${esc(b.text)}</span></label>`).join("")}</section>`
        : ""
    }
    ${
      built.changes.length
        ? `<section class="up-group"><div class="sp-group-head"><h3>Changes to production</h3><span class="meta">from the changelog sheet</span></div>
        ${built.changes.map((e) => `<label class="up-item">${check(`change:${e.row}`)}<span>${esc(changeLine(e))}</span>${e.testLink ? `<a class="meta" href="${esc(e.testLink)}" target="_blank" rel="noreferrer">test</a>` : ""}</label>`).join("")}</section>`
        : ""
    }
    ${changelogNote(report.detail?.changelog)}`;
}

/** The Update + Stand-up text, then the production changes. */
function upsuText(built) {
  return [standupUpdateText(built, upsuHandle, upsu.excluded), changesText(built.changes ?? [], upsu.excluded)].filter(Boolean).join("\n\n");
}

document.addEventListener("change", (event) => {
  const key = event.target.dataset?.upsuKey;
  if (!key || !upsu.built) return;
  if (event.target.checked) upsu.excluded.delete(key);
  else upsu.excluded.add(key);
  document.querySelector("[data-upsu-text]").value = upsuText(upsu.built);
});

document.addEventListener("click", async (event) => {
  if (!event.target.closest("[data-copy-upsu]")) return;
  const note = document.querySelector('[data-copy-note="upsu"]');
  try {
    await navigator.clipboard.writeText(document.querySelector("[data-upsu-text]").value);
    note.textContent = "Copied.";
  } catch {
    note.textContent = "The browser would not copy. Select the text and copy it by hand.";
  }
});

/* --------------------------------- ideation ---------------------------------
   Each sprint ticket judged, with the root cause and three other approaches. Worked out
   by one Claude call on the server, only when the button is pressed; this draws the
   stored answer and polls while a new one runs. */

const IDEATION_VERDICTS = [
  { id: "unsuccessful", label: "Unsuccessful", tone: "bad" },
  { id: "successful", label: "Successful", tone: "good" },
  { id: "too_early", label: "Too early to call", tone: "" },
];
const ideation = { latest: null, status: null, loaded: false, polling: null, error: null };

async function loadIdeation() {
  const res = await fetch(`${FN}/ideation`).then((r) => r.json()).catch(() => null);
  ideation.loaded = true;
  if (res) {
    ideation.latest = res.latest;
    ideation.status = res.status;
  }
  renderIdeation();
  if (ideation.status?.running) pollIdeation();
}

function pollIdeation() {
  if (ideation.polling) return;
  ideation.polling = setInterval(async () => {
    const res = await fetch(`${FN}/ideation`).then((r) => r.json()).catch(() => null);
    if (!res) return;
    ideation.latest = res.latest;
    ideation.status = res.status;
    if (!res.status?.running) {
      clearInterval(ideation.polling);
      ideation.polling = null;
    }
    renderIdeation();
  }, 5000);
}

function ideationCard(t) {
  const verdict = IDEATION_VERDICTS.find((v) => v.id === t.verdict);
  const who = t.assignees?.length ? t.assignees : t.owner ?? [];
  return `<article class="ix-card ix-${esc(t.verdict)}">
    <div class="ix-head">
      ${t.url ? `<a class="ix-name" href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.name)}</a>` : `<span class="ix-name">${esc(t.name)}</span>`}
      <span class="chip ${verdict?.tone ?? ""}">${esc(verdict?.label ?? t.verdict)}</span>
      <span class="chip">${esc(t.status)}</span>
    </div>
    <p class="meta">${esc(t.bigSwing ?? "No Big Swing")}${who.length ? ` · ${esc(who.map((n) => String(n).split(/\s+/)[0]).join(", "))}` : ""}</p>
    <p><strong>Why.</strong> ${esc(t.rootCause)}</p>
    ${t.evidence ? `<p class="meta"><strong>Evidence.</strong> ${esc(t.evidence)}</p>` : ""}
    <ol class="ix-ideas">${t.ideas.map((i) => `<li><strong>${esc(i.title)}.</strong> ${esc(i.how)}</li>`).join("")}</ol>
  </article>`;
}

function renderIdeation() {
  const root = $("ideation");
  if (!root) return;
  if (!ideation.loaded) {
    root.innerHTML = `<p class="sub">Loading…</p>`;
    return;
  }
  const { latest, status } = ideation;
  const running = Boolean(status?.running);
  const failed = status?.state === "failed" && !running;
  const tickets = latest?.tickets ?? [];
  const counts = Object.fromEntries(IDEATION_VERDICTS.map((v) => [v.id, tickets.filter((t) => t.verdict === v.id).length]));

  root.innerHTML = `
    <div class="bar up-bar">
      <button type="button" id="ideation-run"${running ? " disabled" : ""}>${running ? "Analyzing…" : latest ? "Run again" : "Analyze the sprint"}</button>
      <span class="meta">${
        running
          ? `Started ${esc(new Date(status.startedAt).toLocaleTimeString())}. Reading every ticket and its comments, then one call to Claude; usually a few minutes.`
          : latest
            ? `Last run ${esc(new Date(latest.generatedAt).toLocaleString())}, on the readout pulled ${esc(latest.dateKey ?? "")}.`
            : "Not run yet."
      }</span>
    </div>
    ${failed ? `<div class="missing">The last run failed. ${esc(status.error ?? "")}</div>` : ""}
    ${ideation.error ? `<div class="missing">${esc(ideation.error)}</div>` : ""}
    ${latest && latest.readStandups === false ? `<p class="meta">Stand-ups could not be read from Slack at the time, so they were left out.</p>` : ""}
    ${latest && latest.readTicketDetail === false ? `<p class="meta">ClickUp could not be read at the time, so this used only the last comment on each ticket.</p>` : ""}
    ${
      tickets.length
        ? `<p class="meta">${IDEATION_VERDICTS.map((v) => `${esc(counts[v.id])} ${esc(v.label.toLowerCase())}`).join(" · ")}</p>
      ${IDEATION_VERDICTS.filter((v) => counts[v.id])
        .map(
          (v) => `<section class="up-group">
          <div class="sp-group-head"><h3>${esc(v.label)}</h3><span class="meta">${esc(plural(counts[v.id], "ticket", "tickets"))}</span></div>
          ${tickets.filter((t) => t.verdict === v.id).map(ideationCard).join("")}
        </section>`,
        )
        .join("")}`
        : ""
    }
    ${latest?.missing?.length ? `<p class="meta">No usable answer came back for: ${esc(latest.missing.map((m) => m.name).join(", "))}. Run again to retry.</p>` : ""}`;
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("#ideation-run");
  if (!button) return;
  button.disabled = true;
  ideation.error = null;
  const res = await fetch(`${FN}/ideation`, { method: "POST" }).catch((err) => ({ ok: false, json: async () => ({ reason: err.message }) }));
  const body = await res.json().catch(() => ({}));
  if (res.ok || res.status === 409) {
    ideation.status = { state: "running", startedAt: body.startedAt ?? body.status?.startedAt ?? new Date().toISOString(), running: true };
    pollIdeation();
  } else {
    ideation.error = `Could not start the analysis. ${body.reason ?? body.error ?? ""}`;
  }
  renderIdeation();
});

/* ------------------------------- daily speech -------------------------------
   The day's storyline for the team: a headline, three beats and a close. Written by one
   Claude call on the server, only when the button is pressed; every figure in it was
   checked against the data, and any it could not find is listed above the speech. */

const speech = { latest: null, status: null, celebrated: {}, loaded: false, polling: null, error: null, notes: [], notesFrom: null, notesError: null, draft: "" };

async function loadDayNotes() {
  const res = await fetch(`${FN}/day-notes`).then((r) => r.json()).catch(() => null);
  if (res?.notes) {
    speech.notes = res.notes;
    speech.notesFrom = res.from;
  }
}

/** The notes box: what came in today, from other teams or anywhere. The next speech reads all of it. */
function notesSection() {
  const { notes, latest } = speech;
  const newer = latest ? notes.filter((n) => n.at > latest.generatedAt).length : 0;
  const from = speech.notesFrom ? new Date(`${speech.notesFrom}T12:00:00`).toLocaleDateString(undefined, { weekday: "long" }) : "the previous working day";
  return `<section class="ds-notes">
    <div class="sp-group-head"><h3>Notes from the day</h3><span class="meta">${esc(plural(notes.length, "note", "notes"))} since ${esc(from)}, all read by the next speech</span></div>
    <textarea id="ds-note-text" rows="3" placeholder="Paste a Slack message, a meeting takeaway, an ask from another team…">${esc(speech.draft)}</textarea>
    <div class="bar"><button type="button" id="ds-note-add">Add note</button>${speech.notesError ? `<span class="meta bad">${esc(speech.notesError)}</span>` : ""}${newer ? `<span class="meta">${esc(plural(newer, "note", "notes"))} added since the speech below was written. Write a new one to use ${newer === 1 ? "it" : "them"}.</span>` : ""}</div>
    ${
      notes.length
        ? `<ul class="ds-note-list">${[...notes]
            .reverse()
            .map(
              (n) => `<li><span class="meta">${esc(new Date(n.at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }))}</span> ${n.source?.via?.startsWith("slack") ? `<span class="meta">· from Slack</span>` : ""}${n.source?.link ? ` <a href="${esc(n.source.link)}" target="_blank" rel="noreferrer">Open</a>` : ""} <button type="button" class="ghost ds-note-del" data-id="${esc(n.id)}" data-date="${esc(n.dateKey)}" aria-label="Remove note">Remove</button><div class="ds-xf-text">${esc(n.text)}</div></li>`,
            )
            .join("")}</ul>`
        : ""
    }
  </section>`;
}

async function loadSpeech() {
  const [res] = await Promise.all([fetch(`${FN}/speech`).then((r) => r.json()).catch(() => null), loadDayNotes()]);
  speech.loaded = true;
  if (res) {
    speech.latest = res.latest;
    speech.status = res.status;
    speech.celebrated = res.celebrated ?? speech.celebrated;
  }
  renderSpeech();
  if (speech.status?.running) pollSpeech();
}

function pollSpeech() {
  if (speech.polling) return;
  speech.polling = setInterval(async () => {
    const res = await fetch(`${FN}/speech`).then((r) => r.json()).catch(() => null);
    if (!res) return;
    speech.latest = res.latest;
    speech.status = res.status;
    speech.celebrated = res.celebrated ?? speech.celebrated;
    if (!res.status?.running) {
      clearInterval(speech.polling);
      speech.polling = null;
    }
    renderSpeech();
  }, 4000);
}

function renderSpeech() {
  const root = $("speech");
  if (!root) return;
  if (!speech.loaded) {
    root.innerHTML = `<p class="sub">Loading…</p>`;
    return;
  }
  const { latest, status } = speech;
  const running = Boolean(status?.running);
  const failed = status?.state === "failed" && !running;
  const stale = latest?.dateKey && state.report?.dateKey && latest.dateKey !== state.report.dateKey;
  const missed = latest ? [!latest.readStandups && "stand-ups", !latest.readImpact && "the Impact record", !latest.readStore && "store numbers", latest.readChangelog === false && "the changelog sheet"].filter(Boolean) : [];

  root.innerHTML = `
    <div class="bar up-bar">
      <button type="button" id="speech-run"${running ? " disabled" : ""}>${running ? "Writing…" : latest ? "Write a new one" : "Write today's wins"}</button>
      ${latest ? `<button type="button" class="ghost" id="speech-copy">Copy</button>` : ""}
      <span class="meta" data-copy-note="speech">${
        running
          ? `Started ${esc(new Date(status.startedAt).toLocaleTimeString())}. Reading the sprint, stand-ups, notes and the changelog, then one call to Claude to rank the wins; usually under a minute.`
          : latest
            ? `Written ${latest.trigger === "morning" ? "automatically after the 8 AM readout, " : ""}${esc(new Date(latest.generatedAt).toLocaleString())}, from the readout pulled ${esc(latest.dateKey ?? "")}.${latest.trigger === "morning" ? " Add notes and write a new one to fold them in." : ""}`
            : "Not written yet."
      }</span>
    </div>
    ${failed ? `<div class="missing">The last run failed. ${esc(status.error ?? "")}</div>` : ""}
    ${speech.error ? `<div class="missing">${esc(speech.error)}</div>` : ""}
    ${stale ? `<p class="meta">This was written from the ${esc(latest.dateKey)} readout. Today's is ${esc(state.report.dateKey)}: write a new one.</p>` : ""}
    ${
      latest?.unverified?.length
        ? `<div class="missing"><strong>Check before you say it.</strong> ${esc(plural(latest.unverified.length, "figure", "figures"))} in this speech could not be found in the data: ${esc(latest.unverified.join(", "))}. Cut or correct ${latest.unverified.length === 1 ? "it" : "them"}, or write a new one.</div>`
        : ""
    }
    ${missed.length ? `<p class="meta">Not available when this was written: ${esc(missed.join(", "))}.</p>` : ""}
    ${(latest?.xf?.notes ?? []).map((n) => `<div class="missing">${esc(n)}</div>`).join("")}
    ${latest ? winsList(latest) : ""}
    ${
      latest?.facts?.length
        ? `<details class="ds-facts"><summary>What it rests on (${esc(latest.facts.length)})</summary><ul>${latest.facts
            .map((f) => `<li>${esc(f.claim)} <span class="meta">· ${esc(f.source)}</span></li>`)
            .join("")}</ul></details>`
        : ""
    }
    ${notesSection()}
    ${latest ? xfSection(latest.xf) : ""}`;
}

/** The wins not yet called out, as text to paste in Slack or send up; an old speech as it was. */
function winsCopyText(latest) {
  if (!latest?.wins) return latest?.text ?? "";
  const called = speech.celebrated ?? {};
  const lines = [latest.headline, ""];
  latest.wins.filter((w) => !called[w.key]).forEach((w, i) => {
    lines.push(`${i + 1}. ${w.title}${w.rock ? ` (${w.rock})` : ""}`);
    if (w.why) lines.push(`   ${w.why}`);
    if (w.kudos?.length) lines.push(`   Kudos: ${w.kudos.map((k) => `${k.name.split(/\s+/)[0]} for ${k.for}`).join("; ")}`);
  });
  if (latest.close) lines.push("", latest.close);
  return lines.join("\n");
}

/** "Tue" for a date, or "today". */
function winDay(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? "today" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/**
 * The sprint's wins, most important first: why each matters and who to thank for which
 * part. Tick "Called out" once said; anything not ticked carries over to tomorrow's list.
 */
function winsList(latest) {
  if (!latest.wins) return `<p class="meta">This was written in the old speech format. Press Write a new one for the ranked wins list.</p>`;
  const called = speech.celebrated ?? {};
  const open = latest.wins.filter((w) => !called[w.key]);
  const done = latest.wins.filter((w) => called[w.key]);
  const today = new Date().toDateString();
  const row = (w, n) => {
    const carried = w.carried || (w.firstSeen && new Date(w.firstSeen).toDateString() !== today);
    const isCalled = Boolean(called[w.key]);
    return `<li class="dw-win${isCalled ? " dw-called" : ""}">
      <span class="dw-rank">${n ?? "✓"}</span>
      <div class="dw-body">
        <div class="dw-title">${w.url ? `<a href="${esc(w.url)}" target="_blank" rel="noreferrer">${esc(w.title)}</a>` : esc(w.title)}</div>
        <div class="dw-tags">
          ${w.rock ? `<span class="dw-tag dw-rock">${esc(w.rock)}</span>` : ""}
          <span class="dw-tag">${esc(w.stage)}</span>
          ${carried && !isCalled ? `<span class="dw-tag dw-carry" title="Not called out yet">carried over since ${esc(winDay(w.firstSeen))}</span>` : ""}
        </div>
        ${w.why ? `<p class="dw-why">${esc(w.why)}</p>` : ""}
        ${w.kudos?.length ? `<div class="dw-kudos">${w.kudos.map((k) => `<span class="dw-kudo">👏 <strong>${esc(k.name.split(/\s+/)[0])}</strong> for ${esc(k.for.replace(/^for\s+/i, ""))}</span>`).join("")}</div>` : ""}
      </div>
      <button type="button" class="${isCalled ? "ghost " : ""}sm dw-check" data-win-${isCalled ? "uncall" : "call"}="${esc(w.key)}">${isCalled ? "Undo" : "Called out"}</button>
    </li>`;
  };
  return `<article class="ds-speech dw">
      <p class="ds-headline">${esc(latest.headline)}</p>
      <p class="meta">${esc(plural(open.length, "win", "wins"))} to celebrate, most important first. Tick <strong>Called out</strong> once you've said it; anything not ticked carries over to tomorrow.</p>
      ${open.length ? `<ol class="dw-list">${open.map((w, i) => row(w, i + 1)).join("")}</ol>` : `<p class="sub mv-clear">✓ Every win so far has been called out.</p>`}
      ${latest.close ? `<p class="ds-close">${esc(latest.close)}</p>` : ""}
    </article>
    ${done.length ? `<details class="ds-facts"><summary>Called out (${esc(done.length)})</summary><ol class="dw-list">${done.map((w) => row(w, null)).join("")}</ol></details>` : ""}`;
}

document.addEventListener("click", async (event) => {
  const b = event.target.closest("[data-win-call], [data-win-uncall]");
  if (!b) return;
  const key = b.dataset.winCall ?? b.dataset.winUncall;
  const body = b.dataset.winCall ? { called: key } : { uncalled: key };
  b.disabled = true;
  const res = await fetch(`${FN}/speech`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    b.disabled = false;
    return alert(`Not saved: ${out.error ?? `HTTP ${res.status}`}`);
  }
  speech.celebrated = out.celebrated ?? speech.celebrated;
  renderSpeech();
});

/** The cross-functional list the speech was written from, each item linked to where it was said. */
function xfSection(xf) {
  if (!xf) return "";
  const items = xf.items ?? [];
  const since = xf.since ? new Date(xf.since).toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" }) : "the previous working day";
  const where = xf.channelsRead?.length ? ` Slack channels read: ${xf.channelsRead.join(", ")}.` : "";
  return `<section class="ds-xf">
    <div class="sp-group-head"><h3>Cross-functional (XF)</h3><span class="meta">${esc(plural(items.length, "item", "items"))} since ${esc(since)}</span></div>
    <p class="meta">ClickUp comments on sprint tickets from people outside the team${xf.channelsRead?.length ? ", and Slack @mentions and thread replies" : ""}. Your notes above are read too.${esc(where)}</p>
    ${
      items.length
        ? `<ul class="ds-xf-list">${items
            .map(
              (i) => `<li>
          <div><strong>${esc(i.from)}</strong> <span class="meta">${esc(i.how)} ${esc(i.to.map((n) => String(n).split(/\s+/)[0]).join(", "))} · ${esc(i.where)} · ${esc(new Date(i.at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }))}</span>${i.url ? ` <a href="${esc(i.url)}" target="_blank" rel="noreferrer">Open</a>` : ""}</div>
          <div class="ds-xf-text">${esc(i.text)}</div>
        </li>`,
            )
            .join("")}</ul>`
        : `<p class="meta">No ClickUp comments from outside the team in this window.</p>`
    }
  </section>`;
}

document.addEventListener("input", (event) => {
  if (event.target.id === "ds-note-text") speech.draft = event.target.value;
});

document.addEventListener("click", async (event) => {
  if (event.target.closest("#ds-note-add")) {
    const text = speech.draft.trim();
    if (!text) return;
    speech.notesError = null;
    const res = await fetch(`${FN}/day-notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    if (res?.ok) speech.draft = "";
    else speech.notesError = `Not saved. ${body?.error ?? "Could not reach the server."}`;
    await loadDayNotes();
    renderSpeech();
    return;
  }
  const del = event.target.closest(".ds-note-del");
  if (del) {
    await fetch(`${FN}/day-notes`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: del.dataset.id, dateKey: del.dataset.date }) }).catch(() => null);
    await loadDayNotes();
    renderSpeech();
    return;
  }
  if (event.target.closest("#speech-copy")) {
    const note = document.querySelector('[data-copy-note="speech"]');
    try {
      await navigator.clipboard.writeText(winsCopyText(speech.latest));
      note.textContent = "Copied.";
    } catch {
      note.textContent = "The browser would not copy. Select the text and copy it by hand.";
    }
    return;
  }
  const button = event.target.closest("#speech-run");
  if (!button) return;
  button.disabled = true;
  speech.error = null;
  const res = await fetch(`${FN}/speech`, { method: "POST" }).catch((err) => ({ ok: false, json: async () => ({ reason: err.message }) }));
  const body = await res.json().catch(() => ({}));
  if (res.ok || res.status === 409) {
    speech.status = { state: "running", startedAt: body.startedAt ?? body.status?.startedAt ?? new Date().toISOString(), running: true };
    pollSpeech();
  } else {
    speech.error = `Could not start writing. ${body.reason ?? body.error ?? ""}`;
  }
  renderSpeech();
});

/* ---------------------------------- impact ----------------------------------
   Overall Impact (was Alex's Impact): the append-only record of what Alex and the team shipped, in themes.
   The server harvests and regroups it each working morning; this draws it and can start
   a pass on demand. */

const IMPACT_KIND = { ticket: "Ticket", test: "Test", rock: "Rock", build: "MOS build" };
// `open` holds the themes Alex has expanded. Everything starts collapsed, and the set
// survives the re-render every poll does, so an open theme stays open.
const impact = { ledger: null, status: null, loaded: false, polling: null, error: null, query: "", open: new Set() };

async function loadImpact() {
  const res = await fetch(`${FN}/impact`).then((r) => r.json()).catch(() => null);
  impact.loaded = true;
  if (res) {
    impact.ledger = res.ledger;
    impact.status = res.status;
  }
  renderImpact();
  if (impact.status?.running) pollImpact();
}

function pollImpact() {
  if (impact.polling) return;
  impact.polling = setInterval(async () => {
    const res = await fetch(`${FN}/impact`).then((r) => r.json()).catch(() => null);
    if (!res) return;
    impact.ledger = res.ledger;
    impact.status = res.status;
    if (!res.status?.running) {
      clearInterval(impact.polling);
      impact.polling = null;
    }
    renderImpact();
  }, 5000);
}

/** Every item id under a theme, at any depth. */
function impactIds(theme) {
  return [...(theme.itemIds ?? []), ...(theme.themes ?? []).flatMap(impactIds)];
}

/** Biggest themes first; "Not yet sorted" always last. */
function impactOrder(themes) {
  return [...(themes ?? [])].sort(
    (a, b) => (a.title === "Not yet sorted") - (b.title === "Not yet sorted") || impactIds(b).length - impactIds(a).length,
  );
}

/** Every theme id, at any depth, for expand all. */
function impactThemeIds(themes) {
  return (themes ?? []).flatMap((t) => [t.id, ...impactThemeIds(t.themes)]);
}

function impactItem(item) {
  const date = item.date ? new Date(item.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
  const who = (item.who ?? []).map((n) => String(n).split(/\s+/)[0]).join(", ");
  const facts = item.facts ?? {};
  const bits = [
    IMPACT_KIND[item.kind] ?? item.kind,
    item.kind === "test" ? (item.status === "concluded" ? "concluded" : "running") : null,
    facts.verdict && item.kind === "test" ? `verdict ${facts.verdict}` : null,
    facts.estMonthlyRevenueImpact != null ? `est. $${Number(facts.estMonthlyRevenueImpact).toLocaleString()}/mo (Intelligems)` : null,
    who || null,
    date || null,
  ].filter(Boolean);
  const name = item.url
    ? `<a href="${esc(item.url)}"${item.url.startsWith("#") ? "" : ` target="_blank" rel="noreferrer"`}>${esc(item.title)}</a>`
    : esc(item.title);
  const changes = item.kind === "build" && facts.changes?.length
    ? `<details class="im-changes"><summary class="meta">What changed</summary><ul>${facts.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></details>`
    : "";
  return `<li class="im-item"><span class="im-name">${name}</span> <span class="meta">${esc(bits.join(" · "))}</span>${changes}</li>`;
}

function impactMatches(item, q) {
  if (!q) return true;
  return [item.title, item.bigSwing, item.rock, ...(item.who ?? [])].some((v) => String(v ?? "").toLowerCase().includes(q));
}

function impactList(ids, items, q) {
  const rows = ids
    .map((id) => items[id])
    .filter((it) => it && impactMatches(it, q))
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  return rows.length ? `<ul class="im-items">${rows.map(impactItem).join("")}</ul>` : "";
}

function impactTheme(theme, items, q, depth) {
  const ids = impactIds(theme);
  const shown = ids.filter((id) => items[id] && impactMatches(items[id], q));
  if (!shown.length) return "";
  const H = depth ? "h4" : "h3";
  const newest = Math.max(0, ...ids.map((id) => Date.parse(items[id]?.firstSeen ?? 0) || 0));
  const fresh = Date.now() - newest < 3 * 86_400_000;
  return `<details class="im-theme im-depth-${depth}" id="impact-${esc(theme.id)}" data-theme="${esc(theme.id)}"${q || impact.open.has(theme.id) ? " open" : ""}>
    <summary><${H}>${esc(theme.title)}</${H}><span class="meta">${esc(plural(ids.length, "item", "items"))}${fresh ? " · new this week" : ""}</span></summary>
    ${theme.summary ? `<p class="im-summary">${esc(theme.summary)}</p>` : ""}
    ${impactOrder(theme.themes).map((t) => impactTheme(t, items, q, depth + 1)).join("")}
    ${impactList(theme.itemIds ?? [], items, q)}
  </details>`;
}

function renderImpact() {
  const root = $("impact");
  if (!root) return;
  if (!impact.loaded) {
    root.innerHTML = `<p class="sub">Loading…</p>`;
    return;
  }
  const { ledger, status } = impact;
  const running = Boolean(status?.running);
  const items = ledger?.items ?? {};
  const themes = ledger?.themes ?? [];
  const all = Object.values(items);
  const count = (k) => all.filter((i) => i.kind === k).length;
  const lastRun = ledger?.runs?.[0];
  const q = impact.query.trim().toLowerCase();

  root.innerHTML = `
    <div class="bar up-bar">
      <button type="button" id="impact-run"${running ? " disabled" : ""}>${running ? "Working…" : ledger ? "Reorganize now" : "Build it now"}</button>
      ${themes.length ? `<button type="button" id="impact-expand" class="ghost">${impact.open.size ? "Collapse all" : "Expand all"}</button>` : ""}
      <input id="impact-filter" placeholder="Filter by title, person, rock or Big Swing" value="${esc(impact.query)}">
      <span class="meta">${
        running
          ? `Started ${esc(new Date(status.startedAt).toLocaleTimeString())}. Harvesting, then one call to Claude to regroup; usually a minute or two.`
          : ledger
            ? `Updated ${esc(new Date(ledger.updatedAt).toLocaleString())}${ledger.reorganizedAt ? `; last regrouped ${esc(new Date(ledger.reorganizedAt).toLocaleDateString())}` : ""}.`
            : "Not built yet. It builds itself each working morning at 9, or press the button."
      }</span>
    </div>
    ${status?.state === "failed" && !running ? `<div class="missing">The last pass failed. ${esc(status.error ?? "")}</div>` : ""}
    ${lastRun?.error ? `<p class="meta">Last pass: ${esc(lastRun.error)}</p>` : ""}
    ${impact.error ? `<div class="missing">${esc(impact.error)}</div>` : ""}
    ${
      all.length
        ? `<p class="meta">${esc(plural(all.length, "item", "items"))} in ${esc(plural(themes.length, "theme", "themes"))}: ${esc(
            [["ticket", "ticket", "tickets"], ["test", "test", "tests"], ["rock", "rock shipped", "rocks shipped"], ["build", "MOS build day", "MOS build days"]]
              .filter(([k]) => count(k))
              .map(([k, one, many]) => plural(count(k), one, many))
              .join(", "),
          )}. Recorded since ${esc(new Date(ledger.createdAt).toLocaleDateString())}.</p>
      ${ledger.changeNote ? `<p class="im-note"><strong>Latest change.</strong> ${esc(ledger.changeNote)}</p>` : ""}
      ${impactOrder(themes).map((t) => impactTheme(t, items, q, 0)).join("") || `<p class="sub">Nothing matches.</p>`}`
        : ledger
          ? `<p class="sub">Nothing recorded yet: the latest readout holds no done tickets, tests or shipped rocks.</p>`
          : ""
    }`;
}

// Remember what Alex opens or closes. While filtering every match is open, so the clicks
// then are not remembered.
document.addEventListener(
  "toggle",
  (event) => {
    const el = event.target;
    if (!el.matches?.(".im-theme") || impact.query.trim()) return;
    const id = el.dataset.theme;
    const before = impact.open.size;
    if (el.open) impact.open.add(id);
    else impact.open.delete(id);
    if (Boolean(before) !== Boolean(impact.open.size)) {
      const btn = $("impact-expand");
      if (btn) btn.textContent = impact.open.size ? "Collapse all" : "Expand all";
    }
  },
  true,
);

document.addEventListener("click", (event) => {
  if (!event.target.closest("#impact-expand")) return;
  impact.open = impact.open.size ? new Set() : new Set(impactThemeIds(impact.ledger?.themes));
  renderImpact();
});

document.addEventListener("input", (event) => {
  if (event.target.id !== "impact-filter") return;
  impact.query = event.target.value;
  const pos = event.target.selectionStart;
  renderImpact();
  const input = $("impact-filter");
  input.focus();
  input.setSelectionRange(pos, pos);
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("#impact-run");
  if (!button) return;
  button.disabled = true;
  impact.error = null;
  const res = await fetch(`${FN}/impact`, { method: "POST" }).catch((err) => ({ ok: false, json: async () => ({ reason: err.message }) }));
  const body = await res.json().catch(() => ({}));
  if (res.ok || res.status === 409) {
    impact.status = { state: "running", startedAt: body.startedAt ?? body.status?.startedAt ?? new Date().toISOString(), running: true };
    pollImpact();
  } else {
    impact.error = `Could not start the pass. ${body.reason ?? body.error ?? ""}`;
  }
  renderImpact();
});

$("import-apply").addEventListener("click", applyImport);
$("import-modal").addEventListener("click", (e) => { if (e.target.id === "import-modal") closeImport(); });

/* ----------------------------------- nav ----------------------------------- */

// Three areas, each a row of pages. Today is what to act on now, Team is the work itself,
// Write-ups is what gets sent or kept. Setup is only in the menu, and names itself in the
// top bar when open. The drawer lists the same groups (index.html).
const NAV_GROUPS = [
  { id: "today", pages: [["readout", "What needs you"], ["speech", "Daily wins"], ["standup", "Stand-up"]] },
  { id: "team", pages: [["sprint", "Sprint"], ["backlog", "Backlog"], ["rocks", "Rocks"], ["workshop", "Workshop"], ["plan", "Quarter"], ["people", "1:1"], ["ideation", "Ideation"]] },
  { id: "writeups", pages: [["mystandup", "My stand-up"], ["upsu", "Update + Stand-up"], ["thisweek", "This week's wins"], ["lastweek", "Last week's wins"], ["impact", "Overall Impact"]] },
];
// On a wide screen the drawer stays open beside the page and is the nav.
const drawerPinned = matchMedia("(min-width: 1280px)");
const groupOf = (view) => NAV_GROUPS.find((g) => g.pages.some(([v]) => v === view)) ?? null;
// The page last open in each area, so going back to an area lands where you were.
const lastInGroup = {};
const VIEW_TITLES = { setup: "Setup", ecomrocks: "Ecom Rocks" };

function renderSubtabs(name) {
  const group = groupOf(name);
  $("subtabs").innerHTML = group
    ? group.pages
        .map(([v, label]) => `<button type="button" class="subtab${v === name ? " active" : ""}" data-view="${v}" aria-current="${v === name ? "page" : "false"}">${esc(label)}</button>`)
        .join("")
    : "";
  $("subtabs").hidden = !group;
}

/* --------------------------------- 1:1 prep ---------------------------------
   One person at a time, built entirely from what the dashboard already holds: the
   report, the live triage, the rocks and the test notes. Nothing is fetched for it and
   nothing about it leaves the page; the talking points are copied for Alex to use. */

const DAY_MS = 86_400_000;

// "Done this week" is the tickets in "done (this sprint)". "complete" is last sprint's work,
// moved there when the sprint rolled over, so it stays out however recently it closed.
function doneThisSprint(tasks) {
  return tasks.filter((t) => String(t.status ?? "").toLowerCase() === "done (this sprint)");
}

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
    (t.assignees ?? []).some((u) => String(u.id) === id || isPerson(u.username, person)),
  );
  const open = tasks.filter((t) => t.bucket !== "done");
  const doneThisWeek = doneThisSprint(tasks);
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
    .filter((t) => t.bucket !== "done" && primaryAssignee(t).some((u) => u.id === id || isPerson(u.name, person)))
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
      ? [...data.open].sort((a, b) => stageRank(a) - stageRank(b)).map((t) => ticketRow(t)).join("")
      : `<p class="sub">Nothing open in the current sprint.</p>`}
    ${data.cross ? `<p class="meta">${esc(plural(data.cross.bauTickets?.length ?? 0, "BAU ticket", "BAU tickets"))}, ${esc(plural(data.cross.unrelatedTickets?.length ?? 0, "ticket", "tickets"))} on no rock.</p>` : ""}

    <h3>Queued for them in the backlog</h3>
    ${data.queued.length
      ? `<ul class="plain">${data.queued.map((t) => { const rock = rockForTask(t); return `<li>${t.ready ? '<span class="chip good">Ready</span> ' : ""}${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.name)}</a>` : esc(t.name)} <span class="meta">${esc(rock ? rock.title : t.bigSwing?.label ?? "no Big Swing")}</span></li>`; }).join("")}</ul>`
      : `<p class="sub">${state.report?.detail?.backlog?.available ? "Nothing in the backlog with their name on it." : "The backlog was not loaded."}</p>`}

    ${data.doneThisWeek.length ? `<h3>Done this week</h3><ul class="plain">${data.doneThisWeek.map((t) => `<li>${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.name)}</a>` : esc(t.name)}</li>`).join("")}</ul>` : ""}

    ${data.tests.length ? `<h3>Tests they own</h3><div class="flag-links">${data.tests.map((t) => `<a href="${AB_TESTING}" target="_blank" rel="noreferrer">${esc(t.name)} · ${esc(t.recommendation?.recommendation ?? "")} ↗</a>`).join("")}</div>` : ""}

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

/* ------------------------------ deep links ------------------------------ */

function parseHash(hash) {
  const [raw, ...rest] = (hash || "#readout").slice(1).split("/");
  // Staleness folded into the Sprint view; an old link to it still lands somewhere useful.
  // A bare address opens Today's "What needs you": what to act on, first.
  const name = raw === "staleness" ? "sprint" : raw || "readout";
  return { name, target: rest.join("/") ? decodeURIComponent(rest.join("/")) : null };
}


/* ------------------------------ today's rock moves ------------------------------
   Top of What needs you: the few things that move a rock today, each with what it moves
   and why now, picked by Alex and ticked off. See src/focus/moves.js. */

const moves = { data: null, loading: false, busy: false, adding: false, more: false, error: null, just: null, copied: null, tab: null, open: new Set(), delegate: null };

/* Unblock others: the people waiting on Alex right now. Someone asked in ClickUp
   (reply owed), or a ticket sits in QA or ready for deploy waiting on Alex. Alex's own
   due tickets are not here: nobody else is blocked on them. */
const UNBLOCK_RULES = new Set(["nextstep.reply_owed", "nextstep.awaiting_you"]);
function unblockFlags() {
  const sev = { p1: 0, attention: 1, prompt: 2, info: 3 };
  return (state.report?.flags ?? [])
    .filter((f) => UNBLOCK_RULES.has(f.rule) && viewOf(f) === "open")
    .sort((a, b) => (sev[a.severity] ?? 9) - (sev[b.severity] ?? 9) || Boolean(b.isNew) - Boolean(a.isNew) || (b.openDays ?? 0) - (a.openDays ?? 0));
}
const FOCUS_MIN = 25;
const COURSE_WORD = { off: "off course", drift: "drifting", on: "on course" };
const WEEKDAY = (key) => new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });

/* --------------------------- Slack to-dos (Today's moves) ---------------------------
   Read live from Slack with Alex's user token (netlify/functions/slack-todos.mjs): only what
   Alex chose to come back to (reminders, Slack Lists, saved messages), under My work. */
const slackTodo = { data: null, error: null, loading: false };
async function loadSlackTodos() {
  if (slackTodo.loading) return;
  slackTodo.loading = true;
  try {
    const res = await fetch(`${FN}/slack-todos`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    slackTodo.data = body;
    slackTodo.error = null;
  } catch (err) {
    slackTodo.error = err.message;
  } finally {
    slackTodo.loading = false;
    renderMoves();
  }
}
function slackWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function slackRow(i) {
  const label = `slack:${i.kind}`;
  const meta = i.kind === "todo"
    ? [i.from, i.due ? `${Date.parse(i.due) < Date.now() ? "was due" : "due"} ${slackWhen(i.due)}` : ""].filter(Boolean).join(" · ") || "to-do"
    : i.kind === "reminder"
      ? `${i.at ? (Date.parse(i.at) < Date.now() ? `was due ${slackWhen(i.at)}` : `due ${slackWhen(i.at)}`) : "no time set"}${i.recurring ? " · repeats" : ""}`
      : i.kind === "list"
        ? [i.list, i.due ? `due ${new Date(`${i.due}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}` : "", i.owner ?? ""].filter(Boolean).join(" · ")
        : `${i.from} · saved ${slackWhen(i.at)}`;
  return `<div class="sl-row sl-${i.kind}">
      <span class="sl-kind">${esc(label)}</span>
      <span class="sl-text" title="${esc(i.text)}">${esc(i.text)}</span>
      <span class="sl-meta">${esc(meta)}</span>
      <span class="q-acts">
        ${i.url ? `<a class="ql" href="${esc(i.url)}" target="_blank" rel="noreferrer">Open in Slack ↗</a>` : ""}
        <button type="button" class="ghost sm" data-sl-done="${esc(i.key)}"${i.reminderId ? ` data-sl-reminder="${esc(i.reminderId)}"` : ""} title="${i.kind === "reminder" ? "Complete the reminder in Slack" : "Hide it here"}">Done</button>
      </span>
    </div>`;
}
function slackSection(kinds, title, sub) {
  if (slackTodo.error) return `<p class="meta sl-note">From Slack: ${esc(slackTodo.error)}</p>`;
  const d = slackTodo.data;
  if (!d) return `<p class="meta sl-note">Reading Slack…</p>`;
  const items = kinds.flatMap((k) => d[k] ?? []);
  const notes = d.notes ?? [];
  if (!items.length && !notes.length) return "";
  return `<div class="mv-sec"><span>${esc(title)} ${items.length ? `<span class="mt-n">${items.length}</span>` : ""}</span><span class="meta">${esc(sub)}</span></div>
    ${items.length ? `<div class="mt-list">${items.map(slackRow).join("")}</div>` : ""}
    ${notes.map((n) => `<p class="meta sl-note">${esc(n)}</p>`).join("")}`;
}
document.addEventListener("click", async (event) => {
  const b = event.target.closest("[data-sl-done]");
  if (!b) return;
  b.disabled = true;
  const res = await fetch(`${FN}/slack-todos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ done: b.dataset.slDone, reminderId: b.dataset.slReminder || undefined }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    b.disabled = false;
    return alert(`Not done: ${body.error ?? `HTTP ${res.status}`}`);
  }
  for (const k of ["todos", "reminders", "saved", "lists"]) if (slackTodo.data?.[k]) slackTodo.data[k] = slackTodo.data[k].filter((i) => i.key !== b.dataset.slDone);
  renderMoves();
});

async function loadMoves() {
  if (moves.loading) return;
  moves.loading = true;
  if (!slackTodo.data && !slackTodo.loading) loadSlackTodos();
  try {
    const res = await fetch(`${FN}/focus`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    moves.data = body;
    moves.error = null;
  } catch (err) {
    moves.error = `Could not load today's rock moves: ${err.message}`;
  } finally {
    moves.loading = false;
    renderMoves();
    if (state.report) renderTopThree(state.report.flags ?? []);
  }
}

async function movesChange(change) {
  if (moves.busy) return;
  moves.busy = true;
  try {
    const res = await fetch(`${FN}/focus`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ change }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    moves.data = body;
    moves.error = null;
  } catch (err) {
    moves.error = err.message;
  } finally {
    moves.busy = false;
    renderMoves();
    if (state.report) renderTopThree(state.report.flags ?? []);
  }
}

const SOURCE_WORD = { course: "Rock check", plan: "Quarter plan", ticket: "Your ticket", own: "Your move" };

/**
 * A move's text split for display, so the rock is named once (in the label above) and the
 * how-to is secondary: "Bundles 2.0 — check in on each in the standup: mark it done, or set a
 * new date and say why (with Blake)" → title "Check in on each in the standup", with "Blake",
 * how "Mark it done, or set a new date and say why".
 */
function moveParts(m) {
  let t = String(m.text ?? "");
  const rock = m.impact?.rockTitle;
  if (rock && t.startsWith(`${rock} — `)) t = t.slice(rock.length + 3);
  let withWhom = null;
  const w = t.match(/\s\(with ([^)]+)\)$/);
  if (w) { withWhom = w[1]; t = t.slice(0, w.index); }
  let how = null;
  if (m.source === "course") {
    const i = t.indexOf(": ");
    if (i > 0) { how = t.slice(i + 2); t = t.slice(0, i); }
  }
  const cap = (x) => (x ? x[0].toUpperCase() + x.slice(1) : x);
  return { title: cap(t), how: cap(how), withWhom };
}

/** The label above a move: the rock it moves, its course, and where the move came from. */
function rockLabel(m) {
  const i = m.impact ?? {};
  const course = i.course ?? "on";
  return `<div class="mv-rock">
      <span class="mv-rock-name"><span class="mv-dot ${esc(course)}" aria-hidden="true"></span>${esc(i.rockTitle ?? "No rock")}</span>
      ${course !== "on" ? `<span class="mv-course ${esc(course)}">${esc(COURSE_WORD[course])}</span>` : ""}
      ${m.source ? `<span class="mv-src">${esc(SOURCE_WORD[m.source] ?? "")}</span>` : ""}
    </div>`;
}

function moveTitle(m, parts) {
  const text = m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noreferrer">${esc(parts.title)}</a>` : esc(parts.title);
  return `<span class="mv-text">${text}${parts.withWhom ? ` <span class="mv-with">with ${esc(parts.withWhom)}</span>` : ""}</span>`;
}

/** What it moves, as short labelled rows. `full` adds the tactic and the definition of done. */
function impactFacts(i, { full }) {
  if (!i) return "";
  const rows = [
    i.milestone ? ["Milestone", `${esc(i.milestone.label)}: ${esc(i.milestone.deliverable)}`] : null,
    full && i.tactic ? ["Tactic", `${esc(i.tactic.title)}${i.tactic.kpi ? ` <span class="mv-kpi">KPI ${esc(i.tactic.kpi)}</span>` : ""}`] : null,
    full && i.definitionOfDone ? ["Done means", esc(i.definitionOfDone)] : null,
  ].filter(Boolean);
  if (!rows.length) return "";
  return `<dl class="mv-facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd title="${esc(v.replace(/<[^>]+>/g, ""))}">${v}</dd>`).join("")}</dl>`;
}

/* Focus blocks: a 25-minute timer per move, kept in this browser only (a convenience; the
   start time itself is saved with the move). */
function focusTimers() {
  try { return JSON.parse(localStorage.getItem("mv-focus") ?? "{}") ?? {}; } catch { return {}; }
}
function setFocusTimer(id, endsAt) {
  const all = focusTimers();
  if (endsAt) all[id] = endsAt; else delete all[id];
  try { localStorage.setItem("mv-focus", JSON.stringify(all)); } catch { /* private window: the timer just is not kept */ }
}
const mins = (ms) => Math.max(0, Math.round(ms / 60000));
function tickMoves() {
  const now = Date.now();
  for (const el of document.querySelectorAll("[data-mv-since]")) {
    const m = mins(now - Date.parse(el.dataset.mvSince));
    el.textContent = m < 1 ? "just started" : m < 60 ? `${m} min in` : `${Math.floor(m / 60)} h ${m % 60} min in`;
  }
  for (const el of document.querySelectorAll("[data-mv-ends]")) {
    const left = Number(el.dataset.mvEnds) - now;
    if (left > 0) {
      const sec = Math.ceil(left / 1000);
      el.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")} left`;
    } else if (!el.classList.contains("up")) {
      el.classList.add("up");
      el.textContent = "Time's up. Done, or another 25?";
    }
  }
}
setInterval(tickMoves, 1000);

/** What to copy to get it moving: a note to the rock owner, or the stand-up line. */
function kickoffNote(m, parts) {
  const i = m.impact ?? {};
  const lower = (x) => (x ? x[0].toLowerCase() + x.slice(1) : x);
  if (parts.withWhom) {
    return {
      label: `Copy note to ${parts.withWhom}`,
      text: `Hi ${parts.withWhom}, quick one on ${i.rockTitle}: ${lower(m.why ?? parts.title)}.${parts.how ? ` Can you ${lower(parts.how)}?` : ""} Thanks!`,
    };
  }
  return { label: "Copy stand-up line", text: `Today: ${parts.title} (moves ${i.rockTitle})` };
}

/** The started move: how long it has run, the first step, and one click to each place the work happens. */
function kickoff(m, parts) {
  const i = m.impact ?? {};
  const ends = focusTimers()[m.id];
  const note = kickoffNote(m, parts);
  const links = [
    m.url ? `<a class="mv-go primary" href="${esc(m.url)}" target="_blank" rel="noreferrer">Open in ClickUp ↗</a>` : "",
    i.rockId ? `<a class="mv-go" href="#rocks/${encodeURIComponent(i.rockId)}">Open rock</a>` : "",
    m.source === "plan" ? `<a class="mv-go" href="#plan">Quarter plan</a>` : "",
  ].join("");
  return `<div class="mv-kick">
      <div class="mv-live"><span class="mv-pulse" aria-hidden="true"></span>In progress · <span data-mv-since="${esc(m.startedAt)}"></span>
        ${ends ? `<span class="mv-timer" data-mv-ends="${esc(ends)}"></span>` : ""}</div>
      ${parts.how ? `<p class="mv-step"><span class="mv-k">First step</span> ${esc(parts.how)}.</p>` : ""}
      <div class="mv-kick-acts">
        ${links}
        <button type="button" class="mv-go" data-mv="copy" data-mv-id="${esc(m.id)}">${moves.copied === m.id ? "Copied ✓" : esc(note.label)}</button>
        <button type="button" class="mv-go" data-mv="focus" data-mv-id="${esc(m.id)}">${ends && Number(ends) > Date.now() ? "Stop timer" : `Focus ${FOCUS_MIN} min`}</button>
      </div>
    </div>`;
}

function moveCard(m) {
  const parts = moveParts(m);
  if (m.doneAt) {
    const at = new Date(m.doneAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `<div class="mv-card done${moves.just === m.id ? " just" : ""}">
        <span class="mv-check" aria-hidden="true">✓</span>
        <span class="mv-done-text"><span class="mv-text">${esc(parts.title)}</span>
          <span class="mv-ack">${esc(m.impact?.rockTitle ?? "The rock")} moved · ${esc(at)}</span></span>
        <button type="button" class="link-btn" data-mv="undo" data-mv-id="${esc(m.id)}">Undo</button>
      </div>`;
  }
  const started = Boolean(m.startedAt);
  return `<div class="mv-card${started ? " started" : ""}">
      ${rockLabel(m)}
      <div class="mv-head">
        ${moveTitle(m, parts)}
        <span class="mv-acts">
          ${started
            ? `<button type="button" class="sm" data-mv="done" data-mv-id="${esc(m.id)}">Done</button>`
            : `<button type="button" class="sm" data-mv="start" data-mv-id="${esc(m.id)}">Start</button>
               <button type="button" class="ghost sm" data-mv="done" data-mv-id="${esc(m.id)}">Done</button>`}
          <button type="button" class="link-btn" data-mv="remove" data-mv-id="${esc(m.id)}" title="Take it off today's list">Drop</button>
        </span>
      </div>
      ${started ? kickoff(m, parts) : parts.how ? `<p class="mv-how">${esc(parts.how)}.</p>` : ""}
      ${m.why && m.source !== "plan" ? `<p class="mv-why" title="${esc(m.why)}"><span class="mv-k">Why now</span> ${esc(m.why)}</p>` : ""}
      ${impactFacts(m.impact, { full: true })}
    </div>`;
}

function suggestionRow(m) {
  const parts = moveParts(m);
  return `<div class="mv-sug">
      ${rockLabel(m)}
      <div class="mv-head">
        ${moveTitle(m, parts)}
        <span class="mv-acts">
          <button type="button" class="sm" data-mv="start-new" data-mv-id="${esc(m.id)}" title="Add it to today and start now">Start now</button>
          <button type="button" class="ghost sm" data-mv="pick" data-mv-id="${esc(m.id)}" title="Add it to today's list to start later">Later today</button>
        </span>
      </div>
      ${m.why && m.source !== "plan" ? `<p class="mv-why" title="${esc(m.why)}">${esc(m.why)}</p>` : ""}
      ${impactFacts(m.impact, { full: false })}
    </div>`;
}

/** Monday to Friday of this week; days after today are shown empty. */
function weekDays(d) {
  const seen = new Map(d.week.days.map((x) => [x.dateKey, x]));
  const start = d.week.days[0]?.dateKey ?? d.today;
  const out = [];
  for (let n = 0; n < 5; n += 1) {
    const key = new Date(Date.parse(`${start}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    out.push({ dateKey: key, ...(seen.get(key) ?? { picked: 0, done: 0 }), future: key > d.today });
  }
  return out;
}

function renderMoves() {
  const host = $("focus");
  if (!host) return;
  const d = moves.data;
  if (!d) {
    host.innerHTML = `<div class="glass mv-glass">${moves.error ? `<p class="triage-error">${esc(moves.error)}</p>` : `<p class="meta">Loading today's rock moves…</p>`}</div>`;
    return;
  }
  const open = d.picks.filter((p) => !p.doneAt).sort((a, b) => Boolean(b.startedAt) - Boolean(a.startedAt));
  const done = d.picks.filter((p) => p.doneAt);
  const room = open.length < 3;
  const unblock = unblockFlags();
  const reviews = myReviewTickets();
  // Unblocking others comes first; with nobody waiting, the rock work is shown.
  const mySlack = (slackTodo.data?.todos ?? []).length + (slackTodo.data?.reminders ?? []).length + (slackTodo.data?.saved ?? []).length + (slackTodo.data?.lists ?? []).length;
  const tab = moves.tab ?? (unblock.length + reviews.length ? "unblock" : "rock");
  const waitingN = unblock.length + reviews.length;
  const mineOpen = myOpenTickets();
  const rockCount = mineOpen.moving.length + mineOpen.todo.length + open.length + mySlack;
  const sugPool = d.suggestions.filter((m) => m.source !== "ticket");
  const sugs = room ? sugPool.slice(0, moves.more ? 6 : d.picks.length ? 2 : 3) : [];
  const hidden = sugPool.length - sugs.length;

  const meter = Array.from({ length: Math.max(3, d.picks.length) }, (_, n) =>
    `<span class="mv-seg${n < done.length ? " on" : n < d.picks.length ? " picked" : ""}"></span>`).join("");
  const days = weekDays(d)
    .map((day) => `<span class="mv-day${day.done ? " hit" : ""}${day.dateKey === d.today ? " today" : ""}${day.future ? " future" : ""}" title="${esc(day.dateKey)}: ${esc(day.done)} done of ${esc(day.picked)} picked">${esc(WEEKDAY(day.dateKey).slice(0, 2))}</span>`)
    .join("");
  const w = d.week;
  const shipped = d.shipped ?? [];
  const tally = [w.done ? plural(w.done, "move", "moves") : "", shipped.length ? `${plural(shipped.length, "ticket", "tickets")} shipped` : ""].filter(Boolean).join(" · ");
  const breakdown = w.rocks.length || shipped.length
    ? `<details class="mv-breakdown"><summary>${esc(tally)}</summary>
        ${w.rocks.length ? `<ul class="plain">${w.rocks.map((r) => `<li><span class="mv-n">${esc(r.n)}</span> ${esc(r.title)}</li>`).join("")}</ul>` : ""}
        ${shipped.length ? `<p class="mv-k">Shipped on rocks</p><ul class="plain">${shipped
          .map((t) => `<li>✓ ${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.name)}</a>` : esc(t.name)} <span class="meta">${esc(t.rockTitle ?? "")}</span></li>`)
          .join("")}</ul>` : ""}
      </details>`
    : `<span class="meta">Nothing done yet this week</span>`;

  host.innerHTML = `
    <div class="glass mv-glass">
      <header class="mv-header">
        <h2>Today's moves</h2>
        ${tab === "rock" && d.picks.length ? `<div class="mv-meter" title="${esc(done.length)} of ${esc(d.picks.length)} rock moves done" aria-label="${esc(done.length)} of ${esc(d.picks.length)} done">${meter}</div>` : ""}
      </header>
      <div class="mv-tabs" role="tablist" aria-label="Today's moves">
        <button type="button" role="tab" class="mv-tab${tab === "unblock" ? " on" : ""}" aria-selected="${tab === "unblock"}" data-mv-tab="unblock">Unblock others${waitingN ? `<span class="mv-badge alert">${esc(waitingN)}</span>` : `<span class="mv-badge">0</span>`}</button>
        <button type="button" role="tab" class="mv-tab${tab === "rock" ? " on" : ""}" aria-selected="${tab === "rock"}" data-mv-tab="rock">My work${rockCount ? `<span class="mv-badge">${esc(rockCount)}</span>` : ""}${d.picks.length ? `<span class="mv-tab-sub">${esc(done.length)}/${esc(d.picks.length)} done</span>` : ""}</button>
      </div>
      ${moves.error ? `<p class="triage-error">${esc(moves.error)}</p>` : ""}
      ${tab === "unblock" ? unblockList(unblock, reviews) : `${slackSection(["todos", "reminders", "lists", "saved"], "From Slack", "Your to-dos, reminders, lists and saved messages")}${myTicketsHtml()}${myTicketsHtml() ? `<div class="mv-sec"><span>Rock moves</span><span class="meta">Decisions and plan items that move a rock</span></div>` : ""}
      ${open.length ? `<div class="mv-list">${open.map(moveCard).join("")}</div>` : ""}
      ${done.length ? `<div class="mv-list mv-done-list">${done.map(moveCard).join("")}</div>` : ""}
      ${sugs.length ? `${d.picks.length || hidden > 0 || moves.more ? `<div class="mv-sec"><span>${d.picks.length ? "More that would move a rock" : ""}</span>${hidden > 0 || moves.more ? `<button type="button" class="link-btn" data-mv="more">${moves.more ? "Fewer" : `${hidden} more`}</button>` : ""}</div>` : ""}
        <div class="mv-list">${sugs.map(suggestionRow).join("")}</div>` : ""}
      ${!d.suggestions.length && !d.picks.length ? `<p class="sub">Nothing suggested: every rock is on course and nothing on a rock is planned or yours this week. Add your own below.</p>` : ""}
      ${room ? (moves.adding
        ? `<form class="mv-add" data-mv-form>
            <input type="text" name="text" maxlength="200" placeholder="What will you do today?" required>
            <select name="rockId" required aria-label="Rock it moves"><option value="">Rock it moves…</option>${d.rocks.map((r) => `<option value="${esc(r.id)}">${esc(r.title)}</option>`).join("")}</select>
            <button type="submit" class="sm">Start now</button><button type="submit" class="ghost sm" data-later>Later today</button><button type="button" class="link-btn" data-mv="cancel">Cancel</button>
          </form>`
        : `<button type="button" class="link-btn mv-add-btn" data-mv="add">+ Add your own</button>`) : ""}
      <footer class="mv-week">
        <span class="mv-k">This week</span>
        <span class="mv-days">${days}</span>
        ${breakdown}
      </footer>`}
    </div>`;
  tickMoves();
}

/** Who is blocked: the person who asked, or whoever is doing the ticket. */
function waitingWho(f) {
  const v = f.values ?? {};
  if (f.rule === "nextstep.reply_owed" && v.who) return `${v.who} is waiting on your reply`;
  if (f.rule === "nextstep.awaiting_you") return v.doing ? `${v.doing} waiting on your review` : "Waiting on your review";
  return null;
}

/* ------------------------------ my open tickets ------------------------------
   First under My rock work: Alex's own open tickets, the ones already moving (anything
   past To Do) before the To Do ones, soonest due first. Each can be delegated: a drafted
   ask, in Alex's voice, for someone to take it on or help, to copy or schedule in Slack. */

function myOpenTickets() {
  const me = state.me != null ? String(state.me) : null;
  if (!me) return { moving: [], todo: [] };
  const mine = [...(state.flagCtx?.tasks?.values() ?? [])].filter(
    (t) => !t.archived && t.bucket !== "done" && (t.assignees ?? []).some((u) => String(u.id) === me),
  );
  const isTodo = (t) => stageOf(t).id === "start" || String(t.status ?? "").toLowerCase() === "to do";
  const byDue = (a, b) => (a.dueDate ?? Infinity) - (b.dueDate ?? Infinity) || (b.statusAge?.days ?? 0) - (a.statusAge?.days ?? 0);
  const reviewing = (t) => stageOf(t).id === "review";
  return {
    moving: mine.filter((t) => !isTodo(t) && !reviewing(t)).sort(byDue),
    todo: mine.filter(isTodo).sort(byDue),
    review: mine.filter(reviewing).sort(byDue),
  };
}

/**
 * Alex's tickets in QA, VQA or review with no "waiting on you" flag yet: someone's work
 * is waiting on Alex's check, so they count as unblocking others.
 */
function myReviewTickets() {
  const flagged = new Set(unblockFlags().map((f) => baseId(subjectOf(f).id)));
  return myOpenTickets().review.filter((t) => !flagged.has(String(t.id)));
}

/** "Robson is waiting on your QA", from the other people on the ticket. */
function reviewWaiting(t) {
  const others = (t.assignees ?? []).filter((u) => String(u.id) !== String(state.me)).map((u) => String(u.username ?? "").split(/\s+/)[0]).filter(Boolean);
  const what = String(t.status ?? "").toLowerCase() === "vqa" ? "VQA" : String(t.status ?? "").toLowerCase() === "qa" ? "QA" : "review";
  return others.length ? `${others.join(", ")} ${others.length === 1 ? "is" : "are"} waiting on your ${what}` : `Waiting on your ${what}`;
}

function dueText(t) {
  if (!t.dueDate) return "no due date";
  const midnight = (ms) => new Date(new Date(ms).toDateString()).getTime();
  const days = Math.round((midnight(t.dueDate) - midnight(Date.now())) / 86_400_000);
  const on = new Date(t.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return days < 0 ? `overdue, due ${on}` : days === 0 ? "due today" : days === 1 ? "due tomorrow" : `due ${on}`;
}

function delegateText(task, to) {
  const f = ticketFacts(task);
  return [
    nudgeEmojis([task]),
    stageOf(task).id === "review"
      ? `${to ? `@${to} ` : ""}Could you do the ${reviewWaiting(task).replace(/^.* your /, "")} on "${task.name}" for me? ${f.where}${f.comment ? ` ${f.comment}` : ""}`
      : `${to ? `@${to} ` : ""}Could you take "${task.name}" on, or help me move it forward? ${f.where}${f.comment ? ` ${f.comment}` : ""}`,
    `Happy to walk you through where it is and what's left. Just want to make sure it keeps moving and doesn't wait on me. Feel free to adjust the approach however you think works best. Thanks!${task.url ? `\n${task.url}` : ""}`,
  ].filter(Boolean).join("\n\n");
}

function myTicketRow(t) {
  const stage = stageOf(t);
  const due = dueText(t);
  const late = /^overdue/.test(due) || due === "due today";
  const open = moves.delegate === String(t.id);
  // Whoever is already on the ticket (for a QA, the person waiting on it) goes last.
  const onIt = new Set((t.assignees ?? []).map((u) => String(u.id)));
  const people = (state.people ?? [])
    .filter((p) => String(p.clickupUserId) !== String(state.me))
    .sort((a, b) => onIt.has(String(a.clickupUserId)) - onIt.has(String(b.clickupUserId)))
    .map((p) => p.name);
  return `<div class="mt-row${open ? " open" : ""}">
      <div class="mt-line">
        <span class="mt-status st-${esc(stage.id)}">${esc(t.status ?? "open")}</span>
        <span class="mt-name">${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noreferrer">${esc(t.name)}</a>` : esc(t.name)}</span>
        <span class="mt-meta${late ? " late" : ""}">${stage.id === "review" ? `${esc(reviewWaiting(t))} · ` : ""}${esc(due)}${t.bigSwing?.label ? ` · ${esc(t.bigSwing.label)}` : ""}</span>
        <span class="mt-acts">
          ${t.url ? `<a class="ql" href="${esc(t.url)}" target="_blank" rel="noreferrer">ClickUp ↗</a>` : ""}
          <button type="button" class="ghost sm" data-mv-delegate="${esc(t.id)}">${open ? "Close" : "Delegate"}</button>
        </span>
      </div>
      ${open ? `<div class="delegate-panel">
          <label>To <select id="tp-person" class="sm" data-delegate-to="${esc(t.id)}">${people.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("")}</select></label>
          <label class="wide">Message <span class="meta">Copy it to send yourself, or schedule it below.</span>
            <textarea id="tp-text" rows="7">${esc(delegateText(t, people[0]))}</textarea></label>
          <div class="bar"><button type="button" class="sm" data-delegate-copy>Copy</button><span class="meta delegate-msg"></span></div>
          ${scheduleRow()}
        </div>` : ""}
    </div>`;
}

function myTicketsHtml() {
  const { moving, todo } = myOpenTickets();
  if (!moving.length && !todo.length) return "";
  const sec = (label, sub, list) => (list.length ? `<div class="mv-sec"><span>${esc(label)} <span class="mt-n">${list.length}</span></span><span class="meta">${esc(sub)}</span></div><div class="mt-list">${list.map(myTicketRow).join("")}</div>` : "");
  return sec("In flight", "Your tickets already moving. Finish these first.", moving) + sec("To do", "Yours, not started yet.", todo);
}

/** The people waiting on Alex, one row each; a row opens to the full card (reply, Done, ×). */
function unblockList(list, reviews = []) {
  if (!list.length && !reviews.length) return `<p class="sub mv-clear">✓ Nobody is waiting on you in ClickUp right now.</p>`;
  const row = (f) =>
    moves.open.has(f.id)
      ? `<div class="q-opened">${flagCard(f)}<button type="button" class="link-btn" data-mv-open="${esc(f.id)}">Close</button></div>`
      : queueRow(f, { who: waitingWho(f) }).replace(`data-q-open="${esc(f.id)}"`, `data-mv-open="${esc(f.id)}"`);
  return `<p class="mv-unblock-sub">Someone is waiting on your reply or review. Clear these first so their work keeps moving.</p>
    ${list.length ? `<div class="q-list">${list.map(row).join("")}</div>` : ""}
    ${reviews.length ? `<div class="mv-sec"><span>Your QA <span class="mt-n">${reviews.length}</span></span><span class="meta">Tickets waiting on your QA, VQA or review</span></div><div class="mt-list">${reviews.map(myTicketRow).join("")}</div>` : ""}`;
}

$("focus")?.addEventListener("click", (event) => {
  const t = event.target.closest("[data-mv-tab]");
  if (t) { moves.tab = t.dataset.mvTab; return renderMoves(); }
  const dg = event.target.closest("[data-mv-delegate]");
  if (dg) {
    moves.delegate = moves.delegate === dg.dataset.mvDelegate ? null : dg.dataset.mvDelegate;
    return renderMoves();
  }
  const cp = event.target.closest("[data-delegate-copy]");
  if (cp) {
    const panel = cp.closest(".delegate-panel");
    const msg = panel.querySelector(".delegate-msg");
    navigator.clipboard?.writeText(panel.querySelector("#tp-text").value).then(
      () => { msg.textContent = "Copied."; },
      () => { msg.textContent = "The browser would not copy. Select the message and copy it by hand."; },
    );
    return;
  }
  const o = event.target.closest("[data-mv-open]");
  if (o) {
    const id = o.dataset.mvOpen;
    moves.open.has(id) ? moves.open.delete(id) : moves.open.add(id);
    return renderMoves();
  }
  const b = event.target.closest("[data-mv]");
  if (!b) return;
  const id = b.dataset.mvId;
  const act = b.dataset.mv;
  if (act === "more") { moves.more = !moves.more; return renderMoves(); }
  if (act === "add") { moves.adding = true; renderMoves(); return $("focus").querySelector("[data-mv-form] input")?.focus(); }
  if (act === "cancel") { moves.adding = false; return renderMoves(); }
  if (act === "pick") return movesChange({ pick: { id } });
  if (act === "start-new") return movesChange({ pick: { id }, start: true });
  if (act === "start") return movesChange({ start: id });
  if (act === "focus") {
    const on = Number(focusTimers()[id] ?? 0) > Date.now();
    setFocusTimer(id, on ? null : Date.now() + FOCUS_MIN * 60000);
    return renderMoves();
  }
  if (act === "copy") {
    const m = moves.data?.picks.find((p) => p.id === id);
    if (!m) return;
    navigator.clipboard?.writeText(kickoffNote(m, moveParts(m)).text).then(() => {
      moves.copied = id;
      renderMoves();
      setTimeout(() => { moves.copied = null; renderMoves(); }, 2000);
    }).catch(() => { moves.error = "Could not copy: the browser blocked the clipboard."; renderMoves(); });
    return;
  }
  if (act === "done") { moves.just = id; setFocusTimer(id, null); return movesChange({ done: id }); }
  if (act === "undo") return movesChange({ undo: id });
  if (act === "remove") return movesChange({ remove: id });
});

$("focus")?.addEventListener("change", (event) => {
  const id = event.target.dataset?.delegateTo;
  if (!id) return;
  const task = state.flagCtx?.tasks.get(String(id));
  const box = event.target.closest(".delegate-panel")?.querySelector("#tp-text");
  if (task && box) box.value = delegateText(task, event.target.value);
});

$("focus")?.addEventListener("submit", (event) => {
  const form = event.target.closest("[data-mv-form]");
  if (!form) return;
  event.preventDefault();
  const text = form.text.value.trim();
  const rockId = form.rockId.value;
  if (!text || !rockId) return;
  moves.adding = false;
  movesChange({ pick: { text, rockId }, start: !(event.submitter && "later" in event.submitter.dataset) });
});

// Pages that were folded into others: an old link or bookmark lands on the one that replaced it.
const MOVED_VIEWS = { update: "upsu", wins: "impact", tests: "readout" };

function showView(name) {
  name = MOVED_VIEWS[name] ?? name;
  for (const section of document.querySelectorAll(".view")) {
    section.classList.toggle("hidden", section.id !== `view-${name}`);
  }
  const group = groupOf(name);
  if (group) lastInGroup[group.id] = name;
  for (const button of document.querySelectorAll(".nav")) button.classList.toggle("active", button.dataset.view === name);
  for (const button of document.querySelectorAll("#tabs .tab")) {
    button.classList.toggle("active", button.dataset.group === group?.id);
    button.setAttribute("aria-selected", String(button.dataset.group === group?.id));
  }
  renderSubtabs(name);
  $("view-title").textContent = group ? "" : VIEW_TITLES[name] ?? name;
  $("view-title").hidden = Boolean(group);
  // Keep an existing deep-link target: showView is also called on boot from the hash,
  // and overwriting it there would drop the very test we were asked to open.
  if (parseHash(location.hash).name !== name) location.hash = name;
  closeDrawer();
  if ((name === "rocks" || name === "backlog") && !state.rocks) loadRocks();
  if (name === "setup" && !state.settings) loadSettings();
  if (name === "plan") loadPlan();
  if (name === "readout") loadMoves();
  if (name === "people") renderPeople();
  if (name === "ideation" && !ideation.loaded) loadIdeation();
  if (name === "impact" && !impact.loaded) loadImpact();
  if (name === "speech" && !speech.loaded) loadSpeech();
  if (name === "mystandup" && !mine.loaded) loadMine();
  if (name === "standup" && !standup.data && !standup.loading) loadStandup();
  if (name === "upsu") {
    if (!standup.data && !standup.loading) loadStandup();
    else renderUpsu();
  }
}

/* ------------------------------ page contents ------------------------------
   Jump links to the open page's sections, listed under its name in the drawer. Built
   each time the drawer opens, from the headings on the page as it is drawn right then,
   so it never lags a re-render. A section inside a closed <details> is opened before
   scrolling to it. */

const TOC_HEADINGS = "h2, h3, .su-head > strong, .test-name";
let tocTargets = [];

/* What needs you is long, so its contents are grouped by what you are there to do, with
   short names and a count where a count says something. Other pages list their headings. */
const TOC_GROUPS = {
  readout: [
    { label: "Start here", items: [["focus", "Today's moves", "Unblock others, then your work"], ["start-here", "Your queue", "Everything else, with filters"]] },
  ],
};
/** The badge beside a contents entry: a number and whether it is urgent, or null. */
function tocBadge(id) {
  if (id === "focus") {
    const waiting = unblockFlags().length + myReviewTickets().length;
    if (waiting) return { text: String(waiting), cls: "urgent" };
    const p = moves.data?.picks ?? [];
    return p.length ? { text: `${p.filter((x) => x.doneAt).length}/${p.length}`, cls: p.every((x) => x.doneAt) ? "good" : "" } : null;
  }
  if (id === "start-here") return queue.lines ? { text: String(queue.lines), cls: queue.p1 ? "urgent" : "" } : null;
  return null;
}

function buildToc() {
  document.getElementById("drawer-toc")?.remove();
  const view = document.querySelector(".view:not(.hidden)");
  if (!view) return;
  const name = view.id.replace(/^view-/, "");
  const home = $("toc-home");
  if (TOC_GROUPS[name]) {
    tocTargets = [];
    const groups = TOC_GROUPS[name]
      .map((g) => {
        const rows = g.items
          .map(([id, label, hint]) => {
            const el = $(id);
            if (!el || !el.getClientRects().length) return "";
            const i = tocTargets.push(el) - 1;
            const b = tocBadge(id);
            return `<button type="button" class="toc-link toc-item" data-toc="${i}" title="${esc(hint ?? label)}"><span class="toc-text"><span>${esc(label)}</span>${hint ? `<span class="toc-hint">${esc(hint)}</span>` : ""}</span>${b ? `<span class="toc-badge ${b.cls}">${esc(b.text)}</span>` : ""}</button>`;
          })
          .join("");
        return rows ? `<div class="toc-group"><p class="toc-group-label">${esc(g.label)}</p>${rows}</div>` : "";
      })
      .join("");
    if (!groups) return;
    const list = document.createElement("div");
    list.id = "drawer-toc";
    list.className = "toc-grouped";
    list.innerHTML = groups;
    home.append(list);
    markTocCurrent();
    return;
  }
  const pageName = String(groupOf(name)?.pages.find(([v]) => v === name)?.[1] ?? VIEW_TITLES[name] ?? name).toLowerCase();
  tocTargets = [...view.querySelectorAll(TOC_HEADINGS)].filter((el) => {
    const text = el.textContent.trim();
    // The page's own title repeats the nav entry above it, and hidden parts are not there to jump to.
    return text && text.toLowerCase() !== pageName && el.getClientRects().length > 0;
  });
  if (!tocTargets.length) return;
  const list = document.createElement("div");
  list.id = "drawer-toc";
  list.innerHTML = tocTargets
    .map((el, i) => {
      const text = el.textContent.trim().replace(/\s+/g, " ");
      const sub = el.tagName !== "H2" ? " toc-sub" : "";
      return `<button type="button" class="toc-link${sub}" data-toc="${i}" title="${esc(text)}">${esc(text)}</button>`;
    })
    .join("");
  list.insertAdjacentHTML("afterbegin", `<p class="drawer-label">On this page</p>`);
  home.append(list);
  markTocCurrent();
}

/* On a wide screen the drawer stays open beside the page, so its contents follow the page:
   rebuilt when the page redraws, and the section you are reading is highlighted. */
let tocRebuild = null;
new MutationObserver(() => {
  if (!drawerPinned.matches) return;
  clearTimeout(tocRebuild);
  tocRebuild = setTimeout(buildToc, 150);
}).observe(document.querySelector("main"), { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "open"] });
drawerPinned.addEventListener("change", () => {
  closeDrawer();
  if (drawerPinned.matches) buildToc();
});

function markTocCurrent() {
  let current = -1;
  tocTargets.forEach((el, i) => {
    if (el.isConnected && el.getBoundingClientRect().top < 90) current = i;
  });
  for (const link of document.querySelectorAll("#drawer-toc .toc-link")) {
    link.classList.toggle("current", Number(link.dataset.toc) === current);
  }
}
let tocScroll = false;
addEventListener("scroll", () => {
  if (tocScroll || !drawerPinned.matches) return;
  tocScroll = true;
  requestAnimationFrame(() => {
    tocScroll = false;
    markTocCurrent();
  });
}, { passive: true });

$("drawer").addEventListener("click", (event) => {
  const link = event.target.closest("[data-toc]");
  if (!link) return;
  const target = tocTargets[Number(link.dataset.toc)];
  if (!target?.isConnected) return;
  for (let node = target.parentElement; node; node = node.parentElement) {
    if (node.tagName === "DETAILS" && !target.closest("summary")) node.open = true;
  }
  closeDrawer();
  target.scrollIntoView({ behavior: "smooth", block: "start" });
});

function openDrawer() {
  buildToc();
  $("drawer").classList.add("open");
  $("drawer").setAttribute("aria-hidden", "false");
  $("menu-toggle").setAttribute("aria-expanded", "true");
  $("scrim").hidden = false;
}
function closeDrawer() {
  $("drawer").classList.remove("open");
  // Pinned open on a wide screen, so still there for a screen reader.
  $("drawer").setAttribute("aria-hidden", String(!drawerPinned.matches));
  $("menu-toggle").setAttribute("aria-expanded", "false");
  $("scrim").hidden = true;
}

document.addEventListener("click", (event) => {
  const menu = $("resources");
  if (menu?.open && !event.target.closest("#resources")) menu.open = false;
});
$("resources")?.addEventListener("click", (event) => {
  if (event.target.closest("a")) $("resources").open = false;
});
$("menu-toggle").addEventListener("click", () =>
  $("drawer").classList.contains("open") ? closeDrawer() : openDrawer(),
);
$("scrim").addEventListener("click", closeDrawer);
for (const button of document.querySelectorAll(".nav")) {
  button.addEventListener("click", () => showView(button.dataset.view));
}
for (const button of document.querySelectorAll("#tabs .tab")) {
  button.addEventListener("click", () => {
    const group = NAV_GROUPS.find((g) => g.id === button.dataset.group);
    showView(lastInGroup[group.id] ?? group.pages[0][0]);
  });
}
$("subtabs").addEventListener("click", (event) => {
  const button = event.target.closest(".subtab");
  if (button) showView(button.dataset.view);
});
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
  if (name === "rocks" && target) focusRock(target);
  if (name === "plan" && target) {
    plan.focus = target;
    renderPlan();
  }
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

// The dashboard. Reads the same storage the 8 AM readout is built from, and can trigger
// the same pipeline on demand.
//
// The refresh path polls rather than awaits: a background function returns 202 straight
// away and the caller cannot wait for its result.

const $ = (id) => document.getElementById(id);
const layerLabel = (layer) => (layer === "cross" ? "CROSS" : layer === 0 ? "STORE" : `L${layer}`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const FN = "/.netlify/functions";
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

  if (body.empty) {
    $("banners").innerHTML = `<div class="note"><strong>Nothing yet.</strong> ${esc(body.message)}</div>`;
    renderOpenItems();
    return;
  }
  state.report = body.report;
  render();
}

/* --------------------------------- render --------------------------------- */

function render() {
  const report = state.report;
  const s = report.summary;

  $("chip-mode").textContent = report.mode === "official" ? "8 AM readout" : "refreshed";
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
    tile(s.p1, "P1"),
    tile(s.attention, "Attention"),
    tile(s.prompt, "Owner prompts"),
    tile(report.sections.clickup?.counts?.inProgress ?? "—", "In progress"),
    tile(report.sections.clickup?.counts?.stalled ?? "—", "Stalled"),
    tile(report.sections.intelligems?.counts?.running ?? "—", "Tests running"),
  ].join("");

  const flags = report.flags ?? [];
  renderFlags($("attention"), flags.filter((f) => f.severity === "p1" || f.severity === "attention"), "Nothing flagged.");
  renderFlags($("prompts"), flags.filter((f) => f.severity === "prompt"), "No quiet tests waiting on an owner.");
  renderFlags($("hygiene"), flags.filter((f) => f.severity === "info"), "Nothing outstanding.");

  renderStoreMetrics(report);
  renderFunnel(report);
  renderLayer1(report);
  renderCross(report);
  renderLayer2(report);
  renderTests();
  renderOpenItems();
  $("report-text").textContent = report.text ?? "";
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

function renderStoreMetrics(report) {
  const section = report.sections?.shopify;
  const data = report.detail?.shopify;
  const host = $("store-metrics");

  if (!section?.present) {
    host.innerHTML = `<div class="note"><strong>Store metrics unavailable.</strong> ${esc(section?.reason ?? "not collected")}</div>`;
    return;
  }

  host.innerHTML = (data?.tiles ?? [])
    .map((t) => {
      if (!t.available) {
        return `<div class="metric"><div class="metric-label">${esc(t.label)}</div><div class="metric-value muted">—</div><div class="metric-delta">${esc(t.reason ?? "unavailable")}</div></div>`;
      }

      // A rate is shown to the cent; a large total does not need the cents.
      const precise = t.kind === "rate" && t.format === "money";

      const cmps = (t.comparisons ?? [])
        .map((c) => {
          if (c.changePct == null) return `<span class="cmp">${esc(c.label)} —</span>`;
          const up = c.changePct > 0;
          // Direction is not the same as good. Discounts are stored negative, so a rise
          // means less discounting, which is why goodDirection lives on the tile.
          const good = t.goodDirection === "down" ? !up : up;
          return `<span class="cmp ${good ? "good" : "bad"}" title="${esc(c.label)} value ${esc(formatMetric(c.value, t.format, { precise }))}${c.basis === "per day" ? ", compared per day" : ""}">${esc(c.label)} ${up ? "+" : ""}${esc(c.changePct)}%${c.basis === "per day" ? "<span class=\"basis\">/d</span>" : ""}</span>`;
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
        ? `<button class="info" data-detail="${esc(detail)}" data-title="${esc(t.label)}" aria-label="What is ${esc(t.label)}?">i</button>`
        : "";

      return `<div class="metric">
        <div class="metric-label">${esc(t.label)}${info}</div>
        <div class="metric-value">${esc(formatMetric(t.value, t.format, { precise }))}</div>
        <div class="metric-cmps">${cmps}</div>
      </div>`;
    })
    .join("");

  const win = data?.primaryWindow;
  const others = (data?.windows ?? []).filter((w) => w.key !== win?.key).map((w) => w.label).join(" and ");
  $("store-sub").innerHTML =
    `${esc(data?.shopDomain ?? "")} · showing <strong>${esc(win?.label ?? "")}</strong>${win?.days ? ` (${esc(win.days)} days elapsed)` : ""} against ${esc(others)}. ` +
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

  const rows = (f.steps ?? [])
    .map((step, index) => {
      const width = step.ofTop == null ? 0 : Math.max(step.ofTop * 100, 0.4);
      const cmps = (step.comparisons ?? [])
        .map((c) => {
          if (c.changePct == null) return `<span class="cmp">${esc(c.label)} —</span>`;
          const good = c.changePct > 0; // a higher step rate is always better
          return `<span class="cmp ${good ? "good" : "bad"}" title="${esc(c.label)} step rate ${esc(pct(c.ofPrevious))}">${esc(c.label)} ${c.changePct > 0 ? "+" : ""}${esc(c.changePct)}%</span>`;
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
            : `<span class="funnel-step">${esc(pct(step.ofPrevious))} of ${esc(f.steps[index - 1].label.toLowerCase())}</span>
               <span class="funnel-lost">${esc(pct(lost))} lost</span>`}
          <span class="funnel-oftop">${esc(pct(step.ofTop, 2))} of sessions</span>
          ${cmps}
        </div>
      </div>`;
    })
    .join("");

  host.innerHTML = `
    <h3 class="funnel-title">${esc(f.label)} <span class="meta">${esc(f.window.label)} · comparisons are on the step rate, not the count</span></h3>
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
  container.innerHTML = flags
    .map(
      (flag) => `
      <div class="flag ${esc(flag.severity)}" data-flag="${esc(flag.id)}">
        <div class="row">
          <div>
            <p class="msg">${esc(flag.message)}</p>
            <p class="meta">${esc(layerLabel(flag.layer))} · ${esc(flag.rule)}</p>
          </div>
          ${flag.advisable ? `<button class="ghost advise" data-flag="${esc(flag.id)}">${esc(state.advisorButtonText)}</button>` : ""}
        </div>
        <div class="advice hidden"></div>
      </div>`,
    )
    .join("");
}

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
    return;
  }
  const rows = (detail.people ?? [])
    .map(
      (person) => `<tr>
        <td>${esc(person.name)}</td>
        <td>${person.distinctBigSwings === 1 ? "1" : `<strong>${esc(person.distinctBigSwings)}</strong>`}</td>
        <td>${esc(person.bauTickets.length)}</td>
        <td>${esc(person.unrelatedTickets.length)}</td>
        <td>${esc(person.totalTickets)}</td>
      </tr>`,
    )
    .join("");
  $("cross").innerHTML = `
    <p class="sub">Every person's sprint should carry one big swing tied to a live leadership priority. Business as usual is expected; it just should not crowd the big swing out.</p>
    <div class="scroll"><table>
      <thead><tr><th>Person</th><th>Big swings</th><th>BAU</th><th>Unrelated</th><th>Tickets</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">Nobody on the roster.</td></tr>'}</tbody>
    </table></div>`;
}

function renderLayer2(report) {
  const section = report.sections.clickup;
  const delta = report.detail?.clickup;
  if (!section?.present) {
    $("layer2").innerHTML = `<div class="missing">Missing. ${esc(section?.reason ?? "not collected")}</div>`;
    return;
  }
  const c = delta.counts;
  const taskRows = (tasks) =>
    tasks
      .map(
        (task) => `<tr>
          <td><span class="sig ${esc(task.signal)}">${esc(task.signal)}</span></td>
          <td class="wrap">${task.url ? `<a href="${esc(task.url)}" target="_blank" rel="noreferrer">${esc(task.name)}</a>` : esc(task.name)}</td>
          <td>${esc(task.status)}</td>
          <td>${esc(task.taskOwners.map((u) => u.username).join(", ") || "no owner")}</td>
          <td>${esc(task.assignees.map((u) => u.username).join(", ") || "unassigned")}</td>
          <td>${esc(task.leadershipPriority?.label ?? "none")}</td>
          <td>${task.idleDays == null ? "—" : `${esc(task.idleDays)}d`}</td>
        </tr>`,
      )
      .join("");

  const head = `<thead><tr><th>Signal</th><th>Task</th><th>Status</th><th>Owner</th><th>Assignees</th><th>Leadership priority</th><th>Untouched</th></tr></thead>`;

  const ch = delta.changes;
  const changeLines = [
    ...ch.statusChanges.map((t) => `status · ${esc(t.name)}: ${esc(t.from)} → ${esc(t.to)}`),
    ...ch.assigneeChanges.map((t) => `assignee · ${esc(t.name)}: ${esc(t.from)} → ${esc(t.to)}`),
    ...ch.ownerChanges.map((t) => `owner · ${esc(t.name)}: ${esc(t.from)} → ${esc(t.to)}`),
    ...ch.priorityChanges.map((t) => `priority · ${esc(t.name)}: ${esc(t.from)} → ${esc(t.to)}`),
    ...ch.newComments.map(
      (t) => `comment · ${esc(t.name)}: +${esc(t.added)}${t.latest?.user ? ` by ${esc(t.latest.user)}` : ""}${t.latest?.text ? ` — "${esc(t.latest.text.slice(0, 140))}"` : ""}`,
    ),
    ...ch.newTasks.map((t) => `new · ${esc(t.name)} (${esc(t.status)})`),
    ...ch.disappeared.map((t) => `gone · ${esc(t.name)} (was ${esc(t.status)})`),
  ];

  $("layer2").innerHTML = `
    <p class="sub">${c.total} tasks. ${c.notStarted} not started, ${c.inProgress} in progress, ${c.done} done. ${c.stalled} stalled, ${c.changed} changed since the baseline.</p>
    ${delta.hasBaseline ? "" : `<div class="note"><strong>First run.</strong> There is no previous snapshot, so there is no day over day comparison yet.</div>`}
    <h3>In progress</h3>
    <div class="scroll"><table>${head}<tbody>${taskRows(delta.boards.inProgress) || '<tr><td colspan="7">Nothing in progress.</td></tr>'}</tbody></table></div>
    <h3>Not started</h3>
    <div class="scroll"><table>${head}<tbody>${taskRows(delta.boards.notStarted) || '<tr><td colspan="7">Nothing not started.</td></tr>'}</tbody></table></div>
    <h3>Day over day</h3>
    ${changeLines.length ? `<ul>${changeLines.map((l) => `<li>${l}</li>`).join("")}</ul>` : '<p class="sub">No changes since the baseline.</p>'}`;
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
        <button class="ghost" data-node="${esc(key)}">Project ${esc(fv?.horizonMonths ?? 6)} month value</button>
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
        <span class="meta">subscriber ${esc(money(fv.subscriptionLtv))} · one-time ${esc(money(fv.oneTimeLtv))}</span>
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

  return `<div class="test-card">
      <button class="test-head" data-node="${esc(openKey)}">
        <span class="caret ${open ? "open" : ""}">▸</span>
        <span class="test-name">${esc(test.name)}</span>
        <span class="chip ${test.recommendation.recommendation === "Kill" ? "bad" : test.recommendation.recommendation === "Ship" ? "good" : ""}">${esc(test.recommendation.recommendation)}</span>
        ${headlineChip}
        <span class="meta">${esc(test.daysRunning ?? "?")}d · ${esc(test.minOrdersPerGroup ?? "?")} orders${gate ? ` · ${esc(gate)}` : ""}</span>
      </button>
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

  host.innerHTML = `<p class="sub">${esc(c.running)} running · ${esc(c.readyForVerdict)} past the readiness gate · ${esc(c.notable)} moved · ${esc(c.quiet)} quiet</p>
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
    renderRocks();
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
    if (!r.clickupOptionId && !r.clickupBigSwingOptionId) out.push("not linked to ClickUp");
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
          ${(r.experimentLinks ?? []).map((l, i) => `<a href="${esc(l.url)}" target="_blank" rel="noreferrer">${esc(l.label || `experiment ${i + 1}`)}</a>`).join("")}
          ${r.websiteUrl ? `<a href="${esc(r.websiteUrl)}" target="_blank" rel="noreferrer">site</a>` : ""}
          ${(r.reportLinks ?? []).map((l, i) => `<a href="${esc(l.url)}" target="_blank" rel="noreferrer">${esc(l.label || `report ${i + 1}`)}</a>`).join("")}
        </span>
      </span>
      <span class="rock-row-gaps">${gaps(r).map((g) => `<span class="chip warn">${esc(g)}</span>`).join("")}</span>
    </button>`;

  $("rocks-list").innerHTML = `
    ${data.clickupOptions?.available === false ? `<div class="note"><strong>ClickUp link unavailable.</strong> ${esc(data.clickupOptions.reason ?? "")}</div>` : ""}
    ${rocks.map(card).join("") || `<p class="sub">${(data.rocks ?? []).length ? "No rocks match that filter." : "No rocks yet. Use New rock to add the first."}</p>`}
    <p class="sub">${rocks.length} of ${(data.rocks ?? []).length} shown · version ${esc(data.version)}${data.updatedAt ? ` · last changed ${new Date(data.updatedAt).toLocaleString()}` : ""}</p>`;
}

/* ------------------------------- rock editor ------------------------------- */

let editingId = null;

function openRock(id) {
  const data = state.rocks;
  const r = id ? (data.rocks ?? []).find((x) => x.id === id) : null;
  editingId = r?.id ?? null;
  $("rock-modal-title").textContent = r ? "Edit rock" : "New rock";
  $("rock-delete").classList.toggle("hidden", !r);
  $("rock-form-error").classList.add("hidden");

  const opts = (list, selected, blank) =>
    (blank == null ? [] : [`<option value="">${esc(blank)}</option>`])
      .concat(list.map((o) => `<option value="${esc(o.id)}"${String(selected ?? "") === String(o.id) ? " selected" : ""}>${esc(o.label)}</option>`))
      .join("");

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
      <label>Check-in date<input class="rk" type="date" data-f="checkInDate" value="${esc(r?.checkInDate ?? "")}"></label>
      <label>Shipped<input class="rk" type="date" data-f="shippedAt" value="${esc(r?.shippedAt ?? "")}"></label>
      <label>Big Swing${
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
      <div class="flag ${t.gateMet ? "" : "prompt"}">
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
  const button = event.target.closest("button.info");
  document.querySelectorAll(".info-pop").forEach((n) => n.remove());
  if (!button) return;
  event.stopPropagation();

  const pop = document.createElement("div");
  pop.className = "info-pop";
  pop.innerHTML = `<strong>${esc(button.dataset.title)}</strong><p>${esc(button.dataset.detail).replace(/\n\n/g, "</p><p>")}</p>`;
  button.closest(".metric").appendChild(pop);
});

$("new-rock-btn").addEventListener("click", () => openRock(null));
$("rock-close").addEventListener("click", closeRock);
$("rock-save").addEventListener("click", saveRock);
$("rock-delete").addEventListener("click", deleteRock);
$("rock-modal").addEventListener("click", (e) => { if (e.target.id === "rock-modal") closeRock(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("rock-modal").hidden) closeRock(); });
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

/* ----------------------------------- nav ----------------------------------- */

const VIEW_TITLES = { readout: "Readout", rocks: "Rocks", sprint: "Sprint", tests: "Tests", setup: "Setup" };

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
      const step = spec.type === "money" ? "0.01" : spec.type === "probability" ? "0.01" : "1";
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

function showView(name) {
  for (const section of document.querySelectorAll(".view")) {
    section.classList.toggle("hidden", section.id !== `view-${name}`);
  }
  for (const button of document.querySelectorAll(".nav")) {
    button.classList.toggle("active", button.dataset.view === name);
  }
  $("view-title").textContent = VIEW_TITLES[name] ?? name;
  location.hash = name;
  closeDrawer();
  if (name === "rocks" && !state.rocks) loadRocks();
  if (name === "setup" && !state.settings) loadSettings();
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
for (const button of document.querySelectorAll(".nav")) {
  button.addEventListener("click", () => showView(button.dataset.view));
}
showView((location.hash || "#readout").slice(1));

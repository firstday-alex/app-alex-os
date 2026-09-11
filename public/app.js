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
let state = { report: null, openItems: [], advisorButtonText: "Ask for recommendation", rocks: null };

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
  renderLayer3(report);
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

function renderLayer3(report) {
  const section = report.sections.intelligems;
  const delta = report.detail?.intelligems;
  if (!section?.present) {
    $("layer3").innerHTML = `<div class="missing">Missing. ${esc(section?.reason ?? "not collected")}</div>`;
    return;
  }
  const c = delta.counts;

  const cards = (delta.tests ?? [])
    .map((test) => {
      const groupRows = (test.groups ?? [])
        .map((group) => {
          const metrics = Object.values(group.metrics ?? {})
            .map((m) => {
              const value = m.value == null ? "not configured" : Number(m.value).toFixed(3);
              const uplift = m.upliftPct == null ? "" : ` (${m.upliftPct > 0 ? "+" : ""}${Number(m.upliftPct).toFixed(1)}%)`;
              return `${esc(m.name)} ${esc(value)}${esc(uplift)}`;
            })
            .join(" · ");
          return `<tr><td>${esc(group.name)}${group.isControl ? " (control)" : ""}</td><td>${esc(group.orders ?? "—")}</td><td class="wrap">${metrics}</td></tr>`;
        })
        .join("");

      const trades = (test.tradeOffs ?? [])
        .filter((t) => t.conflict)
        .map(
          (t) =>
            `<div class="note"><strong>Trade off on ${esc(t.groupName)}.</strong> Wins on ${esc(t.wins.map((w) => w.metric).join(", "))} against losses on ${esc(t.losses.map((l) => l.metric).join(", "))}. ${
              t.futureValue?.configured === false
                ? "Six month value: not configured."
                : `Six month value spread, subscription over one time: ${esc(Number(t.futureValue.spread).toFixed(2))}.`
            }</div>`,
        )
        .join("");

      return `
        <h3>${esc(test.name)} — ${esc(test.recommendation.recommendation)}</h3>
        <p class="sub">${esc(test.recommendation.reason)} ${test.daysRunning ?? "?"} days, ${test.minOrdersPerGroup ?? "?"} orders in the smallest group. Platform verdict: ${esc(test.verdict ?? "none")}.</p>
        ${trades}
        <div class="scroll"><table>
          <thead><tr><th>Group</th><th>Orders</th><th>Metrics</th></tr></thead>
          <tbody>${groupRows || '<tr><td colspan="3">No groups returned.</td></tr>'}</tbody>
        </table></div>`;
    })
    .join("");

  const ended = (delta.ended ?? [])
    .map((t) => `<li>${esc(t.name)} ended. Final verdict ${esc(t.finalVerdict ?? "none recorded")}.</li>`)
    .join("");

  $("layer3").innerHTML = `
    <p class="sub">${c.running} running. ${c.notable} moved, ${c.quiet} quiet, ${c.readyForVerdict} past the readiness gate, ${c.ended} ended.</p>
    ${delta.hasBaseline ? "" : `<div class="note"><strong>First run.</strong> No previous snapshot, so no day over day comparison on results yet.</div>`}
    ${cards || '<p class="sub">No tests running.</p>'}
    ${ended ? `<h3>Ended</h3><ul>${ended}</ul>` : ""}`;
}

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

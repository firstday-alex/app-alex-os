// The dashboard. Reads the same storage the 8 AM readout is built from, and can trigger
// the same pipeline on demand.
//
// The refresh path polls rather than awaits: a background function returns 202 straight
// away and the caller cannot wait for its result.

const $ = (id) => document.getElementById(id);
const layerLabel = (layer) => (layer === "cross" ? "CROSS" : `L${layer}`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const FN = "/.netlify/functions";
let state = { report: null, openItems: [], advisorButtonText: "Ask for recommendation" };

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
    $("app").classList.remove("hidden");
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
    $("app").classList.add("hidden");
    $("login").classList.remove("hidden");
    return;
  }
  // A valid cookie from an earlier visit means we can skip the sign-in screen.
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");

  const body = await response.json();
  state.openItems = body.openItems ?? [];
  state.advisorButtonText = body.advisorButtonText ?? state.advisorButtonText;

  if (body.empty) {
    $("strap").textContent = body.message;
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

  $("strap").textContent = `${s.p1} P1, ${s.attention} needing attention, ${s.prompt} owner prompt(s), ${s.info} hygiene note(s).`;
  $("chip-mode").textContent = report.mode === "official" ? "8 AM official readout" : "On demand refresh";
  $("chip-baseline").textContent = `Baseline ${report.baseline.describe}`;
  $("chip-generated").textContent = `Pulled ${new Date(report.generatedAt).toLocaleString()}`;

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

  renderLayer1(report);
  renderCross(report);
  renderLayer2(report);
  renderLayer3(report);
  renderOpenItems();
  $("report-text").textContent = report.text ?? "";
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
      $("strap").textContent = body.reason ?? "Refresh did not start.";
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

$("toggle-text").addEventListener("click", () => {
  $("text-view").classList.toggle("hidden");
});

// Already signed in from a previous visit? The cookie will tell us.
load();
